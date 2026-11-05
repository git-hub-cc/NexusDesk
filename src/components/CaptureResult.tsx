import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Check, LoaderCircle, X, CircleAlert } from 'lucide-react';

type Notice = { message: string; busy?: boolean; error?: boolean };
type CaptureEvent = { action: string; cancelled?: boolean };

export function CaptureResult() {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const subscriptions = [
      listen<CaptureEvent>('capture-progress', ({ payload }) => {
        if (!disposed) setNotice({ busy: true, message: payload.action === 'ocr' ? '正在识别文字…' : payload.action === 'save' ? '正在保存截图…' : '正在复制图片…' });
      }),
      listen<CaptureEvent>('capture-complete', ({ payload }) => {
        if (!disposed) setNotice({ message: payload.cancelled ? '已取消保存' : payload.action === 'ocr' ? '识别完成，文字已复制' : payload.action === 'save' ? '截图已保存，按 F3 贴图' : payload.action === 'copy_pin' ? '图片已复制并贴图' : '图片已复制，按 F3 贴图' });
      }),
      listen<string>('capture-error', ({ payload }) => {
        if (!disposed) setNotice({ error: true, message: payload });
      }),
    ];
    for (const subscription of subscriptions) void subscription.then(stop => { if (disposed) stop(); }).catch(console.error);
    return () => { disposed = true; for (const subscription of subscriptions) void subscription.then(stop => stop()).catch(console.error); };
  }, []);
  useEffect(() => { if (!notice || notice.busy || notice.error) return; const timer = window.setTimeout(() => setNotice(null), 4000); return () => window.clearTimeout(timer); }, [notice]);
  if (!notice) return null;
  const Icon = notice.busy ? LoaderCircle : notice.error ? CircleAlert : Check;
  return <div role={notice.error ? 'alert' : 'status'} className="fixed right-4 top-12 z-[9999] flex max-w-sm items-center gap-3 rounded-lg border border-white/10 bg-[#252830]/95 px-4 py-3 text-sm text-slate-200 shadow-2xl backdrop-blur-md"><Icon size={18} className={notice.busy ? 'shrink-0 animate-spin text-blue-400' : notice.error ? 'shrink-0 text-red-400' : 'shrink-0 text-green-400'} /><span className="break-words">{notice.message}</span>{!notice.busy && <button aria-label="关闭通知" onClick={() => setNotice(null)} className="rounded p-1 hover:bg-white/10 active:scale-95"><X size={14} /></button>}</div>;
}
