import { MirrorVideoMetrics, TimingSamples, readMirrorVideoPacket } from "../components/editor/mirrorVideoMetrics";

let canvas;
let context;
let decoder;
let config = new Uint8Array();
let waiting = true;
let dimensionsReady = false;
let sessionId;
let statsTimer;
let statsStarted;
let metrics;
let pageToWorker;
let rustToWorker;
let socket;
let transport;
let visible;
let congestedAt;
let staleDrops = 0;
let packets = 0;
let unconfiguredDrops = 0;

function startStats(id, initialVisible) {
  clearInterval(statsTimer);
  sessionId = id;
  metrics = new MirrorVideoMetrics();
  pageToWorker = new TimingSamples();
  rustToWorker = new TimingSamples();
  transport = "pending";
  visible = initialVisible;
  packets = unconfiguredDrops = staleDrops = 0;
  statsStarted = performance.now();
  statsTimer = setInterval(() => {
    const now = performance.now();
    self.postMessage({
      type: "stats", id, endedAt: performance.timeOrigin + now,
      windowMs: Math.round(now - statsStarted),
      transport, visible, packets, unconfiguredDrops, staleDrops,
      pageToWorkerMs: pageToWorker.take(), rustToWorkerMs: rustToWorker.take(),
      decoderQueue: decoder?.decodeQueueSize ?? 0, ...metrics.take(),
    });
    statsStarted = now;
    packets = unconfiguredDrops = staleDrops = 0;
  }, 1000);
}

function codecFromConfig(data) {
  for (let i = 0; i + 7 < data.length; i++) {
    const prefix = data[i] === 0 && data[i + 1] === 0 ? data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0 : 0;
    if (prefix && (data[i + prefix] & 31) === 7) return `avc1.${Array.from(data.slice(i + prefix + 1, i + prefix + 4), b => b.toString(16).padStart(2, "0")).join("")}`;
  }
}
function configure(data) {
  config = data.slice();
  const codec = codecFromConfig(config);
  if (!codec) throw new Error("Invalid H.264 configuration");
  if (decoder && decoder.state !== "closed") decoder.close();
  metrics.clearPending();
  const activeDecoder = new VideoDecoder({
    output(frame) {
      try {
        if (decoder !== activeDecoder) return;
        metrics.output(frame.timestamp, performance.now());
        if (!visible) return;
        const dimensionsChanged = canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight;
        if (dimensionsChanged) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        // 断开后主线程会清空显示尺寸，但 OffscreenCanvas 会保留旧尺寸。
        // 新会话首帧即使分辨率相同，也必须再次通知主线程恢复画面。
        if (dimensionsChanged || !dimensionsReady) {
          dimensionsReady = true;
          self.postMessage({ type: "dimensions", id: sessionId, width: frame.displayWidth, height: frame.displayHeight });
        }
        const drawStarted = performance.now();
        context.drawImage(frame, 0, 0);
        metrics.drew(drawStarted, performance.now());
      } finally { frame.close(); }
    },
    error(error) { self.postMessage({ type: "error", message: String(error) }); },
  });
  decoder = activeDecoder;
  decoder.configure({ codec, optimizeForLatency: true });
  waiting = true;
  congestedAt = undefined;
  dimensionsReady = false;
}

function receivePacket(buffer, forwardedAt) {
  const receivedAt = performance.now();
  const packet = readMirrorVideoPacket(buffer);
  if (packet.config) {
    configure(packet.data);
    return;
  }
  packets++;
  const age = packet.sentAtMs ? Date.now() - packet.sentAtMs : 0;
  if (forwardedAt !== undefined) {
    pageToWorker.add(performance.timeOrigin + receivedAt - forwardedAt);
  } else if (packet.sentAtMs) {
    rustToWorker.add(age);
  }
  if (!decoder || decoder.state !== "configured") {
    unconfiguredDrops++;
    return;
  }
  const queued = decoder.decodeQueueSize;
  metrics.queue(queued);
  congestedAt = queued > 3 ? congestedAt ?? receivedAt : undefined;
  const stale = age > 120;
  const overloaded = queued >= 8 || (congestedAt !== undefined && receivedAt - congestedAt >= 80);
  if (!waiting && (stale || overloaded)) {
    metrics.resetForOverload(receivedAt);
    configure(config);
  }
  if (stale) {
    staleDrops++;
    return;
  }
  if (waiting && !packet.key) {
    metrics.waitingDrop();
    return;
  }
  const payload = packet.key ? new Uint8Array(config.length + packet.data.length) : packet.data;
  if (packet.key) {
    payload.set(config);
    payload.set(packet.data, config.length);
  }
  const chunk = new EncodedVideoChunk({
    type: packet.key ? "key" : "delta", timestamp: packet.timestamp, data: payload,
  });
  metrics.submit(packet.timestamp, performance.now());
  decoder.decode(chunk);
  metrics.queue(decoder.decodeQueueSize);
  waiting = false;
}

function openSocket(url) {
  let connection;
  try {
    connection = new WebSocket(url);
  } catch {
    return;
  }
  socket = connection;
  connection.binaryType = "arraybuffer";
  connection.onopen = () => {
    if (socket === connection) transport = "socket";
  };
  connection.onmessage = event => {
    if (socket !== connection) return;
    try {
      receivePacket(event.data);
      connection.send("ack");
    } catch {
      connection.close();
    }
  };
  connection.onclose = () => {
    if (socket === connection) socket = undefined;
  };
}

self.onmessage = event => {
  const message = event.data;
  try {
    if (message.type === "init") { canvas = message.canvas; context = canvas.getContext("2d"); }
    else if (message.type === "start") startStats(message.id, message.visible);
    else if (message.id !== sessionId) return;
    else if (message.type === "socket" && transport === "pending") openSocket(message.url);
    else if (message.type === "visible") visible = message.visible;
    else if (message.type === "packet") {
      socket?.close();
      socket = undefined;
      transport = "ipc";
      receivePacket(message.data, message.forwardedAt);
    } else if (message.type === "stop") {
      clearInterval(statsTimer);
      sessionId = undefined;
      socket?.close();
      socket = undefined;
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = undefined;
    }
  } catch (error) { self.postMessage({ type: "error", message: String(error) }); }
};
