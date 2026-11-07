export interface MusicChorus { startTime: number; endTime: number }

const cache = new Map<string, Promise<MusicChorus | null>>();

export function getMusicChorus(
  id: string,
  request: (id: string) => Promise<MusicChorus | null>,
): Promise<MusicChorus | null> {
  if (!/^\d+$/.test(id)) return Promise.resolve(null);
  const cached = cache.get(id);
  if (cached) {
    cache.delete(id);
    cache.set(id, cached);
    return cached;
  }
  // 缓存满时只淘汰最久未使用的一首，保留其他歌曲的副歌信息。
  if (cache.size >= 128) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const value = request(id).then(chorus => {
    if (!chorus || !Number.isFinite(chorus.startTime) || !Number.isFinite(chorus.endTime)
      || chorus.startTime < 0 || chorus.endTime <= chorus.startTime) return null;
    return chorus;
  }).catch(() => {
    // 临时请求失败不缓存，让下次播放可以重新获取。
    if (cache.get(id) === value) cache.delete(id);
    return null;
  });
  cache.set(id, value);
  return value;
}

export function chorusRange(chorus: MusicChorus | null, duration: number) {
  if (!chorus || !Number.isFinite(duration) || duration <= 0) return null;
  const start = chorus.startTime / 1000;
  const end = Math.min(chorus.endTime / 1000, duration);
  return start < end ? { start, end } : null;
}
