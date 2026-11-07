let canvas;
let context;
let decoder;
let config = new Uint8Array();
let waiting = true;
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
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
          self.postMessage({ type: "dimensions", width: frame.displayWidth, height: frame.displayHeight });
        }
        context.drawImage(frame, 0, 0); self.postMessage({ type: "frame" });
      } finally { frame.close(); }
    },
    error(error) { self.postMessage({ type: "error", message: String(error) }); },
  });
  decoder.configure({ codec, optimizeForLatency: true }); waiting = true;
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
