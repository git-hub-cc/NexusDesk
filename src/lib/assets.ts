import { convertFileSrc } from "@tauri-apps/api/core";

const fileExtensions = {
  image: new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif"]),
  video: new Set(["mp4", "m4v", "webm", "ogg", "mov", "mkv", "avi", "ogv"]),
  document: new Set(["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx"]),
  binary: new Set(["mp3", "wav", "flac", "zip", "7z", "rar", "exe", "dll", "iso", "img", "bin", "dat", "class", "wasm", "sqlite", "db"]),
};

function extension(path: string): string {
  return /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase() ?? "";
}

export function isImage(path: string) {
  return fileExtensions.image.has(extension(path));
}

export function isVideo(path: string) {
  return fileExtensions.video.has(extension(path));
}

export function isPreviewDocument(path: string) {
  return fileExtensions.document.has(extension(path));
}

export function isTextFile(path: string) {
  return /\.(txt|md|markdown|mdx|json|js|jsx|ts|tsx|css|scss|less|html?|xml|svg|yaml|yml|toml|csv|log|ini|conf|env|rs|py|java|c|cc|cpp|h|hpp|go|php|rb|sh|bat|cmd|ps1|sql|vue|svelte)$/i.test(path);
}

export function isBinaryAsset(path: string) {
  return fileExtensions.binary.has(extension(path)) || isVideo(path) || isPreviewDocument(path);
}

export function canReadAsText(path: string) {
  return !isBinaryAsset(path) && (!isImage(path) || extension(path) === "svg");
}

export function canPreview(path: string) {
  return isImage(path) || isVideo(path) || isPreviewDocument(path);
}

export function canCompareAsText(path: string) {
  return canReadAsText(path) && !isImage(path);
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
