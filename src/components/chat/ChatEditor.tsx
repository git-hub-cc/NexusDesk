import { useEffect, useRef, useState } from "react";
import { LoaderCircle, MessageCircle, Plus, Send, Settings2, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { chatApi, codexSettingsApi, type ChatOverrides, type CodexSettings } from "@/lib/api";

type Message = { role: "user" | "assistant"; content: string };

export function ChatEditor({ active }: { active: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<CodexSettings | null>(null);
  const [overrides, setOverrides] = useState<ChatOverrides>({});
  const [showConfig, setShowConfig] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const conversation = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const conversationScroll = useRef({ top: 0, atBottom: true });

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void codexSettingsApi.read().then(value => { if (!disposed) setSettings(value); }).catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [active]);
  useEffect(() => {
    const container = conversation.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    conversationScroll.current = { top: container.scrollTop, atBottom: true };
  }, [messages, busy]);

  useEffect(() => {
    const container = conversation.current;
    if (!container) return;
    const rememberScroll = () => {
      const distanceFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
      conversationScroll.current = { top: container.scrollTop, atBottom: distanceFromBottom <= 24 };
    };
    const restoreScroll = () => {
      const saved = conversationScroll.current;
      requestAnimationFrame(() => {
        if (saved.atBottom) container.scrollTop = container.scrollHeight;
        else container.scrollTop = saved.top;
      });
    };
    const observer = new ResizeObserver(restoreScroll);
    container.addEventListener("scroll", rememberScroll, { passive: true });
    observer.observe(container);
    rememberScroll();
    return () => {
      container.removeEventListener("scroll", rememberScroll);
      observer.disconnect();
    };
  }, []);
  const updateOverride = (key: keyof ChatOverrides, value: string) => setOverrides(current => ({ ...current, [key]: value || undefined }));

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = input.trim();
    if (!content || busy) return;
    const previousMessages = messages;
    const next = [...messages, { role: "user" as const, content }];
    setMessages([...next, { role: "assistant", content: "" }]); setInput(""); setBusy(true); setError("");
    const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`; const assistantIndex = next.length; let reply = ""; let streamFailed = false; let streamError = "";
    const unlisten = await listen<string>(`chat-stream-${requestId}`, event => { reply += event.payload; setMessages(current => current.map((message, index) => index === assistantIndex ? { ...message, content: reply } : message)); });
    const unlistenDone = await listen(`chat-stream-done-${requestId}`, () => { void unlisten(); void unlistenDone(); });
    const unlistenError = await listen<string>(`chat-stream-error-${requestId}`, event => { streamFailed = true; streamError = event.payload; setError(event.payload); });
    try { await chatApi.complete(requestId, next.slice(-40), overrides); }
    catch (reason) { streamFailed = true; streamError = String(reason).replace(/^Error: /, ""); setError(streamError); }
    finally {
      void unlisten(); void unlistenDone(); void unlistenError();
      if (streamFailed || !reply.trim()) {
        setMessages(previousMessages);
        if (!streamError) setError("AI 未返回有效内容，请检查接口格式后重试");
      }
      setBusy(false); composer.current?.focus();
    }
  };

  return <div className={`chat-page absolute inset-0 flex flex-col bg-ide-bg text-gray-200 ${active ? "" : "hidden"}`}>
    <header className="chat-header"><div className="chat-heading"><MessageCircle size={16} /><div><h2>对话</h2><p>{overrides.model || settings?.model || "使用 Codex 设置中的模型"}</p></div></div><div className="chat-header-actions"><span className={`chat-config-state ${settings ? "is-ready" : ""}`}><span />{settings ? "配置已读取" : "读取配置中"}</span><button type="button" className="chat-icon-button" title="对话设置" aria-label="对话设置" onClick={() => setShowConfig(value => !value)}><Settings2 size={16} /></button><button type="button" className="chat-icon-button" title="新对话" aria-label="新对话" disabled={!messages.length || busy} onClick={() => { setMessages([]); setError(""); composer.current?.focus(); }}><Plus size={16} /></button></div></header>
    {showConfig && <section className="chat-config-panel" aria-label="对话请求设置"><div className="chat-config-title"><strong>请求设置</strong><button type="button" className="chat-icon-button" title="关闭" aria-label="关闭" onClick={() => setShowConfig(false)}><X size={15} /></button></div><label>API 地址<input value={overrides.api ?? ""} onChange={event => updateOverride("api", event.target.value)} placeholder={settings?.proxyUrl || "留空使用当前 API 地址"} spellCheck={false} /></label><label>API Key<input type="password" value={overrides.key ?? ""} onChange={event => updateOverride("key", event.target.value)} placeholder={settings?.apiKeyConfigured ? "留空保留当前 Key" : "留空使用当前 Key"} autoComplete="new-password" /></label><label>模型<input value={overrides.model ?? ""} onChange={event => updateOverride("model", event.target.value)} placeholder={settings?.model || "留空使用当前模型"} spellCheck={false} /></label><label>提示参数格式<select value={overrides.format ?? ""} onChange={event => updateOverride("format", event.target.value)}><option value="">留空使用当前格式</option><option value="responses">Responses（input）</option><option value="chat">Chat Completions（messages）</option></select></label><p className="chat-config-hint">空字段保持现有配置，仅对后续消息生效。</p></section>}
    <main className="chat-conversation" ref={conversation} aria-live="polite">{!messages.length && <div className="chat-empty"><MessageCircle size={24} /><h3>开始新对话</h3><p>可在右上角修改本次请求的 API、Key、模型和提示参数格式。</p></div>}{messages.map((message, index) => <article key={`${index}-${message.role}`} className={`chat-message ${message.role === "user" ? "is-user" : "is-assistant"}`}><div className="chat-message-label">{message.role === "user" ? "你" : "助手"}</div><p>{message.content}</p></article>)}{busy && <div className="chat-working"><LoaderCircle size={14} className="animate-spin" />正在生成回复…</div>}{error && <p className="chat-error" role="alert">{error}</p>}</main>
    <form className="chat-composer" onSubmit={event => void send(event)}><textarea ref={composer} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="发送消息…" aria-label="消息内容" rows={3} disabled={busy} /><div className="chat-composer-footer"><span>Shift + Enter 换行</span><button type="submit" title="发送消息" aria-label="发送消息" disabled={busy || !input.trim()}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}</button></div></form>
  </div>;
}
