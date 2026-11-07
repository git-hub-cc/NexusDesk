import { convertFileSrc } from "@tauri-apps/api/core";

export function isImage(path: string) {
  return /\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i.test(path);
}

export function isVideo(path: string) {
  return /\.(mp4|webm|ogg|mov)$/i.test(path);
}

export function isBinaryAsset(path: string) {
  return /\.(mp4|m4v|webm|ogg|mov|mkv|avi|ogv|mp3|wav|flac|zip|7z|rar|pdf|docx?|xlsx?|pptx?|exe|dll|iso|img|bin|dat|class|wasm|sqlite|db)$/i.test(path);
}

export function resolveAsset(notePath: string, source: string) {
  if (/^(https?:|data:|blob:|tauri:|asset:)/i.test(source)) return source;
  try { source = decodeURIComponent(source); } catch { /* Preserve literal filenames with malformed escapes. */ }
  const noteDir = notePath.replace(/[/\\][^/\\]+$/, "");
  if (!source.startsWith("/") && !source.match(/^[A-Za-z]:/)) {
    return `${noteDir}/${source}`;
  }
  return source;
}

export function imageUrl(path: string) {
  if (/^(https?:|data:|blob:|tauri:|asset:)/i.test(path)) return path;
  return convertFileSrc(path);
}

export function assetMarkdown(path: string) {
  const name = path.split(/[/\\]/).pop() || "";
  return `![${name}](.asset/${encodeURIComponent(name)})`;
}
