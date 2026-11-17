import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Activity, Pause, Play, X } from "lucide-react";
import { acquireSpeechSession, releaseSpeechSession, SpeechBuffer, SpeechTask } from "./speechBuffer";
import { settingsStorage } from "@/utils/globalSettings";
import { readSpeechPreferences, speechPreferencesKey } from "@/utils/speechPreferences";
import { listSpeechMicrophones, openSpeechMicrophone, resumeSpeechAudio, speechStartupError } from "@/utils/speechMicrophone";

let nextSpeechSession = 1;

function textFingerprint(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

type Props = { onInsert: (text: string, requestId: string) => void | Promise<void>; onClose: () => void; finishOnClose?: boolean };
type Runtime = { backend: "cpu"; device: string; threads: number; reason: string | null };

function trimTrailingSilence(samples: Float32Array): Float32Array {
  const frameLength = 160;
  let end = samples.length;
  while (end - frameLength >= 1600) {
    let energy = 0;
    for (let index = end - frameLength; index < end; index++) energy += samples[index] ** 2;
    if (Math.sqrt(energy / frameLength) >= 0.01) break;
    end -= frameLength;
  }
  return end === samples.length ? samples : samples.slice(0, end);
}

export function SpeechToText({ onInsert, onClose, finishOnClose = false }: Props) {
  const [initialPreferences] = useState(readSpeechPreferences);
  const [sessionId] = useState(() => `speech-${Date.now()}-${nextSpeechSession++}`);
  const [status, setStatus] = useState("正在准备识别引擎…");
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(true);
  const [startAttempt, setStartAttempt] = useState(0);
  const [startupFailed, setStartupFailed] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState(0);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [inputDeviceId, setInputDeviceId] = useState(initialPreferences.inputDeviceId);
  const [microphoneLabel, setMicrophoneLabel] = useState("");
  const streamRef = useRef<MediaStream | null>(null);
  const ownsSpeechSession = useRef(false);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const captureTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const buffer = useRef(new SpeechBuffer());
  const task = useRef(new SpeechTask());
  const silence = useRef(0);
  const hasSpeech = useRef(false);
  const pausedRef = useRef(false);
  const stopped = useRef(false);
  const preparingRef = useRef(true);
  const finishingRef = useRef(false);
  const stoppingRef = useRef(false);
  const failedRef = useRef(false);
  const retrySamples = useRef<Float32Array | null>(null);
  const lastInsertedText = useRef("");
  const lastInsertedAt = useRef(0);
  const flushRequested = useRef(false);
  const nextFlushId = useRef(1);
  const config = useRef(initialPreferences);
  const insertRef = useRef(onInsert);
  insertRef.current = onInsert;

  useEffect(() => {
    if (!isTauri()) return;
    void invoke("stt_shortcut_register").catch(error => {
      console.warn("Cannot register wired speech shortcut:", error);
    });
    return () => {
      void invoke("stt_shortcut_unregister").catch(error => {
        console.warn("Cannot unregister wired speech shortcut:", error);
      });
    };
  }, []);

  const flush = (reason = "unspecified") => {
    if (stopped.current || finishingRef.current) return Promise.resolve();
    const flushId = nextFlushId.current++;
    console.info("[speech] flush-request", { sessionId, flushId, reason, bufferedSamples: buffer.current.length, retrySamples: retrySamples.current?.length ?? 0, paused: pausedRef.current });
    flushRequested.current = true;
    return task.current.run(async () => {
      setBusy(true);
      try {
        while (!stopped.current && !finishingRef.current && (retrySamples.current || buffer.current.length) && flushRequested.current) {
          flushRequested.current = false;
          const samples = trimTrailingSilence(retrySamples.current ?? buffer.current.take());
          retrySamples.current = null;
          console.info("[speech] segment", { sessionId, flushId, samples: samples.length, seconds: Number((samples.length / 16000).toFixed(2)) });
          if (samples.length / 16000 < config.current.minDurationSeconds) continue;
          setStatus("正在识别…");
          let text: string;
          try {
            const requestId = `${sessionId}-${flushId}`;
            console.info("[speech] recognize-start", { sessionId, flushId, requestId, samples: samples.length, model: config.current.model });
            const result = await invoke<{ text: string; runtime: Runtime }>("stt_transcribe", {
              ...config.current, samples: Array.from(samples), requestId,
            });
            text = result.text;
            console.info("[speech] recognize-result", { sessionId, flushId, requestId, textLength: text.length, textHash: textFingerprint(text), runtime: result.runtime });
          } catch (error) {
            retrySamples.current = samples;
            throw error;
          }
          if (stopped.current) return;
          const recognizedText = text.trim();
          const isLongEnough = [...recognizedText].length >= config.current.minTextLength;
          const isRecentDuplicate = recognizedText.toLowerCase() === lastInsertedText.current.toLowerCase()
            && Date.now() - lastInsertedAt.current < 2500;
          console.info("[speech] insert-decision", { sessionId, flushId, textLength: recognizedText.length, textHash: textFingerprint(recognizedText), isLongEnough, isRecentDuplicate });
          if (isLongEnough && !isRecentDuplicate) {
            try {
              await insertRef.current(recognizedText + " ", `${sessionId}-${flushId}`);
            } catch (error) {
              console.error("[speech] insert-failed", { sessionId, flushId, error: String(error) });
              throw error;
            }
            console.info("[speech] insert-complete", { sessionId, flushId, textLength: recognizedText.length, textHash: textFingerprint(recognizedText) });
            lastInsertedText.current = recognizedText;
            lastInsertedAt.current = Date.now();
          } else if (!isLongEnough) {
            lastInsertedText.current = "";
            lastInsertedAt.current = 0;
          }
          failedRef.current = false;
          setStatus(pausedRef.current ? "已暂停" : "正在监听，请继续说话");
          if (pausedRef.current || buffer.current.length >= SpeechBuffer.segmentLength) {
            flushRequested.current = true;
          }
        }
      } catch (error) {
        if (!stopped.current && !finishingRef.current) {
          failedRef.current = true;
          pausedRef.current = true;
          setPaused(true);
          setStatus(`语音输入失败，已暂停：${String(error)}`);
        }
      } finally {
        if (!stopped.current) setBusy(false);
      }
    });
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const releaseMicrophone = () => {
    if (captureTimerRef.current !== null) clearInterval(captureTimerRef.current);
    captureTimerRef.current = null;
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      processorRef.current.disconnect();
    }
    processorRef.current = null;
    setLevel(0);
    if (contextRef.current && contextRef.current.state !== "closed") void contextRef.current.close();
    contextRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  };
  const cleanup = () => {
    stopped.current = true;
    releaseMicrophone();
    buffer.current.clear();
    retrySamples.current = null;
    if (ownsSpeechSession.current) {
      ownsSpeechSession.current = false;
      void invoke("stt_cancel").catch(() => {});
    }
  };

  useEffect(() => {
    let alive = true;
    stopped.current = false;
    if (!acquireSpeechSession(sessionId)) {
      setStatus("语音识别已在其他面板中运行");
      setPreparing(false);
      return () => { alive = false; };
    }
    ownsSpeechSession.current = true;
    preparingRef.current = true;
    pausedRef.current = false;
    setPreparing(true);
    setPaused(false);
    setStartupFailed(false);
    hasSpeech.current = false;
    silence.current = 0;
    setStatus("正在准备识别引擎…");
    const start = async () => {
      try {
        // 在首次异步操作前启动音频上下文，保留点击操作提供的播放授权。
        const context = new AudioContext();
        contextRef.current = context;
        await resumeSpeechAudio(context);
        if (!alive) return;
        const ready = await invoke<{ ready: boolean }>("stt_model_status", { model: config.current.model });
        if (!alive) return;
        if (!ready.ready) {
          setStatus("正在准备 SenseVoice 模型和词表…");
          await invoke("stt_download_model", { model: config.current.model });
        }
        if (!alive) return;
        setStatus("正在初始化识别引擎…");
        await invoke<Runtime>("stt_prepare", config.current);
        if (!alive) return;
        setStatus("正在启动麦克风…");
        const stream = await openSpeechMicrophone(config.current.inputDeviceId);
        if (!alive) { stream.getTracks().forEach(track => track.stop()); return; }
        streamRef.current = stream;
        setMicrophoneLabel(stream.getAudioTracks()[0]?.label || "系统默认输入设备");
        void listSpeechMicrophones().then(devices => {
          if (alive) setMicrophones(devices);
        }).catch(error => console.warn("Cannot list microphones:", error));
        await resumeSpeechAudio(context);
        if (!alive) return;
        const source = context.createMediaStreamSource(stream);
        let lastFrameAt = Date.now();
        let lastVoiceAt = Date.now();
        let peak = 0;
        let receivedAudio = false;
        const captureFailed = (message: string) => {
          if (!alive || stoppingRef.current) return;
          releaseMicrophone();
          pausedRef.current = true;
          setPaused(true);
          setStartupFailed(true);
          setStatus(message);
        };
        const processor = context.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;
        source.connect(processor);
        const silent = context.createGain();
        silent.gain.value = 0;
        processor.connect(silent);
        silent.connect(context.destination);
        processor.onaudioprocess = event => {
          if (!alive) return;
          lastFrameAt = Date.now();
          if (pausedRef.current || preparingRef.current || finishingRef.current) { setLevel(0); return; }
          const input = event.inputBuffer.getChannelData(0);
          const ratio = context.sampleRate / 16000;
          const data = new Float32Array(Math.floor(input.length / ratio));
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const start = Math.floor(i * ratio);
            const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
            let value = 0;
            for (let j = start; j < end; j++) value += input[j];
            data[i] = value / (end - start);
            sum += data[i] ** 2;
          }
          const rms = Math.sqrt(sum / Math.max(1, data.length));
          setLevel(Math.min(1, rms * 8));
          peak = Math.max(peak, rms);
          const voiced = rms >= config.current.minVolume;
          if (!receivedAudio || voiced) {
            receivedAudio = true;
            if (!task.current.isRunning) setStatus(voiced ? "检测到语音，停顿后开始识别" : "正在监听，请开始说话");
          }
          if (voiced) {
            lastVoiceAt = Date.now();
            hasSpeech.current = true;
            silence.current = 0;
          } else silence.current += data.length / 16000;
          if (!hasSpeech.current) return;
          if (!buffer.current.append(data)) {
            pausedRef.current = true;
            setPaused(true);
            setStatus("识别速度较慢，录音已自动暂停；处理完成后可继续");
            void flushRef.current("buffer-capacity");
            return;
          }
          if (silence.current > 1.35 || buffer.current.length >= SpeechBuffer.segmentLength) {
            if (silence.current > 1.35) hasSpeech.current = false;
            void flushRef.current(silence.current > 1.35 ? "silence" : "segment-limit");
          }
        };
        captureTimerRef.current = setInterval(() => {
          if (!alive || pausedRef.current || stoppingRef.current) return;
          const track = stream.getAudioTracks()[0];
          if (!track || track.readyState === "ended") {
            captureFailed("麦克风已断开，请检查 Windows 输入设备后重试。");
          } else if (context.state !== "running" || Date.now() - lastFrameAt > 5000) {
            captureFailed("未收到麦克风音频，音频采集已中断，请检查输入设备后重试。");
          } else if (!hasSpeech.current && !task.current.isRunning && Date.now() - lastVoiceAt > 5000) {
            setStatus(track.muted || peak < 0.00001
              ? "未检测到麦克风声音，请在下方切换麦克风，并检查设备静音和输入音量。"
              : "声音低于识别阈值，请靠近麦克风或在语音设置中调低最低音量。");
            peak = 0;
          }
        }, 1000);
        setStatus("正在等待麦克风音频…");
      } catch (error) {
        if (alive) {
          releaseMicrophone();
          pausedRef.current = true;
          setPaused(true);
          setStartupFailed(true);
          console.error("[speech] startup-failed", error);
          setStatus(speechStartupError(error));
        }
      } finally {
        if (alive) { preparingRef.current = false; setPreparing(false); }
      }
    };
    void start();
    const refreshDevices = () => {
      void listSpeechMicrophones().then(devices => {
        if (alive) setMicrophones(devices);
      }).catch(error => console.warn("Cannot list microphones:", error));
    };
    refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
      cleanup();
      releaseSpeechSession(sessionId);
    };
  }, [sessionId, startAttempt]);

  const stop = async () => {
    if (stoppingRef.current || stopped.current) return;
    stoppingRef.current = true;
    setIsStopping(true);
    if (finishOnClose && !preparingRef.current && !failedRef.current) {
      // 先停止采集并提交尾段，避免快捷键结束时丢失尚未遇到停顿的语音。
      pausedRef.current = true;
      releaseMicrophone();
      releaseSpeechSession(sessionId);
      setFinishing(true);
      await flushRef.current("finish-on-close");
      if (failedRef.current) {
        stoppingRef.current = false;
        setIsStopping(false);
        setFinishing(false);
        return;
      }
    }
    finishingRef.current = true;
    stopped.current = true;
    setIsStopping(true);
    setFinishing(true);
    failedRef.current = false;
    releaseMicrophone();
    flushRequested.current = false;
    buffer.current.clear();
    retrySamples.current = null;
    void invoke("stt_cancel").catch(() => {});
    cleanup();
    releaseSpeechSession(sessionId);
    onClose();
  };

  useEffect(() => {
    const close = () => { void stop(); };
    const togglePauseFromRemote = () => togglePause();
    const showError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      if (detail?.message) setStatus(detail.message);
    };
    window.addEventListener("nexusdesk-speech-close", close);
    window.addEventListener("nexusdesk-speech-pause-toggle", togglePauseFromRemote);
    window.addEventListener("nexusdesk-speech-error", showError);
    return () => {
      window.removeEventListener("nexusdesk-speech-close", close);
      window.removeEventListener("nexusdesk-speech-pause-toggle", togglePauseFromRemote);
      window.removeEventListener("nexusdesk-speech-error", showError);
    };
  }, []);
  const togglePause = () => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    setStatus(pausedRef.current ? "已暂停" : "正在监听，请开始说话");
    if (pausedRef.current || retrySamples.current) void flush(pausedRef.current ? "manual-pause" : "retry");
  };
  return createPortal(<div className="stt-floating" role="region" aria-label="语音转文字">
    <div className="stt-top">
      <div className="stt-indicator" style={{ boxShadow: `0 0 ${8 + level * 24}px rgba(76,175,130,${.2 + level * .65})` }}><Activity size={16} /></div>
      <div className="stt-status"><strong>{finishing ? "正在完成" : busy ? "正在处理" : paused ? "已暂停" : "语音转文字"}</strong><span title={status} role="status">{status}</span></div>
      <button title="关闭" aria-label="关闭" disabled={isStopping} onClick={() => void stop()}><X size={17} /></button>
    </div>
    <div className={`stt-waveform ${paused || preparing ? "is-idle" : ""}`} role="img" aria-label={`麦克风音量 ${Math.round(level * 100)}%`}>
      {Array.from({ length: 25 }, (_, i) => { const shape = Math.abs(Math.sin(i * .67) * Math.cos(i * .19)); return <span key={i} style={{ height: 4 + shape * (5 + level * 24), opacity: .35 + shape * .65 }} />; })}
    </div>
    <label className="flex min-w-0 items-center gap-2 text-xs text-gray-400">麦克风
      <select className="min-w-0 flex-1 rounded border border-ide-panel-border bg-ide-bg px-2 py-1 outline-none focus:border-ide-accent" aria-label="输入麦克风" value={inputDeviceId} disabled={preparing || busy || finishing || isStopping} title={microphoneLabel} onChange={event => {
        const deviceId = event.target.value;
        setInputDeviceId(deviceId);
        const preferences = { ...readSpeechPreferences(), inputDeviceId: deviceId };
        settingsStorage.setItem(speechPreferencesKey, JSON.stringify(preferences));
        config.current = preferences;
        setPreparing(true);
        setStartAttempt(attempt => attempt + 1);
      }}>
        <option value="">系统默认输入设备</option>
        {inputDeviceId && !microphones.some(device => device.deviceId === inputDeviceId) && <option value={inputDeviceId}>已保存的麦克风（不可用）</option>}
        {microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `麦克风 ${index + 1}`}</option>)}
      </select>
      <span className="shrink-0" aria-hidden="true">{Math.round(level * 100)}%</span>
    </label>
    <div className="stt-actions">
      {startupFailed
        ? <button disabled={isStopping} title="重试启动麦克风" aria-label="重试启动麦克风" onClick={() => { setStartupFailed(false); setPreparing(true); setStartAttempt(attempt => attempt + 1); }}><Play size={16} />重试</button>
        : <button disabled={preparing || finishing || !streamRef.current?.active} title={paused ? "继续录音" : "暂停录音"} aria-label={paused ? "继续录音" : "暂停录音"} onClick={togglePause}>{paused ? <Play size={16} /> : <Pause size={16} />}{paused ? "继续" : "暂停"}</button>}
    </div>
  </div>, document.body);
}
