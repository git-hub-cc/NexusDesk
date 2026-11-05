import * as Dialog from "@radix-ui/react-dialog";
import { Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTerminalStore } from "@/store/terminalStore";

export function TerminalSettings({ onClose }: { onClose: () => void }) {
  const store = useTerminalStore();
  const [profiles, setProfiles] = useState(() => store.profiles.map(profile => ({ ...profile })));
  const [defaultId, setDefaultId] = useState(store.defaultProfileId);
  const [error, setError] = useState("");
  const inputClass = "min-w-0 w-full rounded border border-ide-panel-border bg-ide-bg px-2 py-1.5 outline-none focus:border-ide-accent";

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="search-overlay" />
      <Dialog.Content className="create-name-dialog" style={{ width: "min(640px, 92vw)" }} onKeyDown={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-ide-panel-border px-4 py-3">
          <Dialog.Title>命令行工具设置</Dialog.Title>
          <Dialog.Close aria-label="关闭设置" className="p-1 hover:bg-white/10"><X size={16} /></Dialog.Close>
        </header>
        <form className="flex flex-col gap-4 p-4 text-sm" onSubmit={event => {
          event.preventDefault();
          if (!profiles.length || profiles.some(profile => !profile.name.trim())) {
            setError("请至少保留一个工具，并填写工具名称。"); return;
          }
          store.saveProfiles(profiles.map(profile => ({ ...profile, name: profile.name.trim(), command: profile.command.trim() })), defaultId);
          onClose();
        }}>
          <Dialog.Description className="text-xs text-gray-400">配置终端启动命令，例如 codex、claude。留空使用系统默认 Shell。工具需已在本机安装。</Dialog.Description>
          <div className="max-h-[45vh] space-y-3 overflow-auto">
            {profiles.map(profile => <div key={profile.id} className="flex items-center gap-2">
              <input type="radio" name="default-profile" aria-label={`默认使用 ${profile.name}`} checked={defaultId === profile.id} onChange={() => setDefaultId(profile.id)} />
              <input aria-label="工具名称" placeholder="名称" className={`${inputClass} max-w-32`} value={profile.name} onChange={event => setProfiles(items => items.map(item => item.id === profile.id ? { ...item, name: event.target.value } : item))} />
              <input aria-label={`${profile.name} 启动命令`} placeholder="系统默认 Shell" className={inputClass} value={profile.command} spellCheck={false} onChange={event => setProfiles(items => items.map(item => item.id === profile.id ? { ...item, command: event.target.value } : item))} />
              <button type="button" aria-label={`删除 ${profile.name}`} disabled={profiles.length === 1} className="p-1 disabled:opacity-30 hover:bg-white/10" onClick={() => {
                const remaining = profiles.filter(item => item.id !== profile.id);
                setProfiles(remaining);
                if (defaultId === profile.id) setDefaultId(remaining[0].id);
              }}><Trash2 size={15} /></button>
            </div>)}
          </div>
          <button type="button" className="flex items-center gap-1 self-start hover:text-white" onClick={() => setProfiles(items => [...items, { id: crypto.randomUUID(), name: "新工具", command: "" }])}><Plus size={14} />添加工具</button>
          <p className="text-xs text-gray-400">选中单选按钮设置加号默认启动的工具。修改对新会话生效。</p>
          {error && <p role="alert" className="text-red-400">{error}</p>}
          <footer className="flex justify-end gap-2">
            <Dialog.Close className="rounded border border-ide-panel-border px-3 py-1.5">取消</Dialog.Close>
            <button type="submit" className="rounded bg-ide-accent px-3 py-1.5 text-white">保存</button>
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
