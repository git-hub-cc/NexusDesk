import { useEffect, useState } from "react";
import { gitApi, type GitSettings as GitSettingsValue } from "@/lib/api";
import { readSettingsDraft, useSettingsAutosave, waitForSettingsSave } from "@/lib/useSettingsAutosave";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { SettingsPage } from "./SettingsPage";

export function GitSettings() {
  const root = useWorkspaceStore(state => state.rootPath);
  const [remote, setRemote] = useState("");
  const [proxy, setProxy] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loadedRoot, setLoadedRoot] = useState<string | null>(null);
  const draftKey = `nexusdesk.settingsDraft:git:${root}`;
  const inputClass = "w-full min-w-0 rounded border border-ide-panel-border bg-ide-bg px-2 py-1.5 outline-none focus:border-ide-accent";

  useEffect(() => {
    let active = true;
    setLoadedRoot(null);
    if (root) void waitForSettingsSave(draftKey).then(() => gitApi.settings(root)).then(value => {
      if (!active) return;
      const restored = { ...value, ...readSettingsDraft<GitSettingsValue>(draftKey) };
      setRemote(restored.remote); setProxy(restored.proxy); setToken(restored.token); setLoadedRoot(root);
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [root]);

  const { busy, error: saveError } = useSettingsAutosave(draftKey, { remote, proxy, token }, !!root && loadedRoot === root, async value => {
    await gitApi.saveSettings(root!, value);
    window.dispatchEvent(new Event("git-settings-changed"));
  });

  return <SettingsPage title="版本控制" description="配置当前项目的 Git 远程地址、代理和访问凭据。" onKeyDown={event => event.stopPropagation()}>
        <fieldset disabled={!root || loadedRoot !== root} className="flex flex-col gap-4 text-sm">
          {!root && <p className="text-amber-400">请先打开一个项目。</p>}
          <label className="grid gap-1">当前项目远程地址<input className={inputClass} value={remote} onChange={event => setRemote(event.target.value)} placeholder="https://... 或 git@..." spellCheck={false} /></label>
          <label className="grid gap-1">Git 代理<input className={inputClass} value={proxy} onChange={event => setProxy(event.target.value)} placeholder="http://127.0.0.1:7890（留空关闭）" spellCheck={false} /></label>
          <label className="grid gap-1">访问 Token<input className={inputClass} type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="留空保留已保存 Token" autoComplete="new-password" /></label>
          <p className="text-xs text-gray-400">远程地址和代理保存在项目 Git 配置；Token 保存在本机应用配置，不会写入远程地址。</p>
          {(error || saveError) && <p role="alert" className="text-red-400 break-all">{error || saveError}</p>}
          {root && <p className="text-xs text-gray-400" role="status">{busy ? "正在保存…" : "修改会自动保存并生效"}</p>}
        </fieldset>
      </SettingsPage>;
}
