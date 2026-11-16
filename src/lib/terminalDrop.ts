import { resolveTerminalPath } from "@/lib/terminalLinks";
import { isRemotePath, remotePath, shellQuote } from "@/lib/remote";

export const terminalDropEvent = "nexusdesk-terminal-external-drop";
export type TerminalDropDetail = { sessionId: string; paths: string[]; error?: string };

export function terminalDropText(paths: unknown, session: { command: string; cwd: string | null; remoteId?: string }, windows: boolean): string {
  if (!Array.isArray(paths) || !paths.every(path => typeof path === "string" && path && !/[\x00-\x1f\x7f]/.test(path))) {
    throw new Error("拖入文件路径无效");
  }
  return [...new Set<string>(paths)].map(path => {
    if (isRemotePath(path)) {
      const remote = remotePath(path);
      if (remote.id !== session.remoteId) throw new Error("该文件不属于当前远程终端");
      return shellQuote(remote.path);
    }
    if (session.remoteId) throw new Error("本地文件不能直接作为远程 Shell 路径使用");
    const absolute = resolveTerminalPath(path, session.cwd);
    if (/\bwsl(?:\.exe)?\b/i.test(session.command) && /^(?:[A-Za-z]:|\/\/)/.test(absolute)) {
      throw new Error("请先将本地文件路径转换为 WSL 路径后再输入");
    }
    if (!windows || /bash|zsh|fish|\bwsl\b/i.test(session.command)) return shellQuote(absolute);
    if (/\bcmd(?:\.exe)?\b/i.test(session.command)) {
      if (/["%!]/.test(absolute)) throw new Error("该路径包含 CMD 特殊字符，请使用 PowerShell 终端");
      return `"${absolute}"`;
    }
    return `'${absolute.replace(/'/g, "''")}'`;
  }).join(" ");
}
