import { useState } from "react";
import { settingsStorage } from "@/lib/globalSettings";
import { readSpeechPreferences, speechPreferencesKey, speechModels as models, speechLanguages as languages, type SpeechPreferences } from "@/lib/speechPreferences";

export function SpeechRecognitionSettings() {
  const [preferences, setPreferences] = useState(readSpeechPreferences);
  const selectClass = "w-full min-w-0 rounded border border-ide-panel-border bg-ide-bg px-2 py-1.5 outline-none focus:border-ide-accent";
  const update = (next: SpeechPreferences) => {
    setPreferences(next);
    settingsStorage.setItem(speechPreferencesKey, JSON.stringify(next));
  };
  const updateNumber = (key: "minVolume" | "minDurationSeconds" | "minTextLength", value: number) => {
    if (!Number.isFinite(value)) return;
    const bounds = {
      minVolume: [0.005, 0.1],
      minDurationSeconds: [0.1, 5],
      minTextLength: [1, 20],
    }[key];
    const bounded = Math.min(bounds[1], Math.max(bounds[0], value));
    update({ ...preferences, [key]: key === "minTextLength" ? Math.round(bounded) : bounded });
  };

  return <div className="mx-auto w-full max-w-3xl p-8" onKeyDown={event => event.stopPropagation()}>
    <header className="mb-6 border-b border-ide-panel-border pb-4">
      <h2 className="text-xl font-semibold">语音识别</h2>
      <p className="mt-1 text-sm text-gray-400">使用 SenseVoice 在本地识别语音，支持中文、粤语、英语、日语和韩语。</p>
    </header>
    <div className="flex flex-col gap-5 text-sm">
      <label className="grid gap-1">识别语言<select className={selectClass} value={preferences.language} onChange={event => update({ ...preferences, language: event.target.value })}>
        {languages.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <p className="-mt-4 text-xs text-gray-400">英文识别效果较差时，将识别语言设为“英语”，可避免自动检测对短英文片段判断不准。</p>
      <label className="grid gap-1">识别模型<select className={selectClass} value={preferences.model} onChange={event => update({ ...preferences, model: event.target.value })}>
        {models.map(item => <option key={item.id} value={item.id}>{item.label} — {item.detail}</option>)}
      </select></label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1">最低音量（RMS）<input className={selectClass} type="number" min="0.005" max="0.1" step="0.001" value={preferences.minVolume} onChange={event => updateNumber("minVolume", event.currentTarget.valueAsNumber)} /><span className="text-xs text-gray-400">低于此音量的声音会忽略。</span></label>
        <label className="grid gap-1">最短语音时长（秒）<input className={selectClass} type="number" min="0.1" max="5" step="0.1" value={preferences.minDurationSeconds} onChange={event => updateNumber("minDurationSeconds", event.currentTarget.valueAsNumber)} /><span className="text-xs text-gray-400">过短的录音片段不会识别。</span></label>
        <label className="grid gap-1">最少识别字符数<input className={selectClass} type="number" min="1" max="20" step="1" value={preferences.minTextLength} onChange={event => updateNumber("minTextLength", event.currentTarget.valueAsNumber)} /><span className="text-xs text-gray-400">识别结果不足此长度时会丢弃。</span></label>
      </div>
      <p className="text-xs text-gray-400">模型首次使用时自动下载，之后可离线识别；当前使用 CPU 推理。</p>
      <div className="rounded border border-ide-panel-border bg-ide-bg p-3">
        <h3 className="font-medium">全局跨应用语音输入（Windows）</h3>
        <p className="mt-2 text-xs leading-relaxed text-gray-400">点击左侧边栏的语音转文字按钮即可开启或关闭语音识别。悬浮窗显示录音状态，每段转写完成后自动填入当前输入光标处；切换输入框可继续输入。</p>
        <p className="mt-2 text-xs leading-relaxed text-gray-400">目标位置需要支持文本粘贴；仅悬停鼠标不会建立文字插入光标。自动填入会使用系统剪贴板；向以管理员身份运行的应用输入时，需要以相同权限运行 NoteIDE。</p>
      </div>
      <label className="flex items-start gap-2"><input className="mt-1 accent-ide-accent" type="checkbox" checked={preferences.filterNoise} onChange={event => update({ ...preferences, filterNoise: event.target.checked })} /><span>过滤杂音标记<span className="mt-1 block text-xs text-gray-400">忽略音乐、掌声、静音等非语音标记。</span></span></label>
      <p className="text-xs text-gray-500">设置会立即保存，并在下次开启语音转文字时生效。</p>
    </div>
  </div>;
}
