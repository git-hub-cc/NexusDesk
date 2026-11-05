import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, House, Square, Power, RefreshCw, Smartphone, Maximize, Minimize, FolderOpen } from "lucide-react";
import { MirrorAudio } from "./mirrorAudio";
import { AndroidFileManager } from "./AndroidFileManager";

type Device = { serial: string; status: string; model: string };
type Connection = { id: string; decoder: VideoDecoder; audio?: MirrorAudio; config: Uint8Array; waiting: boolean; ended: boolean; queue: Promise<unknown>; statsTimer: ReturnType<typeof setInterval> | 0; stats: { packets: number; bytes: number; config: number; key: number; delta: number; waitingDrop: number; queueReset: number; submitted: number; output: number } };

function codecFromConfig(data: Uint8Array): string | undefined {
  for (let i = 0; i + 7 < data.length; i++) {
    const prefix = data[i] === 0 && data[i + 1] === 0
      ? data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0 : 0;
    if (prefix && (data[i + prefix] & 31) === 7) {
      return `avc1.${Array.from(data.slice(i + prefix + 1, i + prefix + 4), b => b.toString(16).padStart(2, "0")).join("")}`;
    }
  }
}

export function AndroidMirrorPanel({ active }: { active: boolean }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [serial, setSerial] = useState("");
  const [maxSize, setMaxSize] = useState(1080);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected">("idle");
  const [error, setError] = useState("");
  const [audioStatus, setAudioStatus] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [wifiBusy, setWifiBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [fps, setFps] = useState(0);
  const frameRate = useRef({ frames: 0, started: 0 });
  const fullscreenRequested = useRef(false);
  const fullscreenQueue = useRef(Promise.resolve());
  const previousWindow = useRef<{ fullscreen: boolean; maximized: boolean } | null>(null);
  const [screenOff, setScreenOff] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const refreshRequest = useRef(0);
  const refreshPending = useRef(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const connection = useRef<Connection | null>(null);
  const mounted = useRef(false);
  const visible = useRef(active && !document.hidden);
  const pointer = useRef<number | null>(null);
  const pendingMove = useRef<number | null>(null);
  const lastMove = useRef<Uint8Array | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const refresh = async (recover = false) => {
    if (refreshPending.current) return;
    refreshPending.current = true;
    const request = ++refreshRequest.current;
    setRefreshing(true); setError("");
    try {
      const list = await invoke<Device[]>("mirror_devices", { recover });
      if (!mounted.current || refreshRequest.current !== request) return;
      setScanned(true);
      setDevices(list);
      setSerial(previous => list.some(device => device.serial === previous && device.status === "device")
        ? previous : list.find(device => device.status === "device")?.serial ?? "");
    } catch (reason) { if (mounted.current && refreshRequest.current === request) setError(String(reason)); }
    finally {
      if (refreshRequest.current === request) {
        refreshPending.current = false;
        if (mounted.current) setRefreshing(false);
      }
    }
  };

  const disconnect = () => {
    const current = connection.current;
    connection.current = null;
    pointer.current = null;
    if (pendingMove.current !== null) cancelAnimationFrame(pendingMove.current);
    pendingMove.current = null; lastMove.current = null;
    if (current) {
      current.ended = true;
      clearInterval(current.statsTimer);
      if (current.decoder.state !== "closed") current.decoder.close();
      current.audio?.close();
      void invoke("mirror_stop", { id: current.id }).catch(reason => {
        if (mounted.current) setError(String(reason));
      });
    }
    canvas.current?.getContext("2d")?.clearRect(0, 0, canvas.current.width, canvas.current.height);
    frameRate.current = { frames: 0, started: performance.now() };
    if (mounted.current) { setFps(0); setStatus("idle"); setAudioStatus(""); setScreenOff(false); setDimensions({ width: 0, height: 0 }); }
  };

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      refreshRequest.current++;
      refreshPending.current = false;
      disconnect();
    };
  }, []);

  useEffect(() => {
    if (!active || status !== "idle") return;
    const update = () => { if (!document.hidden) void refresh(); };
    update();
    const timer = setInterval(update, 3000);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [active, status]);

  useEffect(() => {
    if (!active || status !== "connected") return;
    frameRate.current = { frames: 0, started: performance.now() };
    const timer = setInterval(() => {
      const now = performance.now();
      const { frames, started } = frameRate.current;
      setFps(visible.current && now > started ? Math.round(frames * 1000 / (now - started)) : 0);
      frameRate.current = { frames: 0, started: now };
    }, 1000);
    return () => clearInterval(timer);
  }, [active, status]);

  const setMirrorFullscreen = (entered: boolean) => {
    if (fullscreenRequested.current === entered) return;
    fullscreenRequested.current = entered;
    if (mounted.current) setFullscreen(entered);
    // Keep WebView2 out of DOM fullscreen: it has its own native fullscreen
    // lifecycle, which conflicts with Tauri's window state on Windows.
    fullscreenQueue.current = fullscreenQueue.current.then(async () => {
      const host = getCurrentWindow();
      if (entered) {
        previousWindow.current = {
          fullscreen: await host.isFullscreen(),
          maximized: await host.isMaximized(),
        };
        await host.setFullscreen(true);
      } else if (previousWindow.current) {
        const previous = previousWindow.current;
        await host.setFullscreen(previous.fullscreen);
        if (!previous.fullscreen && await host.isMaximized() !== previous.maximized) {
          if (previous.maximized) await host.maximize();
          else await host.unmaximize();
        }
        previousWindow.current = null;
      }
    }).catch(reason => { if (mounted.current) setError(`投屏全屏切换失败：${String(reason)}`); });
    if (entered) canvas.current?.focus();
  };
  useEffect(() => () => setMirrorFullscreen(false), []);
  const toggleFullscreen = () => setMirrorFullscreen(!fullscreenRequested.current);
  useEffect(() => {
    if (!active || status === "idle") setMirrorFullscreen(false);
  }, [active, status]);

  // Hidden tabs keep the device session but stop delivering video over IPC.
  useEffect(() => {
    const update = () => {
      visible.current = active && !document.hidden;
      frameRate.current = { frames: 0, started: performance.now() };
      setFps(0);
      const current = connection.current;
      if (current) {
        current.waiting = true;
        void invoke("mirror_visible", { id: current.id, visible: visible.current }).catch(() => {});
      }
      if (!visible.current && pointer.current !== null) releasePointer();
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [active]);

  const connect = async () => {
    if (!serial || connection.current) {
      console.info("[android-mirror] connect ignored", { serialSelected: Boolean(serial), connectionActive: Boolean(connection.current) });
      return;
    }
    console.info("[android-mirror] connect requested", { serial, maxSize });
    if (!("VideoDecoder" in window)) {
      const reason = "当前 WebView 不支持 WebCodecs，请更新 WebView2 Runtime。";
      console.error("[android-mirror] connect unavailable", reason);
      setError(reason);
      return;
    }
    setError(""); setStatus("connecting");
    const id = crypto.randomUUID();
    const fail = (reason: unknown) => {
      if (connection.current?.id !== id) return;
      console.error("[android-mirror] connect failed", { id, serial, error: String(reason) });
      disconnect();
      if (mounted.current) setError(String(reason));
    };
    let decoder: VideoDecoder;
    try {
      decoder = new VideoDecoder({
        output: frame => {
          try {
            const target = canvas.current;
            if (!target || !visible.current || connection.current?.id !== id) return;
            if (target.width !== frame.displayWidth || target.height !== frame.displayHeight) {
              target.width = frame.displayWidth; target.height = frame.displayHeight;
            }
            // Disconnect clears the displayed dimensions but retains the canvas size.
            // Restore them even when the new session uses the same resolution.
            const width = frame.displayWidth, height = frame.displayHeight;
            setDimensions(previous => previous.width === width && previous.height === height
              ? previous : { width, height });
            const context = target.getContext("2d");
            if (context) {
              context.drawImage(frame, 0, 0);
              frameRate.current.frames++;
              current.stats.output++;
            }
          } finally { frame.close(); }
        },
        error: fail,
      });
    } catch (reason) {
      console.error("[android-mirror] decoder initialization failed", { serial, error: String(reason) });
      setStatus("idle");
      setError(String(reason));
      return;
    }
    const current: Connection = { id, decoder, config: new Uint8Array(), waiting: true, ended: false, queue: Promise.resolve(), statsTimer: 0, stats: { packets: 0, bytes: 0, config: 0, key: 0, delta: 0, waitingDrop: 0, queueReset: 0, submitted: 0, output: 0 } };
    connection.current = current;
    current.statsTimer = setInterval(() => {
      if (current.ended || connection.current !== current) return;
      const s = current.stats;
      console.info("[android-mirror] video", { packets: s.packets, bytes: s.bytes, config: s.config, key: s.key, delta: s.delta, waitingDrop: s.waitingDrop, queueReset: s.queueReset, submitted: s.submitted, output: s.output, decoderQueue: decoder.decodeQueueSize, visible: visible.current });
      current.stats = { packets: 0, bytes: 0, config: 0, key: 0, delta: 0, waitingDrop: 0, queueReset: 0, submitted: 0, output: 0 };
    }, 1000);
    const audioFailed = (reason: string) => {
      if (current.ended || connection.current !== current) return;
      current.audio?.close();
      current.audio = undefined;
      if (mounted.current) setAudioStatus(reason);
    };
    // Resume during the connect button's user gesture to permit audio playback.
    let audioReady: Promise<void> = Promise.resolve();
    try {
      current.audio = new MirrorAudio();
      audioReady = current.audio.resume().catch(() => audioFailed("电脑音频播放失败，请检查声音设置后重新连接"));
      setAudioStatus("等待手机音频");
    } catch { audioFailed("当前环境无法播放音频"); }
    const audioChannel = new Channel<ArrayBuffer>();
    audioChannel.onmessage = buffer => {
      if (current.ended || connection.current !== current) return;
      if (!buffer.byteLength) {
        audioFailed("音频不可用：需要 Android 11+；Android 11 请解锁手机后重新连接，部分应用不允许录音");
        return;
      }
      if (!current.audio) return;
      try {
        current.audio.play(buffer);
        setAudioStatus("声音由电脑播放");
      } catch (reason) { audioFailed(String(reason)); }
    };
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = buffer => {
      if (current.ended || connection.current !== current) return;
      const packet = new Uint8Array(buffer);
      current.stats.packets++;
      current.stats.bytes += packet.byteLength;
      if (!packet.length) { fail("设备连接已断开，请检查 USB 连接后重试。"); return; }
      if (packet.length < 12) { fail("无效的 scrcpy 视频数据"); return; }
      const config = (packet[0] & 0x80) !== 0;
      const key = (packet[0] & 0x40) !== 0;
      const data = packet.subarray(12);
      try {
        if (config) {
          current.stats.config++;
          current.config = data.slice();
          const codec = codecFromConfig(data);
          if (!codec) throw new Error("无法读取 H.264 编码参数");
          decoder.configure({ codec, optimizeForLatency: true });
          current.waiting = true;
          return;
        }
        if (!visible.current || decoder.state !== "configured") { current.waiting = true; return; }
        if (decoder.decodeQueueSize > 3) {
          current.stats.queueReset++;
          decoder.reset();
          const codec = codecFromConfig(current.config);
          if (codec) decoder.configure({ codec, optimizeForLatency: true });
          current.waiting = true;
        }
        if (current.waiting && !key) { current.stats.waitingDrop++; return; }
        if (key) current.stats.key++; else current.stats.delta++;
        const payload = key ? new Uint8Array(current.config.length + data.length) : data;
        if (key) { payload.set(current.config); payload.set(data, current.config.length); }
        const view = new DataView(buffer);
        const timestamp = (view.getUint32(0) & 0x3fffffff) * 4294967296 + view.getUint32(4);
        decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data: payload }));
        current.stats.submitted++;
        current.waiting = false;
      } catch (reason) { fail(reason); }
    };
    try {
      console.info("[android-mirror] waiting for audio initialization", { id, serial });
      await audioReady;
      if (current.ended || connection.current !== current) return;
      console.info("[android-mirror] invoking mirror_start", { id, serial, maxSize });
      await invoke("mirror_start", { id, serial, maxSize, channel, audioChannel });
      // A tab can close or disconnect while adb is still starting.
      if (current.ended || connection.current !== current) { await invoke("mirror_stop", { id }); return; }
      await invoke("mirror_visible", { id, visible: visible.current });
      if (connection.current === current && mounted.current) {
        console.info("[android-mirror] connect established", { id, serial });
        setStatus("connected");
      }
    } catch (reason) { fail(reason); }
  };

  const connectWifi = async () => {
    if (!serial || wifiBusy) return;
    setWifiBusy(true); setError("");
    try {
      const endpoint = await invoke<string>("mirror_connect_wifi", { serial });
      await refresh();
      setSerial(endpoint);
    } catch (reason) { setError(String(reason)); }
    finally { setWifiBusy(false); }
  };

  const send = (bytes: Uint8Array) => {
    const current = connection.current;
    if (!current || current.ended) return;
    // Serialize controls so a release can never overtake its press.
    current.queue = current.queue.then(() => {
      if (!current.ended) return invoke("mirror_control", { id: current.id, data: Array.from(bytes) });
    }).catch(reason => { if (mounted.current && connection.current === current) { setError(String(reason)); disconnect(); } });
  };
  const key = (code: number) => {
    for (const action of [0, 1]) {
      const bytes = new Uint8Array(14); bytes[1] = action;
      new DataView(bytes.buffer).setUint32(2, code); send(bytes);
    }
  };
  const touch = (event: PointerEvent<HTMLCanvasElement>, action: number) => {
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const bytes = new Uint8Array(32); bytes[0] = 2; bytes[1] = action;
    const view = new DataView(bytes.buffer);
    view.setBigUint64(2, 0xffffffffffffffffn); // scrcpy mouse pointer
    view.setUint32(10, Math.max(0, Math.min(target.width - 1, Math.round((event.clientX - rect.left) * target.width / rect.width))));
    view.setUint32(14, Math.max(0, Math.min(target.height - 1, Math.round((event.clientY - rect.top) * target.height / rect.height))));
    view.setUint16(18, target.width); view.setUint16(20, target.height);
    view.setUint16(22, action === 1 ? 0 : 65535);
    view.setUint32(24, action === 2 ? 0 : 1); view.setUint32(28, action === 1 ? 0 : 1);
    lastTouch.current = bytes;
    return bytes;
  };
  const lastTouch = useRef<Uint8Array | null>(null);
  const releasePointer = () => {
    if (pointer.current === null) return;
    if (pendingMove.current !== null) cancelAnimationFrame(pendingMove.current);
    pendingMove.current = null; lastMove.current = null;
    if (lastTouch.current) {
      const bytes = lastTouch.current.slice(); bytes[1] = 1;
      const view = new DataView(bytes.buffer); view.setUint16(22, 0); view.setUint32(28, 0); send(bytes);
    }
    pointer.current = null;
  };
  const connected = status === "connected";
  return <div ref={panel} data-mirror-fullscreen={fullscreen ? "true" : undefined}
    className={`${fullscreen ? "fixed z-[10000] bg-black" : "absolute bg-ide-bg"} inset-0 flex flex-col ${active ? "" : "hidden"}`}
    onKeyDownCapture={e => {
      if (e.key === "Escape" && fullscreenRequested.current) {
        e.preventDefault(); e.stopPropagation(); setMirrorFullscreen(false);
      }
    }}>
    <div className="markdown-toolbar shrink-0 flex-wrap gap-1" style={{ justifyContent: "flex-start", alignItems: "center", display: fullscreen ? "none" : undefined }} role="toolbar" aria-label="安卓投屏控制">
      <Smartphone size={15} />
      <select aria-label="Android 设备" className="min-w-0 max-w-48 rounded bg-ide-bg p-1 text-xs" value={serial} disabled={status !== "idle"} onChange={e => setSerial(e.target.value)}>
        <option value="">{refreshing ? "正在查找设备…" : scanned && !devices.length ? "未发现设备" : "选择设备"}</option>
        {devices.map(device => <option key={device.serial} value={device.serial} disabled={device.status !== "device"}>
          {device.model} · {device.serial}{device.status === "unauthorized" ? "（请在手机授权）" : device.status !== "device" ? `（${device.status}）` : ""}
        </option>)}
      </select>
      <button aria-label="刷新设备" title="刷新设备并尝试恢复离线连接" disabled={refreshing || status !== "idle"} onClick={() => void refresh(true)}><RefreshCw size={14} className={refreshing ? "animate-spin" : ""} /></button>
      {serial && !serial.includes(":") && <button type="button" disabled={status !== "idle" || wifiBusy || devices.find(device => device.serial === serial)?.status !== "device"} onClick={() => void connectWifi()}>{wifiBusy ? "正在切换…" : "切换到 Wi-Fi"}</button>}
      <select aria-label="投屏最长边像素" title="最长边像素，断开后可调整" className="rounded bg-ide-bg p-1 text-xs" value={maxSize} disabled={status !== "idle"} onChange={e => setMaxSize(Number(e.target.value))}>
        {[720, 1080, 1440].map(size => <option key={size} value={size}>{size}px</option>)}
      </select>
      <button disabled={status === "idle" && !serial} onClick={() => status === "idle" ? void connect() : disconnect()}>
        {status === "connecting" ? "取消连接" : connected ? "断开" : "连接"}
      </button>
      {([["返回", ArrowLeft, () => key(4)], ["主页", House, () => key(3)], ["最近任务", Square, () => key(187)]] as const).map(([label, Icon, action]) =>
        <button key={label} aria-label={label} title={label} disabled={!connected} onClick={action}><Icon size={14} /></button>)}
      <button aria-label={screenOff ? "点亮手机屏幕" : "关闭手机屏幕（投屏继续）"} title={screenOff ? "点亮手机屏幕" : "关闭手机屏幕（投屏继续）"} disabled={!connected} onClick={() => {
        send(new Uint8Array([10, screenOff ? 1 : 0]));
        setScreenOff(!screenOff);
      }}><Power size={14} /></button>
      <button aria-label="投屏全屏" title="投屏全屏（Esc 退出）" disabled={!connected} onClick={toggleFullscreen}><Maximize size={14} /></button>
      <button aria-label="文件管理" title="文件管理" aria-pressed={filesOpen} disabled={!serial} onClick={() => setFilesOpen(!filesOpen)}><FolderOpen size={14} /><span>文件管理</span></button>
    </div>
    {fullscreen && <button aria-label="退出投屏全屏" title="退出全屏（Esc）" className="absolute right-4 top-4 z-10 rounded bg-black/60 p-2 text-white opacity-40 hover:opacity-100 focus:opacity-100" onClick={toggleFullscreen}><Minimize size={20} /></button>}
    {error && <div role="alert" className="shrink-0 break-words border-b border-ide-panel-border p-2 text-xs text-red-400">{error}</div>}
    <div className="flex min-h-0 min-w-0 flex-1">
    <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden" style={{ containerType: "size" }}>
      {connected && <div className="pointer-events-none absolute left-2 top-2 z-10 select-none rounded bg-black/60 px-2 py-1 font-mono text-xs tabular-nums text-white" title="每秒实际绘制的投屏帧数">
        {fps} FPS
      </div>}
      <canvas ref={canvas} tabIndex={connected ? 0 : -1} aria-label="Android 画面，点击后可使用键盘控制"
        className={`${dimensions.width ? "block" : "hidden"} shrink-0 touch-none bg-black outline-none focus-visible:outline-none`}
        // Size the canvas itself to the available area so touch coordinates use
        // the same bounds as the image, including after rotation or pane resize.
        style={{
          width: dimensions.width ? `min(100cqw, calc(100cqh * ${dimensions.width / dimensions.height}))` : "auto",
          height: dimensions.width ? `min(100cqh, calc(100cqw * ${dimensions.height / dimensions.width}))` : "auto",
          aspectRatio: dimensions.width ? `${dimensions.width}/${dimensions.height}` : undefined,
        }}
        onContextMenu={e => e.preventDefault()}
        onPointerDown={e => {
          if (!connected || pointer.current !== null) return;
          e.preventDefault(); e.currentTarget.focus();
          if (e.button === 2) { key(4); return; }
          if (e.button !== 0) return;
          pointer.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId); send(touch(e, 0));
        }}
        onPointerMove={e => {
          if (pointer.current !== e.pointerId) return;
          lastMove.current = touch(e, 2);
          if (pendingMove.current === null) pendingMove.current = requestAnimationFrame(() => {
            pendingMove.current = null; if (lastMove.current) send(lastMove.current); lastMove.current = null;
          });
        }}
        onPointerUp={e => { if (pointer.current === e.pointerId) { lastTouch.current = touch(e, 1); releasePointer(); } }}
        onPointerCancel={releasePointer} onLostPointerCapture={releasePointer} onBlur={releasePointer}
        onKeyDown={e => {
          if (!connected || e.nativeEvent.isComposing) return;
          e.stopPropagation();
          if (e.key === "Escape" && fullscreenRequested.current) {
            setMirrorFullscreen(false);
            return;
          }
          const keys: Record<string, number> = { Enter: 66, Backspace: 67, Delete: 112, Escape: 4, Tab: 61, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Home: 3 };
          if (keys[e.key]) { e.preventDefault(); key(keys[e.key]); }
          else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
            e.preventDefault();
            const text = new TextEncoder().encode(e.key);
            const bytes = new Uint8Array(5 + text.length); bytes[0] = 1;
            new DataView(bytes.buffer).setUint32(1, text.length); bytes.set(text, 5); send(bytes);
          }
        }} />
      {!dimensions.width && <div role="status" className="max-w-sm p-4 text-center text-xs leading-6 text-gray-400">
        <Smartphone size={40} className="mx-auto mb-3 opacity-40" />
        {status === "connecting" ? "正在连接设备…" : connected ? "等待手机画面…" : "连接 Android 手机，开启 USB 调试并在手机上允许此电脑。刷新设备列表后选择设备并连接。"}
        {status === "idle" && scanned && !devices.length && <p className="mt-2 text-amber-400">ADB 未发现设备。请重新插拔 USB 数据线，确认已开启 USB 调试并解锁手机；若出现授权弹窗，请选择允许。设备列表会自动更新，也可点击刷新尝试恢复连接。</p>}
        {status === "idle" && devices.some(device => device.status === "unauthorized") && <p className="mt-2 text-amber-400">请在手机上允许此电脑进行 USB 调试，授权后设备列表会自动更新。</p>}
        {status === "idle" && devices.some(device => device.status === "offline") && <p className="mt-2 text-amber-400">设备处于离线状态，请点击刷新恢复连接；若仍离线，请重新插拔数据线。</p>}
        <p className="mt-2 text-gray-500">需要 scrcpy 3.3.4 或 5.0.1，支持自动识别 Scoop 安装。画面支持点击、拖拽和基础键盘输入。Android 11 及以上支持通过电脑播放手机声音，Android 11 请先解锁手机。</p>
      </div>}
    </div>
    {filesOpen && serial && <div className={fullscreen ? "hidden" : "contents"}><AndroidFileManager key={serial} serial={serial} onClose={() => setFilesOpen(false)} /></div>}
    </div>
    <div className={`${fullscreen ? "hidden" : ""} shrink-0 border-t border-ide-panel-border px-2 py-1 text-[11px] text-gray-500`} role="status">
      {connected ? `${serial} · ${dimensions.width} × ${dimensions.height} · 自适应` : status === "connecting" ? "正在启动 scrcpy" : "未连接"}
      {audioStatus && ` · ${audioStatus}`}
    </div>
  </div>;
}
