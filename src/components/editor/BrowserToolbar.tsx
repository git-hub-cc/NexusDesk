import { ArrowLeft, ArrowRight, Globe, House, RotateCw } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { BrowserExtensions, CHROME_EXTENSION_STORE_URL } from "./BrowserExtensions";
import { BrowserPasswords } from "./BrowserPasswords";

interface BrowserToolbarProps {
  address: string;
  currentUrl: string;
  ready: boolean;
  extensionsReady?: boolean;
  getLabel: () => string;
  onAddressChange: (value: string) => void;
  onNavigate: (value: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onHome: () => void;
  onAutofill: () => Promise<void>;
  onOpenStore: (url: string) => Promise<void>;
  onExtensionInstalled: () => Promise<void>;
  onAddressFocus?: () => void;
  onAddressBlur?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export function BrowserToolbar({
  address, currentUrl, ready, extensionsReady = ready, getLabel,
  onAddressChange, onNavigate, onBack, onForward, onReload, onHome,
  onAutofill, onOpenStore, onExtensionInstalled, onAddressFocus,
  onAddressBlur, canGoBack = ready, canGoForward = ready,
}: BrowserToolbarProps) {
  const input = useRef<HTMLInputElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.key !== "Escape") return;
    event.preventDefault();
    onAddressChange(currentUrl === "about:blank" ? "" : currentUrl);
    event.currentTarget.select();
  };

  return <form className="flex h-10 shrink-0 items-center gap-1 border-b border-ide-panel-border px-2 text-gray-400" onSubmit={event => {
    event.preventDefault();
    onNavigate(address);
    input.current?.blur();
  }}>
    <BrowserPasswords onImported={onAutofill} />
    <BrowserExtensions disabled={!extensionsReady} getLabel={getLabel}
      onOpenStore={() => onOpenStore(CHROME_EXTENSION_STORE_URL)} onInstalled={onExtensionInstalled} />
    {([
      ["后退", ArrowLeft, onBack, canGoBack],
      ["前进", ArrowRight, onForward, canGoForward],
      ["刷新", RotateCw, onReload, ready],
      ["主页", House, onHome, ready],
    ] as const).map(([title, Icon, onClick, enabled]) => <button key={title} type="button" title={title} aria-label={title}
      disabled={!enabled} onClick={onClick} className="rounded p-1.5 hover:bg-white/10 hover:text-white disabled:opacity-40">
      <Icon size={15} />
    </button>)}
    <div className="relative ml-1 flex h-7 min-w-0 flex-1 items-center gap-2 rounded border border-ide-panel-border bg-ide-tab-bg px-2 focus-within:border-ide-accent">
      <Globe size={14} className="shrink-0" />
      <input ref={input} aria-label="网页地址" placeholder="输入网址，例如 example.com 或 https://example.com"
        disabled={!ready} className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 outline-none"
        value={address} onChange={event => onAddressChange(event.target.value)}
        onFocus={event => { onAddressFocus?.(); event.target.select(); }} onBlur={onAddressBlur} onKeyDown={onKeyDown} />
    </div>
  </form>;
}
