import { invoke } from "@tauri-apps/api/core";
import { fsApi } from "./api";
import { isRemotePath } from "./remote";

export const ANDROID_FILE_TYPE = "application/x-nexusdesk-android-files";
const clipboardPrefix = "nexusdesk:android-files:";
export type AndroidFiles = { serial: string; paths: string[] };

export function topLevelPaths(paths: string[], local = false): string[] {
  const normalize = (path: string) => {
    const value = local ? path.replace(/\\/g, "/") : path;
    return (local && /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value).replace(/\/+$/, "");
  };
  const unique = [...new Map(paths.map(path => [normalize(path), path])).values()];
  return unique.filter(path => !unique.some(parent => parent !== path && normalize(path).startsWith(normalize(parent) + "/")));
}

export function parseAndroidFiles(text: string): AndroidFiles | null {
  try {
    const data = JSON.parse(text);
    if (typeof data.serial !== "string" || !data.serial || !Array.isArray(data.paths) || !data.paths.length
      || !data.paths.every((path: unknown) => typeof path === "string" && path.startsWith("/") && !path.includes("\0"))) return null;
    return { serial: data.serial, paths: topLevelPaths(data.paths) };
  } catch { return null; }
}

export async function copyAndroidFiles(data: AndroidFiles) {
  await invoke("write_text_clipboard", { text: clipboardPrefix + JSON.stringify({ ...data, paths: topLevelPaths(data.paths) }) });
}

export async function readAndroidClipboard(text?: string): Promise<AndroidFiles | null> {
  const value = text || await invoke<string>("read_text_clipboard");
  return value.startsWith(clipboardPrefix) ? parseAndroidFiles(value.slice(clipboardPrefix.length)) : null;
}

export async function downloadAndroidFiles(data: AndroidFiles, directory: string, onDownloaded?: (path: string) => void) {
  if (isRemotePath(directory)) throw new Error("请将手机文件下载到本地目录");
  const paths: string[] = [];
  for (const remotePath of topLevelPaths(data.paths)) {
    const path = await invoke<string>("mirror_download_file", { serial: data.serial, remotePath, localDir: directory });
    paths.push(path); onDownloaded?.(path);
  }
  return paths;
}

export async function uploadLocalFiles(serial: string, paths: string[], remoteDir: string) {
  for (const localPath of topLevelPaths(paths, true)) {
    if (isRemotePath(localPath)) throw new Error("请从本地文件树上传文件");
    await invoke("mirror_push_file", { serial, localPath, remoteDir });
  }
}

export function localDropPaths(data: DataTransfer): string[] {
  const multiple = data.getData("application/x-nexusdesk-files");
  if (multiple) {
    const paths: unknown = JSON.parse(multiple);
    if (!Array.isArray(paths) || !paths.every(path => typeof path === "string")) throw new Error("无效的文件拖拽数据");
    return paths;
  }
  const path = data.getData("application/x-nexusdesk-file") || data.getData("application/x-nexusdesk-logical-file");
  return path ? [path] : [];
}

export async function pasteToAndroid(serial: string, remoteDir: string) {
  const local = await fsApi.readFileClipboard();
  if (local.paths.length) { await uploadLocalFiles(serial, local.paths, remoteDir); return local.paths.length; }
  const android = await readAndroidClipboard();
  if (!android) throw new Error("请先在文件树中复制文件或目录");
  if (android.serial !== serial) throw new Error("暂不支持在不同安卓设备间粘贴，请先下载到本地");
  for (const sourcePath of android.paths) await invoke("mirror_copy_file", { serial, sourcePath, remoteDir });
  return android.paths.length;
}
