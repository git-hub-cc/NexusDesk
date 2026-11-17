import { invoke } from "@tauri-apps/api/core";

export const isRemotePath = (path: string | null | undefined): path is string => !!path?.startsWith("sftp://");
export function remotePath(path: string): { id: string; path: string } {
  const match = /^sftp:\/\/([^/]+)(\/.*)$/.exec(path);
  if (!match) throw new Error("无效的远程路径");
  return { id: match[1], path: match[2] };
}
export const remoteUri = (id: string, path: string) => `sftp://${id}${path.startsWith("/") ? path : `/${path}`}`;
export const shellQuote = (path: string) => `'${path.replace(/'/g, `'"'"'`)}'`;

const uploads = new Map<string, Promise<unknown>>();
export function uploadLocal(sourcePath: string, targetDir: string): Promise<unknown> {
  const target = remotePath(targetDir);
  const path = `${target.path.replace(/\/$/, "")}/${sourcePath.split(/[/\\]/).pop()}`;
  const key = `${target.id}:${path}`;
  const existing = uploads.get(key);
  if (existing) return existing;
  const request = invoke("remote_files", { id: target.id, operation: "upload", path, content: sourcePath })
    .finally(() => { if (uploads.get(key) === request) uploads.delete(key); });
  uploads.set(key, request);
  return request;
}

// Remote paths always carry their connection ID, including tabs left open in another project.
// Never pass them to the local filesystem, database, Git, or system clipboard.
export async function invokePathCommand<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const paths = ["path", "sourcePath", "targetDir", "repoPath", "root", "notePath", "paths"].flatMap(key => Array.isArray(args[key]) ? args[key] : [args[key]]).filter((value): value is string => typeof value === "string" && isRemotePath(value));
  if (!paths.length) return invoke<T>(command, args);
  if (command === "copy_file_to_dir" && isRemotePath(args.targetDir as string) && !isRemotePath(args.sourcePath as string)) {
    await uploadLocal(args.sourcePath as string, args.targetDir as string);
    return undefined as T;
  }
  if (command === "import_asset" && isRemotePath(args.targetDir as string)) {
    const target = remotePath(args.targetDir as string);
    const name = args.name as string;
    if (!name || /[/\\\0]/.test(name) || name === "." || name === "..") throw new Error("SFTP operation failed; check connection, path and permissions");
    const path = `${target.path.replace(/\/$/, "")}/${name}`;
    const key = `${target.id}:${path}`;
    let request = uploads.get(key);
    if (!request) {
      request = invoke("remote_files", { id: target.id, operation: "upload_bytes", path, content: JSON.stringify(args.bytes) })
        .finally(() => uploads.delete(key));
      uploads.set(key, request);
    }
    await request;
    return remoteUri(target.id, path) as T;
  }
  const source = remotePath(paths[0]);
  if (paths.some(path => remotePath(path).id !== source.id)) throw new Error("不支持跨服务器移动文件");
  if (command === "touch_file") return undefined as T;
  if (command === "list_local_history" || command === "get_file_links") return [] as T;
  const operations: Record<string, string> = {
    read_directory: "list", read_file: "read", write_file: "write", is_directory: "stat",
    create_physical_file: "create", create_physical_dir: "mkdir", delete_entry: "delete",
    rename_entry: "rename", move_entry: "rename",
  };
  const operation = operations[command];
  if (!operation) throw new Error("此操作暂不支持 SFTP 远程文件");
  let content = args.content as string | undefined;
  if (command === "rename_entry") {
    const name = args.name as string;
    if (!name || /[/\\\0]/.test(name) || name === "." || name === "..") throw new Error("无效的文件名");
    content = source.path.replace(/[^/]+$/, name);
  }
  if (command === "move_entry") {
    if (!isRemotePath(args.targetDir as string) || !isRemotePath(args.sourcePath as string)) throw new Error("不支持在本地与远程之间移动文件");
    const target = remotePath(args.targetDir as string);
    content = `${target.path.replace(/\/$/, "")}/${source.path.split("/").pop()}`;
  }
  const result = await invoke<any>("remote_files", { id: source.id, operation, path: source.path, content });
  if (operation === "list") return result.map((entry: { path: string; name: string; directory: boolean }) => ({
    id: remoteUri(source.id, entry.path), name: entry.name, ...(entry.directory ? { children: [] } : {}),
  })) as T;
  return (operation === "rename" ? remoteUri(source.id, result) : result) as T;
}
