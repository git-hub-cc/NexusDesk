// src/components/layout/TerminalSession.tsx
import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ILink } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import type { SessionInfo } from "@/store/terminalStore";
import { fsApi } from "@/lib/api";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { resolveTerminalPath, terminalBufferFileLinks } from "@/lib/terminalLinks";
import { isRemotePath, remotePath, remoteUri, shellQuote } from "@/lib/remote";
import { matchTerminalHistory, terminalPromptInput } from "@/lib/terminalHistory";
import { codexComposerInput, fillCodexCommitMessage } from "@/lib/codexCommitMessage";
import { codexProxyLaunchCommand, getCodexProxyStatus } from "@/lib/codexProxy";

export function TerminalSession({ session, active, onExit }: {
  session: SessionInfo;
  active: boolean;
  onExit?: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const queryRef = useRef(query);
  queryRef.current = query;
  const [historyError, setHistoryError] = useState("");
  const terminalRef = useRef<Terminal | null>(null);
  const clearScrollbackAfterCommand = useRef(false);
  const fillHistory = useRef<(command: string, execute?: boolean) => void>(() => {});
  const historyClickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const matches = matchTerminalHistory(history, query);
  const fitRef = useRef<() => void>(() => {});
  const onExitRef = useRef(onExit);

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    clearScrollbackAfterCommand.current = false;
    let composing = false;
    let focusAfterComposition = false;
    let historyReady = false;
    let historySubmission = false;
    const readCommand = () => {
      if (terminal.buffer.active.type !== 'normal' || composing) return undefined;
      const buffer = terminal.buffer.active;
      const row = buffer.baseY + buffer.cursorY;
      const line = buffer.getLine(row);
      // Wrapped/continuation input is left entirely to the shell.
      if (!line || line.isWrapped || buffer.getLine(row + 1)?.isWrapped) return undefined;
      if (terminalPromptInput(line.translateToString(false, 0, buffer.cursorX)) === undefined) return undefined;
      return terminalPromptInput(line.translateToString(true));
    };
    void invoke<string[]>("load_terminal_history").then(entries => {
      if (!disposed) { setHistory(entries); historyReady = true; }
    }).catch(error => { if (!disposed) setHistoryError(String(error)); });

    if (!host.current) return;
    const terminal = new Terminal({ allowProposedApi: true, cursorBlink: true, fontSize: 13, fontFamily: 'Consolas, "Cascadia Code", "Microsoft YaHei", "PingFang SC", "Noto Sans Mono CJK SC", monospace', theme: { background: "#2b2d30", foreground: "#d1d5db", cursor: "#a9b7c6" }, scrollback: 5000 });
    // ConPTY owns screen reflow and does not restore scrollback when rows grow.
    // xterm's default Unix resize behavior otherwise disagrees with its redraws.
    // Remote PTYs must keep their server's normal terminal behavior.
    if (!session.remoteId && navigator.userAgent.includes('Windows')) {
      terminal.options.windowsPty = { backend: 'conpty' };
    }
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";

    terminal.attachCustomKeyEventHandler((e) => {
      if (terminal.buffer.active.type === 'normal' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        if (e.type === 'keydown') {
          e.preventDefault();
          // PSReadLine's SelectAll keeps selection and replacement in the shell.
          terminal.input('\x01', true);
        }
        return false;
      }
      if (e.type === 'keydown' && e.key.toLowerCase() === 'c' && e.ctrlKey) {
        if (terminal.hasSelection()) {
          navigator.clipboard.writeText(terminal.getSelection());
          terminal.clearSelection();
          return false;
        }
      }
      return true;
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    terminalRef.current = terminal;
    // Keep the browser's hidden textarea attached to the same TSF context.
    // Calling xterm.focus() while Windows is composing can detach the IME and
    // make the committed string arrive through both IMM32 and TSF paths.
    const focusTerminal = () => {
      if (composing) { focusAfterComposition = true; return; }
      terminal.focus();
    };
    const compositionStart = () => { composing = true; };
    const compositionEnd = () => {
      composing = false;
      if (focusAfterComposition) {
        focusAfterComposition = false;
        requestAnimationFrame(() => { if (!disposed) terminal.focus(); });
      }
    };
    host.current.addEventListener("compositionstart", compositionStart, true);
    host.current.addEventListener("compositionend", compositionEnd, true);
    const parsedOutput = terminal.onWriteParsed(() => {
      if (disposed || exited) return;
      // cls/clear 会清屏，但 shell 不会替 xterm 清理其滚动缓冲。
      // 等清屏序列解析完成后再清除，避免把命令本身或清屏前的内容保留下来。
      if (clearScrollbackAfterCommand.current && terminal.buffer.active.type === 'normal') {
        clearScrollbackAfterCommand.current = false;
        // xterm 没有公开清理滚动缓冲的方法，使用标准的 CSI 3 J 擦除滚动缓冲。
        terminal.write("\x1b[3J");
      }
      setQuery(historyReady ? readCommand() ?? '' : '');
    });
    const id = crypto.randomUUID();
    const remoteId = session.remoteId;
    const terminalInvoke = <T,>(command: string, args: Record<string, unknown>) => invoke<T>(
      remoteId ? ({ start_terminal: "start_remote_terminal", write_terminal: "write_remote_terminal", resize_terminal: "resize_remote_terminal", close_terminal: "close_remote_terminal" }[command] ?? command) : command,
      remoteId ? { ...args, id: remoteId, terminalId: id, cwd: session.cwd ? remotePath(session.cwd).path : null } : args,
    );
    let disposed = false;
    let started = false;
    let exited = false;
    const pendingInput: string[] = [];
    const report = (error: unknown) => {
      if (disposed) return;
      terminal.writeln(`\r\n\x1b[31m${String(error)}\x1b[0m`);
    };
    const element = host.current;
    // Mouse reporting can consume wheel events even in the normal buffer.
    // Capture them before xterm forwards them to Codex as application input.
    const wheel = (event: WheelEvent) => {
      if (!/\bcodex\b/i.test(session.command) || terminal.buffer.active.type !== 'normal' || event.ctrlKey || !event.deltaY) return;
      event.preventDefault();
      event.stopPropagation();
      const lineHeight = element.clientHeight / terminal.rows || 16;
      const lines = event.deltaMode === 1 ? event.deltaY
        : event.deltaMode === 2 ? event.deltaY * terminal.rows : event.deltaY / lineHeight;
      terminal.scrollLines(Math.sign(lines) * Math.max(1, Math.round(Math.abs(lines))));
    };
    element.addEventListener('wheel', wheel, { capture: true, passive: false });
    const contextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection()).catch(report);
      } else {
        void navigator.clipboard.readText().then(text => {
          if (!disposed && started && !exited) { terminal.paste(text); focusTerminal(); }
        }).catch(report);
      }
    };
    const dragTypes = ['application/x-nexusdesk-files', 'application/x-nexusdesk-file', 'application/x-nexusdesk-logical-file'];
    const dragOver = (event: DragEvent) => {
      if (!dragTypes.some(type => event.dataTransfer?.types.includes(type))) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer!.dropEffect = 'copy';
    };
    const drop = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      if (!transfer || !dragTypes.some(type => transfer.types.includes(type))) return;
      event.preventDefault();
      event.stopPropagation();
      if (!started || exited) return;
      try {
        const multiple = transfer.getData(dragTypes[0]);
        const paths: unknown = multiple ? JSON.parse(multiple) : [transfer.getData(dragTypes[1]) || transfer.getData(dragTypes[2])];
        if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string' && path && !/[\r\n\0]/.test(path))) return;
        const powershell = !remoteId && !/bash|zsh|fish|\bwsl\b/i.test(session.command) && navigator.userAgent.includes('Windows');
        terminal.paste(paths.map(path => {
          if (isRemotePath(path)) {
            const remote = remotePath(path);
            if (remote.id !== remoteId) throw new Error("该文件不属于当前远程终端");
            return shellQuote(remote.path);
          }
          if (remoteId) throw new Error("本地文件不能直接作为远程 Shell 路径使用");
          const absolute = resolveTerminalPath(path, session.cwd);
          return powershell ? `"${absolute.replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"')}"`
            : `"${absolute.replace(/[\\"$`]/g, '\\$&')}"`;
        }).join(' '));
        focusTerminal();
      } catch (error) { report(error); }
    };
    element.addEventListener('contextmenu', contextMenu, true);
    element.addEventListener('dragover', dragOver, true);
    element.addEventListener('drop', drop, true);
    let hoveredLink: ILink | undefined;
    let linkClickTimer: number | undefined;
    let pendingLinkPath: string | undefined;
    const updateLinkModifier = (event: KeyboardEvent | MouseEvent) => {
      if (hoveredLink?.decorations) {
        hoveredLink.decorations.underline = event.ctrlKey;
        hoveredLink.decorations.pointerCursor = event.ctrlKey;
      }
    };
    const clearLinkHover = () => {
      if (hoveredLink?.decorations) {
        hoveredLink.decorations.underline = false;
        hoveredLink.decorations.pointerCursor = false;
      }
    };
    window.addEventListener('keydown', updateLinkModifier);
    window.addEventListener('keyup', updateLinkModifier);
    window.addEventListener('blur', clearLinkHover);
    element.addEventListener('mousemove', updateLinkModifier);
    const linkProvider = terminal.registerLinkProvider({
      provideLinks: (lineNumber, callback) => {
        if (terminal.buffer.active.type === 'alternate') { callback([]); return; }
        callback(terminalBufferFileLinks(terminal.buffer.active, lineNumber, terminal.cols, !remoteId).map(link => {
          const terminalLink: ILink = {
          text: link.text,
          range: link.range,
          decorations: { underline: false, pointerCursor: false },
          hover: event => { hoveredLink = terminalLink; updateLinkModifier(event); },
          leave: () => { if (hoveredLink === terminalLink) hoveredLink = undefined; },
          activate: event => {
            if (!event.ctrlKey || event.button !== 0) return;
            event.preventDefault();
            if (remoteId) {
              const cwd = session.cwd ? remotePath(session.cwd).path : "/";
              const absolute = link.path.startsWith("/") ? link.path : `${cwd.replace(/\/$/, "")}/${link.path}`;
              const path = remoteUri(remoteId, absolute);
              void (async () => {
                const state = useWorkspaceStore.getState();
                if (await fsApi.isDirectory(path)) { await state.loadDirectory(path); state.triggerLocate(); return; }
                const content = await fsApi.readFile(path);
                if (!disposed) state.openTab({ id: path, path, title: absolute.split("/").pop()!, content, markdownMode: "source" });
              })().catch(report);
              return;
            }
            const resolved = resolveTerminalPath(link.path, session.cwd ?? useWorkspaceStore.getState().rootPath);
            if (pendingLinkPath !== resolved || event.detail < 2) {
              window.clearTimeout(linkClickTimer);
              pendingLinkPath = resolved;
              linkClickTimer = window.setTimeout(() => {
                pendingLinkPath = undefined;
                void revealItemInDir(resolved).catch(report);
              }, 500);
              return;
            }
            window.clearTimeout(linkClickTimer);
            pendingLinkPath = undefined;
            void (async () => {
            const state = useWorkspaceStore.getState();
            const path = resolveTerminalPath(link.path, session.cwd ?? state.rootPath);
            if (await fsApi.isDirectory(path)) {
              await revealItemInDir(path);
              return;
            }
            const bytes = new Uint8Array(await fsApi.readBinaryFile(path));
            let diskContent: string;
            try {
              diskContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
              await revealItemInDir(path);
              return;
            }
            // Binary formats can contain valid UTF-8; reject their control bytes too.
            if (/[\x00-\x08\x0e-\x1f\x7f]/.test(diskContent)) {
              await revealItemInDir(path);
              return;
            }
            const existing = [...state.leftTabs, ...state.rightTabs].find(tab => resolveTerminalPath(tab.path, state.rootPath) === path && !tab.revision && tab.diff === undefined);
            const content = existing?.content ?? diskContent;
            if (disposed) return;
            const targetPath = existing?.path ?? path;
            state.openTab({ ...(existing ?? {}), id: existing?.id ?? path, path: targetPath, title: existing?.title ?? path.split('/').pop()!, content, markdownMode: 'source' });
            state.setMarkdownMode(existing?.id ?? path, useWorkspaceStore.getState().focusedPane, 'source');
            const lines = content.split('\n');
            const line = Math.min(link.line, lines.length) - 1;
            const pos = lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) + Math.min(link.column - 1, lines[line].replace(/\r$/, '').length);
            window.setTimeout(() => window.dispatchEvent(new CustomEvent('editor-jump', { detail: { path: targetPath, pos } })), 50);
          })().catch(report); },
          };
          return terminalLink;
        }));
      },
    });
    let resizeFrame = 0;
    let lastSize = "";
    let resizeQueue = Promise.resolve();
    let resizePending = false;
    let panelDragging = false;
    let writeQueue: Promise<void> = Promise.resolve();
    let fontsReady = false;
    const dimensions = () => ({ id, cols: Math.max(1, terminal.cols), rows: Math.max(1, terminal.rows),
      pixelWidth: Math.min(65535, Math.round(element.clientWidth * (window.devicePixelRatio || 1))),
      pixelHeight: Math.min(65535, Math.round(element.clientHeight * (window.devicePixelRatio || 1))) });
    const sizeKey = (size: { cols: number; rows: number }) => `${size.cols}:${size.rows}`;
    const resize = () => {
      if (disposed || exited || !fontsReady || !element.clientWidth || !element.clientHeight) return;
      // Keep the grid at the PTY's size until the previous resize has completed.
      // Read the latest layout in the queue instead of replaying stale sizes.
      if (resizePending) return;
      resizePending = true;
      resizeQueue = resizeQueue.then(async () => {
        resizePending = false;
        if (disposed || exited || !element.clientWidth || !element.clientHeight) return;
        if (panelDragging) return;
        fit.fit();
        const size = dimensions();
        const key = sizeKey(size);
        // ConPTY only uses rows/columns. Pixel-only changes must not trigger a
        // console redraw (and another prompt) on every splitter movement.
        if (!started || key === lastSize) return;
        await terminalInvoke("resize_terminal", size);
        lastSize = key;
      }).catch(error => { lastSize = ""; report(error); });
    };
    const scheduleResize = () => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        resize();
      });
    };
    // 分割面板改变的是宿主尺寸，不一定会触发 window.resize。
    const resizeObserver = new ResizeObserver(() => scheduleResize());
    resizeObserver.observe(element);
    const onPanelDrag = (event: Event) => {
      panelDragging = (event as CustomEvent<boolean>).detail;
      if (!panelDragging) scheduleResize();
    };
    window.addEventListener("terminal-panel-drag", onPanelDrag);
    fitRef.current = () => { scheduleResize(); focusTerminal(); };
    // Wait for fonts and three equal, visible layout samples before opening PTY.
    let finishLayout: (() => void) | undefined;
    const layoutReady = new Promise<void>(resolve => { finishLayout = resolve; });
    let stableFrames = 0;
    let previousLayout = "";
    const confirmLayout = () => {
      if (disposed) return;
      const layout = `${element.clientWidth}:${element.clientHeight}`;
      stableFrames = element.clientWidth && element.clientHeight && layout === previousLayout ? stableFrames + 1 : 0;
      previousLayout = layout;
      if (stableFrames >= 2) { resize(); void resizeQueue.then(() => finishLayout?.()); }
      else layoutFrame = requestAnimationFrame(confirmLayout);
    };
    let layoutFrame = 0;
    const checkLayout = () => { layoutFrame = requestAnimationFrame(confirmLayout); };
    void (document.fonts?.ready ?? Promise.resolve()).then(() => { if (!disposed) { fontsReady = true; checkLayout(); } });
    const fontsChanged = () => { previousLayout = ""; scheduleResize(); };
    document.fonts?.addEventListener("loadingdone", fontsChanged);
    window.addEventListener("resize", scheduleResize);

    const channel = new Channel<{ type: "output"; data: number[] } | { type: "exit" }>();
    channel.onmessage = event => {
      if (disposed) return;
      if (event.type === "output") {
        const dataArr = new Uint8Array(event.data);
        terminal.write(dataArr);

      } else {
        exited = true;
        onExitRef.current?.(session.id);
      }
    };

    const start = layoutReady.then(async () => {
      if (disposed) return;
      try {
        const initialSize = dimensions();
        lastSize = sizeKey(initialSize);
        // The default Codex profile must retain terminal scrollback. Alternate
        // screens have no history in xterm. Leave custom commands untouched.
        let command = /^\s*codex\s*$/i.test(session.command) ? 'codex --no-alt-screen' : session.command;
        if (!remoteId && /^\s*codex\s*$/i.test(session.command)) {
          try {
            const proxy = await getCodexProxyStatus();
            if (proxy.running && proxy.providerId && proxy.proxyBaseUrl) {
              command = codexProxyLaunchCommand(proxy.providerId, proxy.proxyBaseUrl);
            }
          } catch { /* Proxy capture is optional; keep normal Codex startup. */ }
        }
        await terminalInvoke("start_terminal", { ...session, command, ...initialSize, onEvent: channel });
        started = true;
        if (disposed) {
          await terminalInvoke("close_terminal", { id });
        } else {
          // TUI programs can query the terminal before start_terminal resolves.
          // Preserve xterm's replies during that window so startup cannot stall.
          for (const data of pendingInput.splice(0)) {
            if (!exited) await terminalInvoke("write_terminal", { id, data });
          }
          resize();
        }
      } catch (e) {
        report(e);
      }
    });

    const input = terminal.onData(data => {
      if (disposed) return;
      if (exited) {
        terminal.write(data.replace(/\r/g, "\r\n"));
        return;
      }
      if (!started) { pendingInput.push(data); return; }
      if (started && !exited) {
        if (data === '\r' && !composing && /\bcodex\b/i.test(session.command)) {
          const message = codexComposerInput(terminal.buffer.active);
          const root = useWorkspaceStore.getState().rootPath;
          if (message && root && !isRemotePath(root) && !remoteId) {
            void fillCodexCommitMessage(root, message).catch(error => console.error("Cannot fill commit message", error));
          }
        }
        if (data === '\r' && !historySubmission) {
          const command = readCommand();
          if (/^\s*(?:cls|clear)\s*$/i.test(command ?? '')) clearScrollbackAfterCommand.current = true;
          if (command?.trim()) {
            void invoke<string[]>("save_terminal_history", { command }).then(entries => {
              if (!disposed) { setHistory(entries); setHistoryError(''); }
            }).catch(error => { if (!disposed) setHistoryError(String(error)); });
          }
        }
        if (data.includes('\r') || data.includes('\x03') || data.includes('\x1b')) setQuery('');
        // Enter also submits history entries and pasted commands; local keystroke
        // buffering cannot tell whether the application has a command to execute.
        writeQueue = writeQueue.then(() => terminalInvoke<void>("write_terminal", { id, data })).catch(report);
      }
    });

    fillHistory.current = (command, execute = false) => {
      if (!started || disposed || exited) return;
      const current = readCommand();
      if (current === undefined || current !== queryRef.current) return;
      const powershell = !remoteId && !/bash|zsh|fish|\bwsl\b/i.test(session.command) && navigator.userAgent.includes('Windows');
      terminal.input(powershell ? '\x01' : '\x05\x15', true);
      terminal.paste(command);
      if (execute) {
        // The PTY echo is asynchronous: persist the selected command directly,
        // rather than reading the previous rendered line on this Enter.
        void invoke<string[]>("save_terminal_history", { command }).then(entries => {
          if (!disposed) { setHistory(entries); setHistoryError(''); }
        }).catch(error => { if (!disposed) setHistoryError(String(error)); });
        historySubmission = true;
        try { terminal.input('\r', true); } finally { historySubmission = false; }
      }
      setQuery('');
      focusTerminal();
    };

    return () => {
      disposed = true;
      finishLayout?.();
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(layoutFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleResize);
      window.removeEventListener("terminal-panel-drag", onPanelDrag);
      document.fonts?.removeEventListener("loadingdone", fontsChanged);
      clearTimeout(historyClickTimer.current);
      fillHistory.current = () => {};
      parsedOutput.dispose();
      element.removeEventListener('wheel', wheel, true);
      element.removeEventListener('contextmenu', contextMenu, true);
      element.removeEventListener('dragover', dragOver, true);
      element.removeEventListener('drop', drop, true);
      window.clearTimeout(linkClickTimer);
      window.removeEventListener('keydown', updateLinkModifier);
      window.removeEventListener('keyup', updateLinkModifier);
      window.removeEventListener('blur', clearLinkHover);
      element.removeEventListener('mousemove', updateLinkModifier);
      element.removeEventListener('compositionstart', compositionStart, true);
      element.removeEventListener('compositionend', compositionEnd, true);
      linkProvider.dispose();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      void start.then(() => {
        if (started && !exited) terminalInvoke("close_terminal", { id }).catch(() => {});
      });
    };
  }, [session]);

  useEffect(() => {
    if (active) {
      const frame = requestAnimationFrame(() => fitRef.current());
      return () => cancelAnimationFrame(frame);
    }
  }, [active]);

  return (
    <>
      <div style={{ display: active ? "flex" : "none", background: "#2b2d30" }} className="terminal-pane h-full w-full min-h-0 flex-col p-2">
        <div ref={host} onKeyDown={event => event.stopPropagation()} className="terminal-host min-h-0 flex-1 w-full overflow-hidden" />
        {matches.length > 0 && <div className="shrink-0 border-t border-white/10 pt-1" aria-label="命令历史候选">
          <div className="mb-1 flex justify-between text-[10px] text-gray-500"><span>命令历史 · 单击回填，双击执行</span><span>{matches.length} 条</span></div>
          <div className="max-h-36 overflow-y-auto">
            {matches.map(match => <button key={match.command} type="button" title={match.command}
              onMouseDown={event => event.preventDefault()} onClick={event => {
                clearTimeout(historyClickTimer.current);
                if (event.detail > 1) return;
                historyClickTimer.current = setTimeout(() => fillHistory.current(match.command), 350);
              }} onDoubleClick={event => {
                // Chromium can deliver the first click's delayed callback after
                // dblclick. Cancel it here so the partial input is never restored
                // over the command being executed.
                event.preventDefault();
                event.stopPropagation();
                clearTimeout(historyClickTimer.current);
                fillHistory.current(match.command, true);
              }}
              className="block w-full truncate rounded px-2 py-0.5 text-left font-mono text-xs text-gray-300 hover:bg-white/10 focus:bg-white/10">
              {Array.from(match.command).map((char, index, chars) => {
                const offset = chars.slice(0, index).join('').length;
                return match.indices.includes(offset) ? <mark key={index} className="bg-transparent text-amber-300">{char}</mark> : char;
              })}
            </button>)}
          </div>
        </div>}
        {historyError && <div role="status" className="shrink-0 text-xs text-amber-400" title={historyError}>命令历史读取或保存失败</div>}
      </div>
    </>
  );
}
