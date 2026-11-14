import { Plus, Trash2 } from "lucide-react";
import { DEFAULT_HISTORY_TRANSPARENCY, useTerminalStore } from "@/store/terminalStore";

export function TerminalSettings() {
  const store = useTerminalStore();
  const profiles = store.profiles;
  const inputClass = "min-w-0 w-full rounded border border-ide-panel-border bg-ide-bg px-2 py-1.5 outline-none focus:border-ide-accent";

  return <section className="mx-auto w-full max-w-3xl space-y-6 p-5 text-sm">
    <header className="border-b border-ide-panel-border pb-4">
      <h2 className="text-xl font-semibold">终端</h2>
      <p className="mt-1 text-sm text-gray-400">配置提示历史的显示效果和命令行工具。</p>
    </header>
    <section className="space-y-3" aria-labelledby="terminal-history-heading">
      <h3 id="terminal-history-heading" className="font-medium">提示历史</h3>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="terminal-history-transparency">提示历史透明度</label>
        <output htmlFor="terminal-history-transparency" className="tabular-nums text-gray-400">{store.historyTransparency}%</output>
      </div>
      <input id="terminal-history-transparency" type="range" min={0} max={80} step={5} value={store.historyTransparency} onChange={event => store.setHistoryTransparency(Number(event.target.value))} aria-describedby="terminal-history-help" className="w-full accent-ide-accent" />
      <p id="terminal-history-help" className="text-xs text-gray-400">历史提示悬浮在终端内容上方。数值越大，背景越透明，文字保持清晰；0% 为背景完全不透明，默认为 {DEFAULT_HISTORY_TRANSPARENCY}%。修改会自动保存并立即生效。</p>
      <div aria-label="提示历史预览" className="relative overflow-hidden rounded border border-ide-panel-border bg-[#2b2d30] p-3">
        <div aria-label="模拟终端输入" className="space-y-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-gray-300">
          <p><span className="text-green-400">PS C:\Projects\NexusDesk&gt;</span> git status</p>
          <p className="text-gray-400">On branch main</p>
          <p className="text-gray-400">nothing to commit, working tree clean</p>
          <p className="pt-2"><span className="text-green-400">PS C:\Projects\NexusDesk&gt;</span> git log --oneline -3</p>
          <p className="text-gray-400">a1b2c3d Update terminal settings</p>
          <p className="text-gray-400">e4f5a6b Add command history</p>
          <p className="text-gray-400">c7d8e9f Initial commit</p>
          <p className="pt-2"><span className="text-green-400">PS C:\Projects\NexusDesk&gt;</span> git<span aria-hidden="true" className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 bg-gray-300" /></p>
        </div>
        <div className="absolute inset-x-2 bottom-8 rounded border border-white/10 p-2 shadow-lg" style={{ backgroundColor: `rgba(43, 45, 48, ${1 - store.historyTransparency / 100})`, textShadow: "0 1px 2px #000" }}>
          <div className="mb-1 flex justify-between text-[10px] text-gray-300"><span>命令历史 · 单击回填，双击执行</span><span>2 条</span></div>
          <p className="px-2 py-0.5 font-mono text-xs text-gray-300"><mark className="bg-transparent text-amber-300">git</mark> status</p>
          <p className="px-2 py-0.5 font-mono text-xs text-gray-300"><mark className="bg-transparent text-amber-300">git</mark> diff</p>
        </div>
      </div>
      <button type="button" className="rounded border border-ide-panel-border px-3 py-1.5 hover:bg-white/5" onClick={() => store.setHistoryTransparency(DEFAULT_HISTORY_TRANSPARENCY)}>恢复默认透明度</button>
    </section>
    <section className="space-y-3 border-t border-ide-panel-border pt-5" aria-labelledby="terminal-tools-heading">
      <h3 id="terminal-tools-heading" className="font-medium">命令行工具设置</h3>
        <div className="flex flex-col gap-4">
          <p className="text-xs text-gray-400">配置终端启动命令，例如 codex、claude。留空使用系统默认 Shell。工具需已在本机安装。修改会自动保存，对新会话生效。</p>
          <div className="max-h-[45vh] space-y-3 overflow-auto">
            {profiles.map(profile => <div key={profile.id} className="flex items-center gap-2">
              <input aria-label="工具名称" placeholder="名称" className={`${inputClass} max-w-32`} value={profile.name} onChange={event => {
                store.saveProfiles(profiles.map(item => item.id === profile.id ? { ...item, name: event.target.value } : item));
              }} />
              <input aria-label={`${profile.name} 启动命令`} placeholder="系统默认 Shell" className={inputClass} value={profile.command} spellCheck={false} onChange={event => {
                store.saveProfiles(profiles.map(item => item.id === profile.id ? { ...item, command: event.target.value } : item));
              }} />
              <button type="button" aria-label={`删除 ${profile.name}`} disabled={profiles.length === 1} className="p-1 disabled:opacity-30 hover:bg-white/10" onClick={() => {
                const remaining = profiles.filter(item => item.id !== profile.id);
                store.saveProfiles(remaining);
              }}><Trash2 size={15} /></button>
            </div>)}
          </div>
          <button type="button" className="flex items-center gap-1 self-start hover:text-white" onClick={() => {
            store.saveProfiles([...profiles, { id: crypto.randomUUID(), name: "新工具", command: "" }]);
          }}><Plus size={14} />添加工具</button>
          {profiles.some(profile => !profile.name.trim()) && <p role="alert" className="text-red-400">请填写工具名称。</p>}
        </div>
    </section>
  </section>;
}
