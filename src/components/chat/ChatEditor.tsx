import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, GitBranch, LoaderCircle, MessageCircle, Pencil, Plus, Save, Send, Settings2, Trash2, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { chatApi, codexSettingsApi, type ChatOverrides, type CodexSettings } from "@/lib/api";

type Message = { role: "user" | "assistant"; content: string };
type SavedConversation = { id: string; title: string; messages: Message[]; savedAt: number };
const HISTORY_KEY = "nexusdesk-chat-history-v1";

function readHistory(): SavedConversation[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter(item => item && typeof item.id === "string" && Array.isArray(item.messages)) : [];
  } catch { return []; }
}

function conversationTitle(messages: Message[]) {
  return messages.find(message => message.role === "user")?.content.slice(0, 48) || "未命名对话";
}

export function ChatEditor({ active }: { active: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<SavedConversation[]>(readHistory);
  const historyRef = useRef(history);
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<CodexSettings | null>(null);
  const [overrides, setOverrides] = useState<ChatOverrides>({ format: "responses" });
  const [showConfig, setShowConfig] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [selectedMessages, setSelectedMessages] = useState<number[]>([]);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
    const syncHistory = (event: StorageEvent) => {
      if (event.key !== HISTORY_KEY) return;
      const latest = readHistory();
      historyRef.current = latest;
      setHistory(latest);
    };
    window.addEventListener("storage", syncHistory);
    return () => window.removeEventListener("storage", syncHistory);
  }, []);
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
      requestAnimationFrame(() => { if (saved.atBottom) container.scrollTop = container.scrollHeight; else container.scrollTop = saved.top; });
    };
    const observer = new ResizeObserver(restoreScroll);
    container.addEventListener("scroll", rememberScroll, { passive: true });
    observer.observe(container);
    rememberScroll();
    return () => { container.removeEventListener("scroll", rememberScroll); observer.disconnect(); };
  }, []);

  const updateOverride = (key: keyof ChatOverrides, value: string) => setOverrides(current => ({ ...current, [key]: value || undefined }));
  const updateHistory = async (update: (current: SavedConversation[]) => SavedConversation[]) => {
    const write = () => {
      const next = update(readHistory());
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      historyRef.current = next;
      setHistory(next);
    };
    try {
      if (navigator.locks) await navigator.locks.request(`${HISTORY_KEY}-write`, write);
      else write();
      return true;
    } catch {
      setError("对话历史保存失败，请检查本机存储空间");
      return false;
    }
  };
  const saveSnapshot = (savedMessages: Message[], title = conversationTitle(savedMessages)) => {
    if (!savedMessages.length) return;
    const entry = { id: crypto.randomUUID(), title: title.trim() || "未命名对话", messages: savedMessages, savedAt: Date.now() };
    void updateHistory(current => [entry, ...current]);
    setNotice("对话已保存");
  };
  const openSaveDialog = (throughIndex = messages.length - 1) => {
    setSelectedMessages(messages.map((_, index) => index).filter(index => index <= throughIndex));
    setSaveOpen(true);
  };
  const openRenameDialog = (item: SavedConversation) => {
    setRenameTarget(item.id);
    setRenameValue(item.title);
  };
  const renameConversation = () => {
    const title = renameValue.trim();
    if (!renameTarget || !title) return;
    void updateHistory(current => current.map(item => item.id === renameTarget ? { ...item, title } : item));
    setRenameTarget(null);
  };
  const deleteConversation = async (item: SavedConversation) => {
    if (!await updateHistory(current => current.filter(entry => entry.id !== item.id))) return;
    if (activeHistoryId === item.id) {
      setMessages([]);
      setActiveHistoryId(null);
      setError("");
      setNotice("");
    }
  };
  const branchAt = (index: number) => {
    if (busy) return;
    saveSnapshot(messages);
    setMessages(messages.slice(0, index + 1));
    setActiveHistoryId(null);
    setError("");
    setInput("");
    setNotice("已基于此回复创建分支");
    composer.current?.focus();
  };
  const copyReply = async (content: string) => {
    try { await navigator.clipboard.writeText(content); setNotice("回复已复制"); }
    catch { setError("复制失败，请检查剪贴板权限"); }
  };
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = input.trim();
    if (!content || busy) return;
    const previousMessages = messages;
    const next = [...messages, { role: "user" as const, content }];
    setActiveHistoryId(null);
    setMessages([...next, { role: "assistant", content: "" }]); setInput(""); setBusy(true); setError(""); setNotice("");
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

  return <div className={`chat-page absolute inset-0 flex bg-ide-bg text-gray-200 ${active ? "" : "hidden"}`}>
    <aside className="chat-history" aria-label="保存的对话">
      <div className="chat-history-heading"><strong>历史记录</strong></div>
      <div className="chat-history-list">{history.map(item => <div className={`chat-history-row ${activeHistoryId === item.id ? "is-active" : ""}`} key={item.id}><button type="button" className="chat-history-item" title={item.title} onClick={() => { setMessages(item.messages); setActiveHistoryId(item.id); setError(""); setNotice(""); }}><span>{item.title}</span><small>{new Date(item.savedAt).toLocaleString()}</small></button><button type="button" className="chat-icon-button chat-history-rename" title="重命名对话" aria-label={`重命名对话：${item.title}`} onClick={() => openRenameDialog(item)}><Pencil size={13} /></button><button type="button" className="chat-icon-button chat-history-delete" title="删除对话" aria-label={`删除对话：${item.title}`} onClick={() => void deleteConversation(item)}><Trash2 size={13} /></button></div>)}{!history.length && <p className="chat-history-empty">保存或创建分支后，对话会显示在这里。</p>}</div>
    </aside>
    <section className="chat-workspace">
      <header className="chat-header"><div className="chat-heading"><MessageCircle size={16} /><div><h2>对话</h2><p>{overrides.model || settings?.model || "使用 Codex 设置中的模型"}</p></div></div><div className="chat-header-actions"><span className={`chat-config-state ${settings ? "is-ready" : ""}`}><span />{settings ? "配置已读取" : "读取配置中"}</span><button type="button" className="chat-icon-button" title="对话设置" aria-label="对话设置" onClick={() => setShowConfig(value => !value)}><Settings2 size={16} /></button><button type="button" className="chat-icon-button" title="新对话" aria-label="新对话" disabled={!messages.length || busy} onClick={() => { setMessages([]); setActiveHistoryId(null); setError(""); setNotice(""); composer.current?.focus(); }}><Plus size={16} /></button></div></header>
      {showConfig && <section className="chat-config-panel" aria-label="对话请求设置"><div className="chat-config-title"><strong>请求设置</strong><button type="button" className="chat-icon-button" title="关闭" aria-label="关闭" onClick={() => setShowConfig(false)}><X size={15} /></button></div><label>API 地址<input value={overrides.api ?? ""} onChange={event => updateOverride("api", event.target.value)} placeholder={settings?.proxyUrl || "留空使用当前 API 地址"} spellCheck={false} /></label><label>API Key<input type="password" value={overrides.key ?? ""} onChange={event => updateOverride("key", event.target.value)} placeholder="sk-xxx" autoComplete="new-password" /></label><label>模型<input value={overrides.model ?? ""} onChange={event => updateOverride("model", event.target.value)} placeholder={settings?.model || "留空使用当前模型"} spellCheck={false} /></label><label>参数格式<select value={overrides.format ?? "responses"} onChange={event => updateOverride("format", event.target.value)}><option value="responses">Responses（input）</option><option value="chat">Chat Completions（messages）</option></select></label><p className="chat-config-hint">参数格式仅对后续消息生效。</p></section>}
      <main className="chat-conversation" ref={conversation} aria-live="polite">{!messages.length && <div className="chat-empty"><MessageCircle size={24} /><h3>开始新对话</h3><p>可在右上角修改本次请求的 API、Key、模型和提示参数格式。</p></div>}{messages.map((message, index) => <article key={`${index}-${message.role}`} className={`chat-message ${message.role === "user" ? "is-user" : "is-assistant"}`}><div className="chat-message-label">{message.role === "user" ? "你" : "助手"}</div><p>{message.content}</p>{message.role === "assistant" && message.content && <div className="chat-message-actions"><button type="button" className="chat-icon-button" title="复制回复" aria-label="复制回复" onClick={() => void copyReply(message.content)}><Copy size={14} /></button><button type="button" className="chat-icon-button" title="保存对话" aria-label="保存对话" disabled={busy} onClick={() => openSaveDialog(index)}><Save size={14} /></button><button type="button" className="chat-icon-button" title="从此处分支" aria-label="从此处分支" disabled={busy} onClick={() => branchAt(index)}><GitBranch size={14} /></button></div>}</article>)}{busy && <div className="chat-working"><LoaderCircle size={14} className="animate-spin" />正在生成回复…</div>}{(error || notice) && <p className={error ? "chat-error" : "chat-notice"} role={error ? "alert" : "status"}>{error || notice}</p>}</main>
      <form className="chat-composer" onSubmit={event => void send(event)}><textarea ref={composer} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="发送消息…" aria-label="消息内容" rows={3} disabled={busy} /><div className="chat-composer-footer"><span>Shift + Enter 换行</span><button type="submit" title="发送消息" aria-label="发送消息" disabled={busy || !input.trim()}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}</button></div></form>
    </section>
    <Dialog.Root open={saveOpen} onOpenChange={setSaveOpen}><Dialog.Portal><Dialog.Overlay className="search-overlay" /><Dialog.Content className="create-name-dialog chat-save-dialog" onKeyDown={event => event.stopPropagation()}>
      <header><div><Dialog.Title>保存对话</Dialog.Title><Dialog.Description>选择要保存的对话内容</Dialog.Description></div><Dialog.Close className="chat-icon-button" aria-label="关闭"><X size={16} /></Dialog.Close></header>
      <div className="chat-save-actions"><button type="button" onClick={() => setSelectedMessages(messages.map((_, index) => index))}>全选</button><button type="button" onClick={() => setSelectedMessages([])}>清空</button></div>
      <div className="chat-save-list">{messages.map((message, index) => <label key={`${index}-${message.role}`}><input type="checkbox" checked={selectedMessages.includes(index)} onChange={event => setSelectedMessages(current => event.target.checked ? [...current, index].sort((a, b) => a - b) : current.filter(item => item !== index))} /><span><strong>{message.role === "user" ? "你" : "助手"}</strong><span>{message.content || "（暂无内容）"}</span></span></label>)}</div>
      <footer><Dialog.Close className="chat-save-cancel">取消</Dialog.Close><button type="button" className="chat-save-confirm" disabled={!selectedMessages.length} onClick={() => { saveSnapshot(selectedMessages.map(index => messages[index])); setSaveOpen(false); }}>{selectedMessages.length ? <Check size={14} /> : <Save size={14} />}保存所选内容</button></footer>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={renameTarget !== null} onOpenChange={open => { if (!open) setRenameTarget(null); }}><Dialog.Portal><Dialog.Overlay className="search-overlay" /><Dialog.Content className="create-name-dialog chat-rename-dialog" onKeyDown={event => event.stopPropagation()}>
      <header><Dialog.Title>重命名对话</Dialog.Title><Dialog.Close className="chat-icon-button" aria-label="关闭"><X size={16} /></Dialog.Close></header>
      <form onSubmit={event => { event.preventDefault(); renameConversation(); }}><label htmlFor="chat-rename-input">对话名称</label><input id="chat-rename-input" autoFocus value={renameValue} onChange={event => setRenameValue(event.target.value)} maxLength={100} /><footer><Dialog.Close className="chat-save-cancel">取消</Dialog.Close><button type="submit" className="chat-save-confirm" disabled={!renameValue.trim()}><Check size={14} />保存名称</button></footer></form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
