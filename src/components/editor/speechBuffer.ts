// Bound capture memory when inference is slower than recording.
export class SpeechBuffer {
  private parts: Float32Array[] = [];
  length = 0;
  static readonly segmentLength = 16000 * 12;
  static readonly capacity = 16000 * 24;

  append(samples: Float32Array): boolean {
    if (this.length + samples.length > SpeechBuffer.capacity) return false;
    this.parts.push(samples);
    this.length += samples.length;
    return true;
  }

  take(): Float32Array {
    const length = Math.min(this.length, SpeechBuffer.segmentLength);
    const output = new Float32Array(length);
    let offset = 0;
    while (offset < length) {
      const part = this.parts.shift()!;
      const count = Math.min(part.length, length - offset);
      output.set(part.subarray(0, count), offset);
      if (count < part.length) this.parts.unshift(part.subarray(count));
      offset += count;
    }
    this.length -= length;
    return output;
  }

  clear() { this.parts = []; this.length = 0; }
}

// Capture callbacks and Finish share one in-flight task.
export class SpeechTask {
  private pending: Promise<void> | null = null;
  run(work: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(work).finally(() => { this.pending = null; });
    return this.pending;
  }
}

let activeSpeechSession: string | null = null;

export function acquireSpeechSession(sessionId: string): boolean {
  if (activeSpeechSession !== null) return false;
  activeSpeechSession = sessionId;
  return true;
}

export function releaseSpeechSession(sessionId: string) {
  if (activeSpeechSession === sessionId) activeSpeechSession = null;
}
