// scrcpy raw audio: 48 kHz, stereo, signed 16-bit little endian.
export class MirrorAudio {
  private readonly context = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private closed?: Promise<void>;
  private stats = { packets: 0, bytes: 0, overflow: 0, inactive: 0 };
  private statsStarted = performance.now();

  constructor(private readonly id: string) {
    this.context.onstatechange = () => {
      console.info("[android-mirror] audio context state", { id, state: this.context.state });
    };
    console.info("[android-mirror] audio context created", { id, sampleRate: this.context.sampleRate });
  }

  async resume() {
    await this.context.resume();
    if (this.context.state !== "running") throw new Error("请允许电脑播放音频后重新连接。");
  }

  play(packet: ArrayBuffer) {
    this.stats.packets++;
    this.stats.bytes += packet.byteLength;
    if (performance.now() - this.statsStarted >= 5000) {
      console.info("[android-mirror] audio playback", { id: this.id, ...this.stats, state: this.context.state, bufferedMs: Math.round(Math.max(0, this.nextTime - this.context.currentTime) * 1000), sources: this.sources.size });
      this.stats = { packets: 0, bytes: 0, overflow: 0, inactive: 0 };
      this.statsStarted = performance.now();
    }
    if (this.context.state !== "running") { this.stats.inactive++; return; }
    const view = new DataView(packet);
    const size = view.byteLength - 12;
    if (size <= 0 || size > 4096 || size % 4 !== 0 || view.getUint32(8) !== size) {
      throw new Error("无效的手机音频数据");
    }
    const now = this.context.currentTime;
    // Drop stale audio when IPC catches up after a stall; bound playback delay.
    if (this.nextTime > now + 0.25) { this.stats.overflow++; return; }
    const buffer = this.context.createBuffer(2, size / 4, 48000);
    for (let channel = 0; channel < 2; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = view.getInt16(12 + i * 4 + channel * 2, true) / 32768;
      }
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
    this.sources.add(source);
    const start = Math.max(now + 0.02, this.nextTime);
    source.start(start);
    this.nextTime = start + buffer.duration;
  }

  close() {
    if (this.closed) return this.closed;
    for (const source of this.sources) {
      try { source.stop(); }
      catch (reason) { console.warn("[android-mirror] audio source stop failed", { id: this.id, error: String(reason) }); }
      source.disconnect();
    }
    this.sources.clear();
    console.info("[android-mirror] audio closing", { id: this.id, ...this.stats, state: this.context.state });
    this.closed = (this.context.state !== "closed" ? this.context.close() : Promise.resolve()).then(() => {
      this.context.onstatechange = null;
      console.info("[android-mirror] audio closed", { id: this.id });
    }).catch(reason => {
      console.warn("[android-mirror] audio close failed", { id: this.id, error: String(reason) });
      throw reason;
    });
    return this.closed;
  }
}
