export interface ExtractedBase64 {
  url: string;
  mimeType: string;
  kind: "image" | "video" | "audio" | "file";
}

export function extractResponseBase64(body: string): ExtractedBase64[] {
  // JSON responses commonly escape slashes or the data URI prefix.
  const decoded = body.replace(/\\u([0-9a-f]{4})|\\\//gi, (_, hex: string | undefined) => hex ? String.fromCharCode(parseInt(hex, 16)) : "/");
  const results: ExtractedBase64[] = [];
  const seen = new Set<string>();
  for (const match of decoded.matchAll(/data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)?((?:;[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+)*);base64,([a-z0-9+/]+={0,2})/gi)) {
    const payload = match[3];
    if (payload.length % 4 === 1 || (payload.includes("=") && payload.length % 4 !== 0)) continue;
    const mimeType = (match[1] || "text/plain").toLowerCase();
    const url = `data:${mimeType}${match[2]};base64,${payload}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const kind = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio" : "file";
    results.push({ url, mimeType, kind });
  }
  return results;
}
