import { useEffect, useState } from "react";
import { codexSettingsApi } from "@/utils/api";
import { settingsStorage } from "@/utils/globalSettings";
import { AUTO_REVIEW_PROMPT_KEY, DEFAULT_AUTO_REVIEW_PROMPT } from "@/utils/codexReview";
import { readSettingsDraft, useSettingsAutosave, waitForSettingsSave } from "@/utils/useSettingsAutosave";
import { SettingsPage } from "./SettingsPage";

const DRAFT_KEY = "nexusdesk.settingsDraft:codex";
type SettingsInput = Parameters<typeof codexSettingsApi.save>[0];

export function CodexSettings() {
  const [model, setModel] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [trustMode, setTrustMode] = useState(false);
  const [showTooltips, setShowTooltips] = useState(true);
  const [checkForUpdateOnStartup, setCheckForUpdateOnStartup] = useState(true);
  const [autoReview, setAutoReview] = useState(settingsStorage.getItem("nexusdesk.codex.autoReview") === "true");
  const [autoReviewPrompt, setAutoReviewPrompt] = useState(settingsStorage.getItem(AUTO_REVIEW_PROMPT_KEY) ?? DEFAULT_AUTO_REVIEW_PROMPT);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const inputClass = "w-full min-w-0 rounded border border-ide-panel-border bg-ide-bg px-2 py-1.5 outline-none focus:border-ide-accent";

  useEffect(() => {
    let active = true;
    void waitForSettingsSave(DRAFT_KEY).then(() => codexSettingsApi.read()).then(settings => {
      if (!active) return;
      const restored = { ...settings, ...readSettingsDraft<SettingsInput>(DRAFT_KEY) };
      setModel(restored.model);
      setProxyUrl(restored.proxyUrl);
      setApiKey(restored.apiKey || "");
      setApiKeyConfigured(settings.apiKeyConfigured);
      setTrustMode(restored.trustMode);
      setShowTooltips(restored.showTooltips);
      setCheckForUpdateOnStartup(restored.checkForUpdateOnStartup);
      setLoaded(true);
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, []);

  const { busy, error: saveError } = useSettingsAutosave(DRAFT_KEY, { model, proxyUrl, apiKey: apiKey || undefined, trustMode, showTooltips, checkForUpdateOnStartup }, loaded, codexSettingsApi.save);

  useEffect(() => {
    settingsStorage.setItem("nexusdesk.codex.autoReview", String(autoReview));
    settingsStorage.setItem(AUTO_REVIEW_PROMPT_KEY, autoReviewPrompt);
    window.dispatchEvent(new Event("global-settings-changed"));
  }, [autoReview, autoReviewPrompt]);

  return <SettingsPage title="Codex" description="配置 Codex CLI 使用的模型、兼容 API 地址和 API Key。" onKeyDown={event => event.stopPropagation()}>
    <fieldset disabled={!loaded} className="flex flex-col gap-4 text-sm">
      <label className="grid gap-1">模型<input className={inputClass} value={model} onChange={event => setModel(event.target.value)} placeholder="例如 gpt-5-codex" spellCheck={false} /></label>
      <label className="grid gap-1">代理 / API 基础地址<input className={inputClass} value={proxyUrl} onChange={event => setProxyUrl(event.target.value)} placeholder="https://api.openai.com/v1（留空使用默认提供方）" spellCheck={false} /></label>
      <label className="grid gap-1">OPENAI_API_KEY<input className={inputClass} type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={apiKeyConfigured || apiKey.trim() ? "已配置；留空保留当前密钥" : "输入 API Key"} autoComplete="new-password" /></label>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5 accent-ide-accent" checked={trustMode} onChange={event => setTrustMode(event.target.checked)} />
        <span><span className="block">信任模式</span><span className="mt-0.5 block text-xs text-gray-400">允许 Codex 不受沙箱限制地访问系统。</span></span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5 accent-ide-accent" checked={autoReview} onChange={event => setAutoReview(event.target.checked)} />
        <span><span className="block">自动审核模式</span><span className="mt-0.5 block text-xs text-gray-400">开启后，在底部面板点击审核按钮，提交未忽略的变更并启动一次 Codex 变更审核。</span></span>
      </label>
      {autoReview && <label className="ml-6 grid gap-1 border-l border-ide-panel-border pl-3"><textarea aria-label="自动审核提示词" className={`${inputClass} min-h-20 resize-y`} value={autoReviewPrompt} onChange={event => setAutoReviewPrompt(event.target.value)} placeholder={DEFAULT_AUTO_REVIEW_PROMPT} spellCheck={false} />
          <span className="text-xs text-gray-400">提交编号会自动附加在提示词前。</span>
        </label>}
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5 accent-ide-accent" checked={showTooltips} onChange={event => setShowTooltips(event.target.checked)} />
        <span><span className="block">显示提示信息</span><span className="mt-0.5 block text-xs text-gray-400">控制 Codex TUI 是否显示提示信息。</span></span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5 accent-ide-accent" checked={checkForUpdateOnStartup} onChange={event => setCheckForUpdateOnStartup(event.target.checked)} />
        <span><span className="block">启动时检查新版本</span><span className="mt-0.5 block text-xs text-gray-400">控制 Codex 启动时是否显示版本更新提示。</span></span>
      </label>
      {(error || saveError) && <p role="alert" className="break-all text-red-400">{error || saveError}</p>}
      {busy && <p className="text-xs text-gray-400" role="status">正在保存…</p>}
    </fieldset>
  </SettingsPage>;
}
