import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { DialogShell } from "@/components/DialogShell";
import { OperationProgress } from "@/components/OperationProgress";
import { Check, Copy, GitBranch, LoaderCircle, MessageCircle, Pencil, Plus, Save, Send, Settings2, Trash2, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { chatApi, codexSettingsApi, type ChatImage, type ChatOverrides, type CodexSettings } from "@/lib/api";
import { flushGlobalSettings, settingsStorage } from "@/lib/globalSettings";

type Message = { role: "user" | "assistant"; content: string; images?: ChatImage[] };
type SavedConversation = { id: string; title: string; messages: Message[]; savedAt: number };
const HISTORY_KEY = "nexusdesk-chat-history-v1";

function readHistory(): SavedConversation[] {
  try {
    const value: unknown = JSON.parse(settingsStorage.getItem(HISTORY_KEY) ?? localStorage.getItem(HISTORY_KEY) ?? "[]");
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
  const [mode, setMode] = useState<"text" | "image">("text");
  const [imageOverrides, setImageOverrides] = useState<ChatOverrides>({ model: "gpt-image-2.5" });
  const [imageSize, setImageSize] = useState("1024x1024");
  const [attachments, setAttachments] = useState<ChatImage[]>([]);
  const [readingImages, setReadingImages] = useState(false);
  const [preview, setPreview] = useState<ChatImage | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestOverrides = mode === "image" ? imageOverrides : overrides;
  const [showConfig, setShowConfig] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [selectedMessages, setSelectedMessages] = useState<number[]>([]);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
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
    const syncHistory = () => {
      const latest = readHistory();
      historyRef.current = latest;
      setHistory(latest);
    };
    window.addEventListener("global-settings-changed", syncHistory);
    window.addEventListener("storage", syncHistory);
    return () => {
      window.removeEventListener("global-settings-changed", syncHistory);
      window.removeEventListener("storage", syncHistory);
    };
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

  const updateOverride = (key: keyof ChatOverrides, value: string) => (mode === "image" ? setImageOverrides : setOverrides)(current => ({ ...current, [key]: value || undefined }));
  const addImages = async (files: File[]) => {
    if (!files.length || busy || readingImages) return;
    if (attachments.length + files.length > 4) { setError("最多上传 4 张参考图片"); return; }
    setReadingImages(true);
    try {
      const images = await Promise.all(files.map(file => new Promise<ChatImage>((resolve, reject) => {
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || !file.size || file.size > 20 * 1024 * 1024) {
          reject(new Error("请选择不超过 20 MB 的 PNG、JPEG 或 WebP 图片")); return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, url: String(reader.result) });
        reader.onerror = () => reject(new Error("读取图片失败，请重新选择"));
        reader.readAsDataURL(file);
      })));
      setAttachments(current => [...current, ...images]);
      setError("");
    } catch (reason) { setError(String(reason).replace(/^Error: /, "")); }
    finally { setReadingImages(false); }
  };
  const useReference = (image: ChatImage) => {
    if (busy || readingImages) return;
    if (attachments.length >= 4) { setError("最多上传 4 张参考图片"); return; }
    setMode("image");
    setAttachments(current => [...current, image]);
    setNotice("已添加参考图片，请输入修改要求");
    composer.current?.focus();
  };
  const updateHistory = async (update: (current: SavedConversation[]) => SavedConversation[]) => {
    const write = () => {
      const next = update(readHistory());
      settingsStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      historyRef.current = next;
      setHistory(next);
    };
    try {
      if (navigator.locks) await navigator.locks.request(`${HISTORY_KEY}-write`, write);
      else write();
      await flushGlobalSettings();
      const latest = readHistory();
      historyRef.current = latest;
      setHistory(latest);
      return true;
    } catch {
      setError("对话历史保存失败，请检查数据库或本机存储状态");
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
    setAttachments([]);
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
    if (!content || busy || readingImages) return;
    if (mode === "image") {
      const previousMessages = messages;
      const references = attachments;
      const next: Message[] = [...messages, { role: "user", content, images: references.length ? references : undefined }];
      setActiveHistoryId(null);
      setMessages(next); setInput(""); setBusy(true); setError(""); setNotice("");
      setStage(references.length ? "正在修改图片" : "正在生成图片");
      try {
        const images = await chatApi.images(content, references, imageOverrides, imageSize);
        setMessages([...next, { role: "assistant", content: references.length ? "图片修改完成" : "图片生成完成", images }]);
        setAttachments([]);
      } catch (reason) {
        setMessages(previousMessages); setInput(content);
        setError(String(reason).replace(/^Error: /, ""));
      } finally { setBusy(false); composer.current?.focus(); }
      return;
    }
    const previousMessages = messages;
    const next = [...messages, { role: "user" as const, content }];
    setActiveHistoryId(null);
    setMessages([...next, { role: "assistant", content: "" }]); setInput(""); setBusy(true); setError(""); setNotice("");
    setStage("正在等待回复");
    const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`; const assistantIndex = next.length; let reply = ""; let streamFailed = false; let streamError = "";
    const cleanup: (() => void)[] = [];
    try {
      cleanup.push(await listen<string>(`chat-stream-${requestId}`, event => { if (!event.payload) return; if (!reply) setStage("正在接收回复"); reply += event.payload; setMessages(current => current.map((message, index) => index === assistantIndex ? { ...message, content: reply } : message)); }));
      cleanup.push(await listen<string>(`chat-stream-error-${requestId}`, event => { streamFailed = true; streamError = event.payload; setError(event.payload); }));
      await chatApi.complete(requestId, next.slice(-40).map(({ role, content }) => ({ role, content })), overrides);
    }
    catch (reason) { streamFailed = true; streamError = String(reason).replace(/^Error: /, ""); setError(streamError); }
    finally {
      cleanup.forEach(unlisten => unlisten());
      if (streamFailed || !reply.trim()) {
        setMessages(previousMessages);
        setInput(content);
        if (!streamError) setError("AI 未返回有效内容，请检查接口格式后重试");
      }
      setBusy(false); composer.current?.focus();
    }
  };

  return <div className={`chat-page absolute inset-0 flex bg-ide-bg text-gray-200 ${active ? "" : "hidden"}`}>
    <aside className="chat-history" aria-label="保存的对话">
      <div className="chat-history-heading"><strong>历史记录</strong></div>
      <div className="chat-history-list">{history.map(item => <div className={`chat-history-row ${activeHistoryId === item.id ? "is-active" : ""}`} key={item.id}><button type="button" className="chat-history-item" disabled={busy || readingImages} title={item.title} onClick={() => { setAttachments([]); setMessages(item.messages); setActiveHistoryId(item.id); setError(""); setNotice(""); }}><span>{item.title}</span><small>{new Date(item.savedAt).toLocaleString()}</small></button><button type="button" className="chat-icon-button chat-history-rename" title="重命名对话" aria-label={`重命名对话：${item.title}`} onClick={() => openRenameDialog(item)}><Pencil size={13} /></button><button type="button" className="chat-icon-button chat-history-delete" title="删除对话" aria-label={`删除对话：${item.title}`} disabled={busy || readingImages} onClick={() => void deleteConversation(item)}><Trash2 size={13} /></button></div>)}{!history.length && <p className="chat-history-empty">保存或创建分支后，对话会显示在这里。</p>}</div>
    </aside>
    <section className="chat-workspace">
      <header className="chat-header"><div className="chat-heading"><MessageCircle size={16} /><div><h2>对话</h2><p>{requestOverrides.model || settings?.model || "使用 Codex 设置中的模型"}</p></div></div><div className="chat-header-actions"><span className={`chat-config-state ${settings ? "is-ready" : ""}`}><span />{settings ? "配置已读取" : "读取配置中"}</span><button type="button" className="chat-icon-button" title="对话设置" aria-label="对话设置" onClick={() => setShowConfig(value => !value)}><Settings2 size={16} /></button><button type="button" className="chat-icon-button" title="新对话" aria-label="新对话" disabled={(!messages.length && !attachments.length) || busy || readingImages} onClick={() => { setAttachments([]); setMessages([]); setActiveHistoryId(null); setError(""); setNotice(""); composer.current?.focus(); }}><Plus size={16} /></button></div></header>
      {showConfig && <section className="chat-config-panel" aria-label="对话请求设置"><div className="chat-config-title"><strong>请求设置</strong><button type="button" className="chat-icon-button" title="关闭" aria-label="关闭" onClick={() => setShowConfig(false)}><X size={15} /></button></div><label>API 地址<input className="ide-control" value={requestOverrides.api ?? ""} onChange={event => updateOverride("api", event.target.value)} placeholder={settings?.proxyUrl || "留空使用当前 API 地址"} spellCheck={false} /></label><label>API Key<input className="ide-control" type="password" value={requestOverrides.key ?? ""} onChange={event => updateOverride("key", event.target.value)} placeholder="sk-xxx" autoComplete="new-password" /></label><label>模型<input className="ide-control" value={requestOverrides.model ?? ""} onChange={event => updateOverride("model", event.target.value)} placeholder={settings?.model || "留空使用当前模型"} spellCheck={false} /></label>{mode === "text" && <label>参数格式<select className="ide-control" value={overrides.format ?? "responses"} onChange={event => updateOverride("format", event.target.value)}><option value="responses">Responses（input）</option><option value="chat">Chat Completions（messages）</option></select></label>}{mode === "image" && <label>图片尺寸<select className="ide-control" value={imageSize} onChange={event => setImageSize(event.target.value)}><option value="1024x1024">1024 × 1024（方图）</option><option value="1536x1024">1536 × 1024（横图）</option><option value="1024x1536">1024 × 1536（竖图）</option><option value="auto">自动</option></select></label>}<p className="chat-config-hint">{mode === "image" ? "留空的地址和 Key 使用 Codex 配置。可填写基础地址或完整图片接口地址；支持的尺寸以提供方为准。" : "参数格式仅对后续消息生效。"}</p></section>}
      <main className="chat-conversation" ref={conversation} aria-live="polite">{!messages.length && <div className="chat-empty"><MessageCircle size={24} /><h3>开始新对话</h3><p>可发送文字，或切换图片模式生成图片、上传参考图进行修改。请求参数可在右上角设置。</p></div>}{messages.map((message, index) => <article key={`${index}-${message.role}`} className={`chat-message ${message.role === "user" ? "is-user" : "is-assistant"}`}><div className="chat-message-label">{message.role === "user" ? "你" : "助手"}</div><p>{message.content}</p>{!!message.images?.length && <div className="chat-images">{message.images.map((image, imageIndex) => <figure key={imageIndex}><button type="button" className="chat-image-preview" title="查看图片" onClick={() => setPreview(image)}><img src={image.url} alt={image.name} loading="lazy" onLoad={() => { const container = conversation.current; if (container && conversationScroll.current.atBottom) container.scrollTop = container.scrollHeight; }} /></button><figcaption><span>{image.name}</span><button type="button" disabled={busy || readingImages} onClick={() => useReference(image)}>用作参考图</button></figcaption></figure>)}</div>}{message.role === "assistant" && message.content && <div className="chat-message-actions"><button type="button" className="chat-icon-button" title="复制回复" aria-label="复制回复" onClick={() => void copyReply(message.content)}><Copy size={14} /></button><button type="button" className="chat-icon-button" title="保存对话" aria-label="保存对话" disabled={busy} onClick={() => openSaveDialog(index)}><Save size={14} /></button><button type="button" className="chat-icon-button" title="从此处分支" aria-label="从此处分支" disabled={busy} onClick={() => branchAt(index)}><GitBranch size={14} /></button></div>}</article>)}{busy && <OperationProgress label={stage} className="chat-working" elapsedLabel={stage === "正在接收回复" ? "已用时" : "已等待"} />}{(error || notice) && <p className={error ? "chat-error" : "chat-notice"} role={error ? "alert" : "status"}>{error || notice}</p>}</main>
      <form className="chat-composer ide-control-shell" onSubmit={event => void send(event)}>
        <div className="chat-composer-tools"><select className="ide-control" aria-label="对话模式" value={mode} disabled={busy || readingImages} onChange={event => setMode(event.target.value as "text" | "image")}><option value="text">文字对话</option><option value="image">图片生成 / 修改</option></select>{mode === "image" && <><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { void addImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} /><button type="button" className="ide-button ide-button-secondary" disabled={busy || readingImages || attachments.length >= 4} onClick={() => fileInput.current?.click()}>{readingImages ? "读取中…" : "添加参考图"}</button><span>{attachments.length ? "将根据参考图修改" : "输入描述生成图片"}（最多 4 张）</span></>}</div>
        {mode === "image" && !!attachments.length && <div className="chat-attachments">{attachments.map((image, index) => <div key={index}><button type="button" title="查看参考图" onClick={() => setPreview(image)}><img src={image.url} alt={image.name} /></button><button type="button" className="chat-icon-button" aria-label={`移除参考图：${image.name}`} disabled={busy || readingImages} onClick={() => setAttachments(current => current.filter((_, itemIndex) => itemIndex !== index))}><X size={12} /></button></div>)}</div>}
        <textarea ref={composer} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={mode === "image" ? (attachments.length ? "描述如何修改参考图片…" : "描述要生成的图片…") : "发送消息…"} aria-label="消息内容" rows={3} disabled={busy} /><div className="chat-composer-footer"><span>Shift + Enter 换行</span><button className="ide-button ide-button-primary" type="submit" title="发送消息" aria-label="发送消息" disabled={busy || readingImages || !input.trim()}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}</button></div></form>
    </section>
    <Dialog.Root open={preview !== null} onOpenChange={open => { if (!open) setPreview(null); }}><DialogShell wide className="chat-image-dialog"><header><Dialog.Title>{preview?.name || "图片预览"}</Dialog.Title><Dialog.Close className="chat-icon-button" aria-label="关闭"><X size={16} /></Dialog.Close></header><Dialog.Description className="sr-only">查看对话中的图片</Dialog.Description>{preview && <img src={preview.url} alt={preview.name} />}</DialogShell></Dialog.Root>
    <Dialog.Root open={saveOpen} onOpenChange={setSaveOpen}><DialogShell wide className="chat-save-dialog">
        <header><div><Dialog.Title>保存对话</Dialog.Title><Dialog.Description>选择要保存的对话内容</Dialog.Description></div><Dialog.Close className="chat-icon-button" aria-label="关闭"><X size={16} /></Dialog.Close></header>
        <div className="chat-save-actions"><button type="button" onClick={() => setSelectedMessages(messages.map((_, index) => index))}>全选</button><button type="button" onClick={() => setSelectedMessages([])}>清空</button></div>
        <div className="chat-save-list">{messages.map((message, index) => <label key={`${index}-${message.role}`}><input type="checkbox" checked={selectedMessages.includes(index)} onChange={event => setSelectedMessages(current => event.target.checked ? [...current, index].sort((a, b) => a - b) : current.filter(item => item !== index))} /><span><strong>{message.role === "user" ? "你" : "助手"}</strong><span>{message.content || "（暂无内容）"}{message.images?.length ? `（含 ${message.images.length} 张图片）` : ""}</span></span></label>)}</div>
        <footer><Dialog.Close className="ide-button ide-button-secondary rounded px-3 py-1.5 text-xs">取消</Dialog.Close><button type="button" className="chat-save-confirm ide-button ide-button-primary" disabled={!selectedMessages.length} onClick={() => { saveSnapshot(selectedMessages.map(index => messages[index])); setSaveOpen(false); }}>{selectedMessages.length ? <Check size={14} /> : <Save size={14} />}保存所选内容</button></footer>
      </DialogShell></Dialog.Root>
    <Dialog.Root open={renameTarget !== null} onOpenChange={open => { if (!open) setRenameTarget(null); }}><DialogShell className="chat-rename-dialog">
        <header><Dialog.Title>重命名对话</Dialog.Title><Dialog.Close className="chat-icon-button" aria-label="关闭"><X size={16} /></Dialog.Close></header>
        <form onSubmit={event => { event.preventDefault(); renameConversation(); }}><label htmlFor="chat-rename-input">对话名称</label><input className="ide-control" id="chat-rename-input" autoFocus value={renameValue} onChange={event => setRenameValue(event.target.value)} maxLength={100} /><footer><Dialog.Close className="ide-button ide-button-secondary rounded px-3 py-1.5 text-xs">取消</Dialog.Close><button type="submit" className="chat-save-confirm ide-button ide-button-primary" disabled={!renameValue.trim()}><Check size={14} />保存名称</button></footer></form>
      </DialogShell></Dialog.Root>
  </div>;
}
