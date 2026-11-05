import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Activity, Pause, Play, X } from "lucide-react";
import { acquireSpeechSession, releaseSpeechSession, SpeechBuffer, SpeechTask } from "./speechBuffer";
import { readSpeechPreferences } from "@/lib/speechPreferences";

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
  const [finishing, setFinishing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const ownsSpeechSession = useRef(false);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const animationRef = useRef<number | null>(null);
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
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      processorRef.current.disconnect();
    }
    if (contextRef.current && contextRef.current.state !== "closed") void contextRef.current.close();
    streamRef.current?.getTracks().forEach(track => track.stop());
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
    const start = async () => {
      try {
        const ready = await invoke<{ ready: boolean }>("stt_model_status", { model: config.current.model });
        if (!alive) return;
        if (!ready.ready) {
          setStatus("正在下载 SenseVoice 模型和词表…");
          await invoke("stt_download_model", { model: config.current.model });
        }
        if (!alive) return;
        setStatus("正在初始化识别引擎…");
        await invoke<Runtime>("stt_prepare", config.current);
        if (!alive) return;
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (!alive) { stream.getTracks().forEach(track => track.stop()); return; }
        streamRef.current = stream;
        const context = new AudioContext();
        contextRef.current = context;
        await context.resume();
        if (!alive) return;
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = .7;
        source.connect(analyser);
        const meter = new Uint8Array(analyser.fftSize);
        let lastMeter = 0;
        const update = (now: number) => {
          if (!alive) return;
          if (now - lastMeter > 80) {
            analyser.getByteTimeDomainData(meter);
            let sum = 0;
            for (const v of meter) sum += ((v - 128) / 128) ** 2;
            setLevel(pausedRef.current ? 0 : Math.min(1, Math.sqrt(sum / meter.length) * 8));
            lastMeter = now;
          }
          animationRef.current = requestAnimationFrame(update);
        };
        animationRef.current = requestAnimationFrame(update);
        const processor = context.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;
        source.connect(processor);
        const silent = context.createGain();
        silent.gain.value = 0;
        processor.connect(silent);
        silent.connect(context.destination);
        processor.onaudioprocess = event => {
          if (!alive || pausedRef.current || preparingRef.current || finishingRef.current) return;
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
          const voiced = Math.sqrt(sum / Math.max(1, data.length)) >= config.current.minVolume;
          if (voiced) { hasSpeech.current = true; silence.current = 0; }
          else silence.current += data.length / 16000;
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
        setStatus("正在监听，请开始说话");
      } catch (error) {
        if (alive) {
          releaseMicrophone();
          pausedRef.current = true;
          setPaused(true);
          setStatus(`启动失败：${String(error)}`);
        }
      } finally {
        if (alive) { preparingRef.current = false; setPreparing(false); }
      }
    };
    void start();
    return () => {
      alive = false;
      cleanup();
      releaseSpeechSession(sessionId);
    };
  }, [sessionId]);

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
    const showError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      if (detail?.message) setStatus(detail.message);
    };
    window.addEventListener("nexusdesk-speech-close", close);
    window.addEventListener("nexusdesk-speech-error", showError);
    return () => {
      window.removeEventListener("nexusdesk-speech-close", close);
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
    <div className="stt-actions">
      <button disabled={preparing || finishing || !streamRef.current?.active} title={paused ? "继续录音" : "暂停录音"} aria-label={paused ? "继续录音" : "暂停录音"} onClick={togglePause}>{paused ? <Play size={16} /> : <Pause size={16} />}{paused ? "继续" : "暂停"}</button>
    </div>
  </div>, document.body);
}
