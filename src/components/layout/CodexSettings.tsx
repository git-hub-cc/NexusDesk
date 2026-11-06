import { useEffect, useRef, useState } from "react";
import { codexSettingsApi } from "@/lib/api";
import { settingsStorage } from "@/lib/globalSettings";
import { AUTO_REVIEW_PROMPT_KEY, DEFAULT_AUTO_REVIEW_PROMPT } from "@/lib/codexReview";

export function CodexSettings() {
  const [model, setModel] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [trustMode, setTrustMode] = useState(false);
  const [autoReview, setAutoReview] = useState(settingsStorage.getItem("nexusdesk.codex.autoReview") === "true");
  const [autoReviewPrompt, setAutoReviewPrompt] = useState(settingsStorage.getItem(AUTO_REVIEW_PROMPT_KEY) ?? DEFAULT_AUTO_REVIEW_PROMPT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loaded = useRef(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveVersion = useRef(0);
  const inputClass = "w-full min-w-0 rounded border border-ide-panel-border bg-ide-bg px-2 py-1.5 outline-none focus:border-ide-accent";

  useEffect(() => {
    loaded.current = false;
    void codexSettingsApi.read().then(settings => {
      setModel(settings.model);
      setProxyUrl(settings.proxyUrl);
      setApiKeyConfigured(settings.apiKeyConfigured);
      setTrustMode(settings.trustMode);
      loaded.current = true;
    }).catch(reason => setError(String(reason)));
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    const timer = window.setTimeout(async () => {
      const version = ++saveVersion.current;
      setBusy(true);
      setError("");
      const save = () => codexSettingsApi.save({ model, proxyUrl, apiKey: apiKey || undefined, trustMode });
      const currentSave = saveQueue.current.catch(() => {}).then(save);
      saveQueue.current = currentSave;
      void currentSave.then(() => {
        if (version !== saveVersion.current) return;
        if (apiKey.trim()) setApiKeyConfigured(true);
      }).catch(reason => {
        if (version === saveVersion.current) setError(String(reason));
      }).finally(() => {
        if (version === saveVersion.current) setBusy(false);
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [model, proxyUrl, apiKey, trustMode]);

  useEffect(() => {
    settingsStorage.setItem("nexusdesk.codex.autoReview", String(autoReview));
    settingsStorage.setItem(AUTO_REVIEW_PROMPT_KEY, autoReviewPrompt);
    window.dispatchEvent(new Event("global-settings-changed"));
  }, [autoReview, autoReviewPrompt]);

  return <div className="mx-auto w-full max-w-3xl p-8" onKeyDown={event => event.stopPropagation()}>
    <header className="mb-6 border-b border-ide-panel-border pb-4">
      <h2 className="text-xl font-semibold">Codex</h2>
      <p className="mt-1 text-sm text-gray-400">配置 Codex CLI 使用的模型、兼容 API 地址和 API Key。</p>
    </header>
    <div className="flex flex-col gap-4 text-sm">
      <label className="grid gap-1">模型<input className={inputClass} value={model} onChange={event => setModel(event.target.value)} placeholder="例如 gpt-5-codex" spellCheck={false} /></label>
      <label className="grid gap-1">代理 / API 基础地址<input className={inputClass} value={proxyUrl} onChange={event => setProxyUrl(event.target.value)} placeholder="https://api.openai.com/v1（留空使用默认提供方）" spellCheck={false} /></label>
      <label className="grid gap-1">OPENAI_API_KEY<input className={inputClass} type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={apiKeyConfigured ? "已配置；留空保留当前密钥" : "输入 API Key"} autoComplete="new-password" /></label>
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
      {error && <p role="alert" className="break-all text-red-400">{error}</p>}
      {busy && <p className="text-xs text-gray-400" role="status">正在保存…</p>}
    </div>
  </div>;
}
