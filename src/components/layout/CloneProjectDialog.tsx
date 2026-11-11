import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { fsApi, gitApi, type GitCloneAuth, type GitProvider, type GitRepository } from "@/lib/api";
import { getProjectSaveLocation, rememberProjectSaveLocation } from "@/lib/projectLocation";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { validateEntryName } from "@/components/explorer/CreateNameDialog";

interface CloneProjectDialogProps {
  onClone: (url: string, targetPath: string, auth?: GitCloneAuth) => Promise<void>;
  onClose: () => void;
}

function nameFromUrl(value: string) {
  const clean = value.trim().replace(/[?#].*$/, "").replace(/\/$/, "");
  return clean.split(/[/:\\]/).filter(Boolean).pop()?.replace(/\.git$/i, "") ?? "";
}

export function CloneProjectDialog({ onClone, onClose }: CloneProjectDialogProps) {
  const id = useId();
  const urlInput = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = useWorkspaceStore(state => state.rootPath);
  const credentialsEdited = useRef(false);
  const [provider, setProvider] = useState<GitProvider>("github");
  const [token, setToken] = useState("");
  const [repositories, setRepositories] = useState<GitRepository[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState("");

  useEffect(() => { void getProjectSaveLocation().then(setLocation).catch(() => {}); }, []);

  useEffect(() => {
    let active = true;
    if (root && !root.startsWith("sftp://")) {
      void gitApi.settings(root).then(settings => {
        if (!active || credentialsEdited.current || !settings.token) return;
        const host = /^https:\/\/([^/]+)/i.exec(settings.remote)?.[1]?.toLowerCase();
        const savedProvider = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : host === "gitee.com" ? "gitee" : null;
        if (savedProvider) { setProvider(savedProvider); setToken(settings.token); }
      }).catch(() => { /* A project without Git settings can still clone repositories. */ });
    }
    return () => { active = false; };
  }, [root]);

  useEffect(() => {
    let active = true;
    setRepositories([]); setListError(""); setLoaded(false);
    setLoading(!!token.trim());
    const timer = window.setTimeout(() => {
      if (!token.trim()) return;
      void gitApi.listRepositories(provider, token.trim()).then(values => {
        if (active) { setRepositories(values); setLoaded(true); }
      }).catch(cause => { if (active) setListError(String(cause)); })
        .finally(() => { if (active) setLoading(false); });
    }, 600);
    return () => { active = false; window.clearTimeout(timer); };
  }, [provider, token, refresh]);

  const visibleRepositories = repositories.filter(repository => repository.fullName.toLowerCase().includes(filter.trim().toLowerCase()));
  const parent = location.trim();
  const projectName = name.trim();
  const separator = parent.includes("\\") ? "\\" : "/";
  const targetPath = parent && projectName
    ? `${parent}${/[/\\]$/.test(parent) ? "" : separator}${projectName}` : "";

  const updateUrl = (value: string) => {
    setUrl(value);
    if (!name || name === nameFromUrl(url)) setName(nameFromUrl(value));
    setError("");
  };

  const browse = async () => {
    if (working.current) return;
    try {
      const selected = await fsApi.openFolderDialog(location);
      if (selected) { setLocation(selected); rememberProjectSaveLocation(selected); setError(""); }
    } catch (cause) {
      setError(`选择目录失败：${String(cause)}`);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (working.current) return;
    if (!url.trim()) { setError("请输入 Git 仓库链接"); urlInput.current?.focus(); return; }
    const invalid = !projectName ? "请输入项目名称" : validateEntryName(projectName);
    if (invalid) { setError(invalid); return; }
    if (!parent || !/^(?:[a-z]:[/\\]|\/|\\\\[^\\]+\\[^\\]+)/i.test(parent)) {
      setError("请选择或输入完整的保存目录路径"); return;
    }
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await onClone(url.trim(), targetPath, token.trim() ? { token: token.trim(), provider } : undefined);
      onClose();
    } catch (cause) {
      setError(`克隆失败：${String(cause)}`);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !working.current) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="search-overlay" />
        <Dialog.Content className="create-name-dialog" style={{ top: "5vh", width: "min(600px, 92vw)", maxHeight: "90vh", overflowY: "auto" }} onClick={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
          onOpenAutoFocus={event => { event.preventDefault(); urlInput.current?.focus(); }}
          onEscapeKeyDown={event => { if (working.current) event.preventDefault(); }}>
          <header className="flex items-center justify-between border-b border-ide-panel-border px-4 py-3">
            <Dialog.Title className="font-medium">克隆 Git 项目</Dialog.Title>
            <Dialog.Close disabled={busy} aria-label="取消克隆" className="rounded p-1 hover:bg-white/10 disabled:opacity-40"><X size={16} /></Dialog.Close>
          </header>
          <form onSubmit={event => void submit(event)} className="flex flex-col gap-3 p-4" aria-busy={busy}>
            <label htmlFor={`${id}-provider`} className="text-xs">代码托管平台</label>
            <select id={`${id}-provider`} value={provider} disabled={busy}
              onChange={event => { credentialsEdited.current = true; setProvider(event.target.value as GitProvider); setToken(""); setFilter(""); }}
              className="rounded border border-ide-panel-border bg-ide-bg px-3 py-2">
              <option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="gitee">Gitee</option>
            </select>
            <label htmlFor={`${id}-token`} className="text-xs">访问 Token</label>
            <div className="flex gap-2">
              <input id={`${id}-token`} type="password" value={token} disabled={busy} autoComplete="off" spellCheck={false}
                placeholder="输入 Token，自动列出我的项目"
                onChange={event => { credentialsEdited.current = true; setToken(event.target.value); }}
                className="min-w-0 flex-1 rounded border border-ide-panel-border bg-ide-bg px-3 py-2 outline-none focus:border-ide-accent" />
              <button type="button" disabled={busy || loading || !token.trim()} onClick={() => setRefresh(value => value + 1)}
                className="rounded border border-ide-panel-border px-3 py-2 hover:bg-white/10 disabled:opacity-40">刷新</button>
            </div>
            <p className="text-xs text-gray-400">Token 需有读取仓库的权限。留空可直接通过链接克隆；克隆成功后保存到该项目的 Git 设置。</p>
            {loading && <p role="status" className="text-xs text-gray-400">正在获取我的项目...</p>}
            {listError && <p role="alert" className="text-xs text-red-400">{listError}</p>}
            {loaded && <section className="flex flex-col gap-2" aria-label="我的项目">
              <label htmlFor={`${id}-filter`} className="text-xs">我的项目（{repositories.length}）</label>
              <input id={`${id}-filter`} value={filter} disabled={busy} placeholder="搜索项目" onChange={event => setFilter(event.target.value)}
                className="rounded border border-ide-panel-border bg-ide-bg px-3 py-2 outline-none focus:border-ide-accent" />
              <div className="max-h-40 overflow-y-auto rounded border border-ide-panel-border">
                {visibleRepositories.map(repository => <button key={repository.cloneUrl} type="button" disabled={busy}
                  aria-pressed={url === repository.cloneUrl}
                  onClick={() => { updateUrl(repository.cloneUrl); setName(nameFromUrl(repository.cloneUrl)); }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-white/10 disabled:opacity-40 ${url === repository.cloneUrl ? "bg-white/10 text-ide-accent" : ""}`}>
                  <span className="min-w-0 break-all">{repository.fullName}</span><span className="shrink-0 text-gray-400">{repository.private ? "私有" : "公开"}</span>
                </button>)}
                {!visibleRepositories.length && <p className="p-3 text-xs text-gray-400">{repositories.length ? "没有匹配的项目" : "该 Token 下没有可访问的个人项目"}</p>}
              </div>
            </section>}
            <label htmlFor={`${id}-url`} className="text-xs">Git 仓库链接</label>
            <input ref={urlInput} id={`${id}-url`} value={url} disabled={busy} autoComplete="url" spellCheck={false}
              placeholder="https:// 或 git@..."
              onChange={event => updateUrl(event.target.value)}
              className="w-full rounded border border-ide-panel-border bg-ide-bg px-3 py-2 outline-none focus:border-ide-accent disabled:opacity-60" />
            <label htmlFor={`${id}-name`} className="text-xs">项目名称</label>
            <input id={`${id}-name`} value={name} disabled={busy} autoComplete="off" spellCheck={false}
              onChange={event => { setName(event.target.value); setError(""); }}
              className="w-full rounded border border-ide-panel-border bg-ide-bg px-3 py-2 outline-none focus:border-ide-accent disabled:opacity-60" />
            <label htmlFor={`${id}-location`} className="text-xs">保存位置</label>
            <div className="flex gap-2">
              <input id={`${id}-location`} value={location} disabled={busy} autoComplete="off" spellCheck={false}
                placeholder="选择或输入父目录路径"
                onChange={event => { setLocation(event.target.value); rememberProjectSaveLocation(event.target.value); setError(""); }}
                className="min-w-0 flex-1 rounded border border-ide-panel-border bg-ide-bg px-3 py-2 outline-none focus:border-ide-accent disabled:opacity-60" />
              <button type="button" disabled={busy} onClick={() => void browse()} className="shrink-0 rounded border border-ide-panel-border px-3 py-2 hover:bg-white/10 disabled:opacity-40">浏览...</button>
            </div>
            {targetPath && <p className="break-all text-xs text-gray-400">克隆到：{targetPath}</p>}
            {busy && <p role="status" className="text-xs text-gray-400">正在克隆仓库...</p>}
            {error && <p role="alert" className="break-words text-xs text-red-400">{error}</p>}
            <footer className="mt-2 flex justify-end gap-2">
              <Dialog.Close disabled={busy} className="rounded border border-ide-panel-border px-4 py-1.5 hover:bg-white/10 disabled:opacity-40">取消</Dialog.Close>
              <button type="submit" disabled={busy || !url.trim() || !targetPath} className="rounded bg-ide-accent px-4 py-1.5 text-white disabled:opacity-40">{busy ? "正在克隆..." : "克隆"}</button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
