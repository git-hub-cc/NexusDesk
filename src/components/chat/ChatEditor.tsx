import { useEffect, useRef, useState } from "react";
import { LoaderCircle, MessageCircle, Plus, Send } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { chatApi, codexSettingsApi, type CodexSettings } from "@/lib/api";

type Message = { role: "user" | "assistant"; content: string };

export function ChatEditor({ active }: { active: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<CodexSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const conversation = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void codexSettingsApi.read().then(value => { if (!disposed) setSettings(value); })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [active]);

  useEffect(() => {
    const container = conversation.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages, busy]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = input.trim();
    if (!content || busy) return;
    const next = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError("");
    const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const assistantIndex = next.length;
    let reply = "";
    setMessages([...next, { role: "assistant", content: "" }]);
    const unlisten = await listen<string>(`chat-stream-${requestId}`, event => {
      reply += event.payload;
      setMessages(current => {
        const updated = [...current];
        updated[assistantIndex] = { role: "assistant", content: reply };
        return updated;
      });
    });
    const unlistenDone = await listen(`chat-stream-done-${requestId}`, () => { void unlisten(); void unlistenDone(); });
    const unlistenError = await listen<string>(`chat-stream-error-${requestId}`, event => setError(event.payload));
    try {
      await chatApi.complete(requestId, next.slice(-40));
    } catch (reason) {
      setError(String(reason).replace(/^Error: /, ""));
    } finally {
      void unlisten();
      void unlistenDone();
      void unlistenError();
      setBusy(false);
      composer.current?.focus();
    }
  };

  return <div className={`chat-page absolute inset-0 flex flex-col bg-ide-bg text-gray-200 ${active ? "" : "hidden"}`}>
    <header className="chat-header">
      <div className="chat-heading"><MessageCircle size={16} /><div><h2>对话</h2><p>{settings?.model || "使用 Codex 设置中的模型"}</p></div></div>
      <div className="chat-header-actions">
        <span className={`chat-config-state ${settings ? "is-ready" : ""}`} title={settings?.apiKeyConfigured ? "API 密钥已配置" : "未检测到 API 密钥；无需鉴权的兼容接口仍可使用"}>
          <span />{settings ? "配置已读取" : "读取配置中"}
        </span>
        <button type="button" className="chat-icon-button" title="新对话" aria-label="新对话" disabled={!messages.length || busy} onClick={() => { setMessages([]); setError(""); composer.current?.focus(); }}><Plus size={16} /></button>
      </div>
    </header>
    <main className="chat-conversation" ref={conversation} aria-live="polite">
      {!messages.length && <div className="chat-empty"><MessageCircle size={24} /><h3>开始新对话</h3><p>使用 Codex 设置中的 API 地址与模型发送对话请求。</p></div>}
      {messages.map((message, index) => <article key={`${index}-${message.role}`} className={`chat-message ${message.role === "user" ? "is-user" : "is-assistant"}`}>
        <div className="chat-message-label">{message.role === "user" ? "你" : "助手"}</div>
        <p>{message.content}</p>
      </article>)}
      {busy && <div className="chat-working"><LoaderCircle size={14} className="animate-spin" />正在生成回复…</div>}
      {error && <p className="chat-error" role="alert">{error}</p>}
    </main>
    <form className="chat-composer" onSubmit={event => void send(event)}>
      <textarea ref={composer} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
      }} placeholder="发送消息…" aria-label="消息内容" rows={3} disabled={busy} />
      <div className="chat-composer-footer"><span>Shift + Enter 换行</span><button type="submit" title="发送消息" aria-label="发送消息" disabled={busy || !input.trim()}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}</button></div>
    </form>
  </div>;
}
