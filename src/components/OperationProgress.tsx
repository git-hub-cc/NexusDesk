import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";

export function OperationProgress({ label, className = "", elapsedLabel = "已等待" }: {
  label: string;
  className?: string;
  elapsedLabel?: string;
}) {
  const [startedAt] = useState(() => performance.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(performance.now() - startedAt), 100);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return <div role="status" className={`flex flex-wrap items-center gap-2 text-xs text-gray-400 ${className}`}>
    <LoaderCircle size={14} className="shrink-0 animate-spin text-ide-accent" aria-hidden="true" />
    <span>{label}</span>
    <span aria-hidden="true">·</span>
    <span role="timer" aria-live="off" className="tabular-nums">{elapsedLabel} {(elapsed / 1000).toFixed(1)} 秒</span>
  </div>;
}
