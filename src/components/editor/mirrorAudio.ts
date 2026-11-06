// scrcpy raw audio: 48 kHz, stereo, signed 16-bit little endian.
export class MirrorAudio {
  private readonly context = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;

  async resume() {
    await this.context.resume();
    if (this.context.state !== "running") throw new Error("请允许电脑播放音频后重新连接。");
  }

  play(packet: ArrayBuffer) {
    if (this.context.state !== "running") return;
    const view = new DataView(packet);
    const size = view.byteLength - 12;
    if (size <= 0 || size > 4096 || size % 4 !== 0 || view.getUint32(8) !== size) {
      throw new Error("无效的手机音频数据");
    }
    const now = this.context.currentTime;
    // Drop stale audio when IPC catches up after a stall; bound playback delay.
    if (this.nextTime > now + 0.25) return;
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
    for (const source of this.sources) {
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    if (this.context.state !== "closed") void this.context.close().catch(() => {});
  }
}
