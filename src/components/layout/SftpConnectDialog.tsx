import { settingsStorage } from "@/lib/globalSettings";
import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { remoteUri } from "@/lib/remote";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useLayoutStore } from "@/store/layoutStore";
import { readSettingsDraft } from "@/lib/useSettingsAutosave";

const FORM_KEY = "nexusdesk.sftp.form";
type ConnectionForm = { host: string; port: string; username: string; password: string };
type SavedConnection = { id: string; host: string; port: number; username: string; password: string };

function savedConnections(): SavedConnection[] {
  return settingsStorage.entries("sftp-connection:").flatMap(([key, raw]) => {
    try {
      const value = JSON.parse(raw);
      if (typeof value.host !== "string" || typeof value.username !== "string" || typeof value.password !== "string" || !Number.isInteger(value.port)) return [];
      return [{ ...value, id: key.slice("sftp-connection:".length) }];
    } catch { return []; }
  });
}

export function SftpConnectDialog({ onClose }: { onClose: () => void }) {
  const [connections] = useState(savedConnections);
  const [saved] = useState(() => readSettingsDraft<ConnectionForm>(FORM_KEY));
  const [host, setHost] = useState(saved.host || "");
  const [port, setPort] = useState(saved.port || "22");
  const [username, setUsername] = useState(saved.username || "root");
  const [password, setPassword] = useState(saved.password || "");
  const [trust, setTrust] = useState<string>();
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState("");

  const connect = async () => {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    let normalizedHost = host.trim();
    let normalizedPort = Number(port);
    if (/^(sftp|ssh):\/\//.test(normalizedHost)) {
      try { const url = new URL(normalizedHost); normalizedHost = url.hostname; if (url.port) normalizedPort = Number(url.port); } catch {}
    }
    const historyKey = `sftp-profile:${username.trim()}@${normalizedHost}:${normalizedPort}`;
    const id = settingsStorage.getItem(historyKey) || crypto.randomUUID();
    try {
      let hostname = host.trim();
      let serverPort = Number(port);
      if (hostname.startsWith("sftp://") || hostname.startsWith("ssh://")) {
        const url = new URL(hostname);
        hostname = url.hostname.replace(/^\[|\]$/g, "");
        if (url.port) serverPort = Number(url.port);
      }
      if (!hostname || !username.trim() || !Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) throw new Error("请输入有效的主机、端口（1–65535）和用户名");
      const result = await invoke<{ trusted: boolean; fingerprint: string; home: string }>("connect_remote", {
        id, config: { host: hostname, port: serverPort, username: username.trim(), password, fingerprint: trust },
      });
      if (!result.trusted) { setTrust(result.fingerprint); return; }
      const root = remoteUri(id, "/");
      if (!await useWorkspaceStore.getState().setProject(root)) throw new Error("无法打开远程目录，请检查目录权限或未保存的文件");
      settingsStorage.setItem(historyKey, id);
      settingsStorage.setItem(`sftp-label:${id}`, `${username.trim()}@${hostname}:${serverPort}`);
      settingsStorage.setItem(`sftp-connection:${id}`, JSON.stringify({ host: hostname, port: serverPort, username: username.trim(), password, fingerprint: result.fingerprint }));
      useWorkspaceStore.setState({ remoteLabel: `${username.trim()}@${hostname}:${serverPort}` });
      await useTerminalStore.getState().createSession({ id: "ssh", name: "终端", command: "" }, root);
      useLayoutStore.setState({ leftSidebarVisible: true, bottomPanelVisible: true, bottomPanelTab: "terminal" });
      setPassword("");
      onClose();
    } catch (cause) { setError(String(cause)); await invoke("close_remote", { id }).catch(() => {}); }
    finally { working.current = false; setBusy(false); }
  };

  return <Dialog.Root open onOpenChange={open => { if (!open && !working.current) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="search-overlay" />
      <Dialog.Content className="create-name-dialog" onEscapeKeyDown={event => { if (working.current) event.preventDefault(); }}
        onKeyDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-ide-panel-border px-4 py-3">
          <Dialog.Title className="font-medium">打开 SFTP...</Dialog.Title>
          <Dialog.Close disabled={busy} aria-label="关闭 SFTP 连接对话框" className="rounded p-1 hover:bg-white/10 disabled:opacity-40"><X size={16} /></Dialog.Close>
        </header>
        <Dialog.Description className="sr-only">连接后，在工作区文件树中浏览服务器目录，在底部终端中使用远程 Shell。</Dialog.Description>
        <form className="flex flex-col gap-3 p-4 text-sm" onSubmit={event => { event.preventDefault(); void connect(); }}>
          {connections.length > 0 && <label className="flex flex-col gap-1">已保存的连接<select disabled={busy} defaultValue="" className="ide-control rounded px-3 py-2" onChange={event => {
            const connection = connections.find(item => item.id === event.target.value);
            if (!connection) return;
            const next = { host: connection.host, port: String(connection.port), username: connection.username, password: connection.password };
            setHost(next.host); setPort(next.port); setUsername(next.username); setPassword(next.password); setTrust(undefined);
            settingsStorage.setItem(FORM_KEY, JSON.stringify(next));
          }}><option value="" disabled>选择已保存的服务器</option>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.username}@{connection.host}:{connection.port}</option>)}</select></label>}
          {([ ["链接 / 主机", host, setHost, "text"], ["端口", port, setPort, "number"], ["用户名", username, setUsername, "text"], ["密码", password, setPassword, "password"] ] as const).map(([label, value, setter, type]) =>
            <label key={label} className="flex flex-col gap-1">{label}<input required disabled={busy} type={type} value={value} autoComplete="off"
              min={type === "number" ? 1 : undefined} max={type === "number" ? 65535 : undefined} step={type === "number" ? 1 : undefined}
              placeholder={label === "链接 / 主机" ? "192.168.1.10 或 sftp://server:22" : undefined}
              onChange={event => {
                setter(event.target.value); setTrust(undefined);
                const field = label === "链接 / 主机" ? "host" : label === "端口" ? "port" : label === "用户名" ? "username" : "password";
                settingsStorage.setItem(FORM_KEY, JSON.stringify({ host, port, username, password, [field]: event.target.value }));
              }}
              className="ide-control rounded px-3 py-2" /></label>)}
          {trust && <div className="break-all rounded border border-ide-panel-border p-3 text-xs">请与服务器管理员核对 SSH 主机指纹（SHA-256 十六进制）：<p className="my-2 font-mono select-text">{trust}</p>确认后将发送密码进行认证。</div>}
          {error && <p role="alert" className="text-red-400">{error}</p>}
          <button disabled={busy} type="submit" className="self-end rounded ide-button ide-button-primary px-4 py-2">{busy ? "正在连接..." : trust ? "信任指纹并连接" : "连接"}</button>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
