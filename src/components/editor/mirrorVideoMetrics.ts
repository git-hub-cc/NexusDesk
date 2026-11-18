export function readMirrorVideoPacket(buffer: ArrayBuffer) {
  if (buffer.byteLength < 12) throw new Error("无效的 scrcpy 视频数据");
  const view = new DataView(buffer);
  const end = 12 + view.getUint32(8);
  const hasTime = buffer.byteLength === end + 8;
  if (!hasTime && buffer.byteLength !== end) throw new Error("无效的 scrcpy 视频数据");
  const flags = view.getUint8(0);
  return {
    config: (flags & 0x80) !== 0,
    key: (flags & 0x40) !== 0,
    timestamp: (view.getUint32(0) & 0x3fffffff) * 4294967296 + view.getUint32(4),
    data: new Uint8Array(buffer, 12, end - 12),
    sentAtMs: hasTime ? Number(view.getBigUint64(end)) : 0,
    packetSize: end,
  };
}

export class TimingSamples {
  private readonly values: number[] = [];
  private cursor = 0;
  private count = 0;
  private max = 0;

  add(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.values[this.cursor] = ms;
    this.cursor = (this.cursor + 1) % 256;
    this.count++;
    this.max = Math.max(this.max, ms);
  }

  take() {
    if (!this.count) return null;
    this.values.sort((a, b) => a - b);
    const p95 = this.values[Math.ceil(this.values.length * 0.95) - 1];
    const result = { count: this.count, p95: Math.round(p95 * 100) / 100, max: Math.round(this.max * 100) / 100 };
    this.values.length = 0;
    this.cursor = this.count = this.max = 0;
    return result;
  }
}

export class MirrorVideoMetrics {
  private readonly submittedAt = new Map<number, number>();
  private readonly decode = new TimingSamples();
  private readonly draw = new TimingSamples();
  private readonly drawGap = new TimingSamples();
  private readonly recovery = new TimingSamples();
  private lastDraw: number | undefined;
  private resetAt: number | undefined;
  private queuePeak = 0;
  private queueResets = 0;
  private waitingDrops = 0;
  private submitted = 0;
  private outputs = 0;
  private drawn = 0;

  queue(size: number) {
    this.queuePeak = Math.max(this.queuePeak, size);
  }

  clearPending() {
    this.submittedAt.clear();
  }

  resetForOverload(now: number) {
    this.queueResets++;
    this.resetAt ??= now;
    this.clearPending();
  }

  waitingDrop() {
    this.waitingDrops++;
  }

  submit(timestamp: number, now: number) {
    this.submitted++;
    if (this.submittedAt.size >= 256) {
      const oldest = this.submittedAt.keys().next();
      if (!oldest.done) this.submittedAt.delete(oldest.value);
    }
    this.submittedAt.set(timestamp, now);
  }

  output(timestamp: number, now: number) {
    this.outputs++;
    const submitted = this.submittedAt.get(timestamp);
    if (submitted !== undefined) {
      this.decode.add(now - submitted);
      this.submittedAt.delete(timestamp);
    }
  }

  drew(start: number, end: number) {
    this.drawn++;
    this.draw.add(end - start);
    if (this.lastDraw !== undefined) this.drawGap.add(end - this.lastDraw);
    this.lastDraw = end;
    if (this.resetAt !== undefined) {
      this.recovery.add(end - this.resetAt);
      this.resetAt = undefined;
    }
  }

  take() {
    const stats = {
      submitted: this.submitted,
      outputs: this.outputs,
      drawn: this.drawn,
      pendingDecodeSamples: this.submittedAt.size,
      queuePeak: this.queuePeak,
      queueResets: this.queueResets,
      waitingDrops: this.waitingDrops,
      waitingForOutputAfterReset: this.resetAt !== undefined,
      decodeToOutputMs: this.decode.take(),
      drawCallMs: this.draw.take(),
      drawGapMs: this.drawGap.take(),
      resetToDrawMs: this.recovery.take(),
    };
    this.queuePeak = this.queueResets = this.waitingDrops = this.submitted = this.outputs = this.drawn = 0;
    return stats;
  }
}
