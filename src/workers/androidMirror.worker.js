let canvas;
let context;
let decoder;
let config = new Uint8Array();
let waiting = true;
let dimensionsReady = false;
function codecFromConfig(data) {
  for (let i = 0; i + 7 < data.length; i++) {
    const prefix = data[i] === 0 && data[i + 1] === 0 ? data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0 : 0;
    if (prefix && (data[i + prefix] & 31) === 7) return `avc1.${Array.from(data.slice(i + prefix + 1, i + prefix + 4), b => b.toString(16).padStart(2, "0")).join("")}`;
  }
}
function configure(data) {
  config = new Uint8Array(data);
  const codec = codecFromConfig(config);
  if (!codec) throw new Error("Invalid H.264 configuration");
  if (decoder && decoder.state !== "closed") decoder.close();
  decoder = new VideoDecoder({
    output(frame) {
      try {
        const dimensionsChanged = canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight;
        if (dimensionsChanged) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        // 断开后主线程会清空显示尺寸，但 OffscreenCanvas 会保留旧尺寸。
        // 新会话首帧即使分辨率相同，也必须再次通知主线程恢复画面。
        if (dimensionsChanged || !dimensionsReady) {
          dimensionsReady = true;
          self.postMessage({ type: "dimensions", width: frame.displayWidth, height: frame.displayHeight });
        }
        context.drawImage(frame, 0, 0); self.postMessage({ type: "frame" });
      } finally { frame.close(); }
    },
    error(error) { self.postMessage({ type: "error", message: String(error) }); },
  });
  decoder.configure({ codec, optimizeForLatency: true });
  waiting = true;
  dimensionsReady = false;
}
self.onmessage = event => {
  const message = event.data;
  try {
    if (message.type === "init") { canvas = message.canvas; context = canvas.getContext("2d"); }
    else if (message.type === "config") configure(message.data);
    else if (message.type === "packet") {
      if (!decoder || decoder.state !== "configured") return;
      if (decoder.decodeQueueSize > 3) configure(config);
      if (waiting && !message.key) return;
      const data = new Uint8Array(message.data);
      const payload = message.key ? new Uint8Array(config.length + data.length) : data;
      if (message.key) { payload.set(config); payload.set(data, config.length); }
      decoder.decode(new EncodedVideoChunk({ type: message.key ? "key" : "delta", timestamp: message.timestamp, data: payload })); waiting = false;
    } else if (message.type === "stop") { if (decoder && decoder.state !== "closed") decoder.close(); decoder = undefined; }
  } catch (error) { self.postMessage({ type: "error", message: String(error) }); }
};
