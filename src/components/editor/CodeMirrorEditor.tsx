import { isSnapshot } from "@/lib/snapshot";
import { invoke } from "@tauri-apps/api/core";
import { openNativePopup } from "@/lib/nativePopup";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { editorHighlighting, languageForPath } from "./syntaxHighlight";
import { Decoration, EditorView, WidgetType, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, highlightActiveLine, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentMore, indentLess, insertBlankLine, copyLineDown, deleteLine, moveLineUp, moveLineDown, toggleComment, redo, selectAll } from "@codemirror/commands";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import * as ContextMenu from "@/lib/nativeMenu";
import { Heading2, Bold, Italic, Code, Quote, Link as LinkIcon, Image as ImageIcon, Minus, Table as TableIcon, Video as VideoIcon } from "lucide-react";
import { flushEditorContent, hasPendingEditorContent, queueEditorContent, useWorkspaceStore } from "@/store/workspaceStore";
import { createLinkWire, fileHeadings, headingAt, highlightLinkTarget, linkEditors, linkTargetDecoration, relativeNotePath } from "./dragLink";
import { InsertTableDialog } from "./InsertTableDialog";
import { fsApi } from "@/lib/api";
import { assetMarkdown } from "@/lib/assets";
import { wikiLinkRange } from "./wikiLink";
import { wikiLinkCompletion } from "./wikiLinkCompletion";
import { expandSelection } from "./expandSelection";
import { formatCode } from "./formatCode";
import { countTreeGraphNames } from "@/lib/treeGraph";
import { readUI, writeUI, projectKey } from "@/lib/uiPersistence";
import { getSpeechTarget, setSpeechTarget } from "@/lib/speechTarget";

class SharedNodeCountWidget extends WidgetType {
  constructor(readonly count: number) { super(); }
  toDOM() { const span = document.createElement("span"); span.className = "cm-shared-node-count"; span.textContent = ` ×${this.count}`; return span; }
  eq(other: SharedNodeCountWidget) { return other.count === this.count; }
  ignoreEvent(event: Event) { return event.type !== "dblclick"; }
}
const setSharedNodeCounts = StateEffect.define<Map<string, number>>();
const sharedNodeCounts = StateField.define({
  create: () => Decoration.none,
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setSharedNodeCounts)) {
      const ranges = [];
      for (let line = 1; line <= transaction.state.doc.lines; line++) {
        const item = transaction.state.doc.line(line);
        const count = effect.value.get(item.text.trim());
        if (count && count > 1) ranges.push(Decoration.widget({ widget: new SharedNodeCountWidget(count), side: 1 }).range(item.to));
      }
      decorations = Decoration.set(ranges);
    }
    return decorations;
  },
  provide: field => EditorView.decorations.from(field),
});

function linkRangeAt(state: EditorState) {
  const selection = state.selection.main;
  const line = state.doc.lineAt(selection.from);
  if (selection.to > line.to) return null;
  const range = wikiLinkRange(line.text, selection.from - line.from, selection.to - line.from);
  return range ? { ...range, from: line.from + range.from, to: line.from + range.to } : null;
}

interface CodeMirrorEditorProps {
  tabId: string;
  navigationEnabled?: boolean;
  pane: "left" | "right";
}

type EditorLocation = {
  anchor: number;
  head: number;
  scroll: ReturnType<EditorView["scrollSnapshot"]>;
};
// Media/browser tabs unmount the source editor. Keep locations for open tabs.
const paneLocations = { left: new Map<string, EditorLocation>(), right: new Map<string, EditorLocation>() };
function saveLocation(pane: "left" | "right", id: string | null | undefined, view: EditorView, root = useWorkspaceStore.getState().rootPath) {
  if (!id || !root) return;
  const key = `${projectKey(root)}:${id}`;
  if (paneLocations[pane].size > 500) paneLocations[pane].delete(paneLocations[pane].keys().next().value!);
  paneLocations[pane].set(key, {
    anchor: view.state.selection.main.anchor,
    head: view.state.selection.main.head,
    scroll: view.scrollSnapshot(),
  });
  writeUI(root, `editor:${pane}:${id}`, {
    anchor: view.state.selection.main.anchor, head: view.state.selection.main.head,
    top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft,
  });
}

export const CodeMirrorEditor: React.FC<CodeMirrorEditorProps> = ({ pane, tabId, navigationEnabled = true }) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const locationsRef = useRef(paneLocations[pane]);

  const activeTabId = tabId;
  const activeTab = useWorkspaceStore(state => (pane === "left" ? state.leftTabs : state.rightTabs).find(tab => tab.id === tabId));
  const previousTabId = useRef(activeTabId);
  const setFocusedPane = useWorkspaceStore(state => state.setFocusedPane);
  const pushNavLocation = useWorkspaceStore(state => state.pushNavLocation);
  const editorJump = useWorkspaceStore(state => state.editorJump);
  const rootPath = useWorkspaceStore(state => state.rootPath);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const syncingContent = useRef(false);
  const composing = useRef(false);
  const pendingCompositionFlush = useRef(false);
  const tabRef = useRef(activeTab);
  tabRef.current = activeTab;
  const navigationEnabledRef = useRef(navigationEnabled);
  navigationEnabledRef.current = navigationEnabled;
  const [linkReady, setLinkReady] = useState(false);
  const [editingLink, setEditingLink] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [assetError, setAssetError] = useState("");
  const [sharedCounts, setSharedCounts] = useState<Map<string, number>>(new Map());
  const importing = useRef(false);
  const isMarkdown = /\.(md|markdown|mdown|mkd)$/i.test(activeTab?.path ?? "");

  useEffect(() => () => {
    const target = getSpeechTarget();
    if (target?.kind === "editor" && target.pane === pane) setSpeechTarget(null);
  }, [pane]);


  const importFiles = async (files: File[], paths: string[] = []) => {
    const tab = tabRef.current;
    const view = viewRef.current;
    if (!tab || !view || importing.current) return;
    importing.current = true;
    setAssetError("");
    const links: string[] = [];
    try {
      for (const sourcePath of paths) links.push(assetMarkdown(await fsApi.importAsset(tab.path, { sourcePath })));
      for (const file of files) links.push(assetMarkdown(await fsApi.importAsset(tab.path, {
        name: file.name || `asset-${Date.now()}.${file.type.split('/')[1] || 'bin'}`, bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
      })));
    } catch (error) { setAssetError(`导入资源失败：${String(error)}`); }
    finally {
      if (links.length && tabRef.current?.id === tab.id && viewRef.current === view) {
        const selection = view.state.selection.main;
        const insert = links.join("\n");
        view.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: { anchor: selection.from + insert.length }, userEvent: "input.paste" });
      } else if (links.length) setAssetError("资源已保存到 .asset；文档已切换，请重新插入链接。");
      importing.current = false;
      await useWorkspaceStore.getState().loadDirectory(tab.path.replace(/[/\\][^/\\]+$/, ""), false, true);
    }
  };
  const cancelDrag = useRef<(() => void) | null>(null);

  useEffect(() => {
    let live = true;
    if (!rootPath || !activeTab?.path.endsWith(".tree")) { setSharedCounts(new Map()); return; }
    void (async () => {
      try {
        const categories = await fsApi.getGraphCategories();
        const paths = [...new Set(categories.flatMap(category => category.files))];
        const trees = await Promise.all(paths.map(async path => ({ path, content: [...useWorkspaceStore.getState().leftTabs, ...useWorkspaceStore.getState().rightTabs].find(tab => tab.path === path && !tab.revision && tab.diff === undefined)?.content ?? await fsApi.readTreeFile(path) })));
        if (live) setSharedCounts(countTreeGraphNames(trees));
      } catch { if (live) setSharedCounts(new Map()); }
    })();
    return () => { live = false; };
  }, [rootPath, activeTab?.path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setSharedNodeCounts.of(/\.tree$/i.test(activeTab?.path ?? "") ? sharedCounts : new Map()) });
  }, [sharedCounts, activeTabId, activeTab?.content, activeTab?.path]);

  const startLinkDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const source = viewRef.current;
    const sourceTab = tabRef.current;
    if (!source || !sourceTab || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const range = linkRangeAt(source.state);
    if (!range) return;
    cancelDrag.current?.();
    const originalDoc = source.state.doc;
    const bounds = event.currentTarget.getBoundingClientRect();
    const wire = createLinkWire(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    const pointerId = event.pointerId;
    let target: { view: EditorView; from: number; title: string; path: string } | null = null;
    let fileTarget: { path: string; title?: string } | null = null;
    let hoveredFile: HTMLElement | null = null;
    const clearFile = () => {
      hoveredFile?.classList.remove("cm-link-target");
      hoveredFile = null;
      fileTarget = null;
    };
    const hoverFile = (row: HTMLElement) => {
      clearFile();
      hoveredFile = row;
      fileTarget = { path: row.dataset.linkFile! };
      row.classList.add("cm-link-target");
    };
    setDragging(true);
    const clearTarget = () => {
      if (target && linkEditors.has(target.view)) target.view.dispatch({ effects: highlightLinkTarget.of(null) });
      target = null;
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      wire.update(pointer.clientX, pointer.clientY);
      clearTarget();
      const element = document.elementFromPoint(pointer.clientX, pointer.clientY);
      const file = element?.closest<HTMLElement>("[data-link-file]");
      if (file) {
        if (file !== hoveredFile) hoverFile(file);
        fileTarget = { path: file.dataset.linkFile! };
        wire.update(pointer.clientX, pointer.clientY, true);
        return;
      }
      clearFile();
      if (!element) return;
      for (const [view, getTab] of linkEditors) {
        if (!view.dom.contains(element)) continue;
        const tab = getTab();
        const position = view.posAtCoords({ x: pointer.clientX, y: pointer.clientY });
        const heading = position === null ? null : headingAt(view, position);
        if (tab && heading) {
          target = { view, ...heading, path: tab.path };
          view.dispatch({ effects: highlightLinkTarget.of(heading.from) });
          const coords = view.coordsAtPos(heading.from);
          if (coords) wire.update(coords.left, (coords.top + coords.bottom) / 2, true);
        }
      }
    };
    const cleanup = () => {
      wire.remove();
      clearTarget();
      clearFile();
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", cleanup);
      cancelDrag.current = null;
    };
    const finish = async (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      move(pointer);
      const destination = fileTarget ?? target;
      cleanup();
      if (!destination || tabRef.current?.id !== sourceTab.id || source.state.doc !== originalDoc) return;
      if (destination.title === undefined) {
        try {
          const state = useWorkspaceStore.getState();
          const content = [...state.leftTabs, ...state.rightTabs].find(tab => tab.path === destination.path)?.content ?? await fsApi.readFile(destination.path);
          const headings = fileHeadings(content);
          if (headings.length) {
            const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
            const selected = await new Promise<number | null>(resolve => {
              let chosen = false;
              void openNativePopup(`<button data-action="file">链接到整个文件</button>` + headings.map((heading, index) => `<button data-action="${index}">${escapeHtml(heading.title)}</button>`).join(""), pointer.clientX, pointer.clientY, 280, id => { chosen = true; resolve(id === "file" ? -1 : Number(id)); }, () => { if (!chosen) resolve(null); });
            });
            if (selected === null) return;
            if (selected >= 0) destination.title = headings[selected]?.title;
          }
        } catch { /* Whole-file links remain available for unreadable targets. */ }
      }
      if (tabRef.current?.id !== sourceTab.id || source.state.doc !== originalDoc) return;
      const path = destination.path === sourceTab.path && destination.title !== undefined ? "" : relativeNotePath(sourceTab.path, destination.path);
      const escapeTarget = (text: string) => text.replace(/\[/g, "&#91;").replace(/\]/g, "&#93;").replace(/\|/g, "&#124;");
      const insert = `[[${escapeTarget(path)}${destination.title === undefined ? "" : `#${escapeTarget(destination.title)}`}${range.alias}]]`;
      source.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: { anchor: range.from + insert.length }, userEvent: "input" });
      setLinkReady(false);
      source.focus();
    };
    const escape = (key: KeyboardEvent) => { if (key.key === "Escape") { key.preventDefault(); cleanup(); } };
    cancelDrag.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", cleanup);
  };

  const insertMarkdown = (before: string, after: string, placeholder: string) => {
    const view = viewRef.current;
    if (!view) return;
    const { state } = view;
    const selection = state.selection.main;
    const selectedText = state.sliceDoc(selection.from, selection.to);
    const textToInsert = selectedText || placeholder;
    const insert = `${before}${textToInsert}${after}`;

    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert },
      selection: {
        anchor: selection.from + before.length,
        head: selection.from + before.length + textToInsert.length
      },
      userEvent: "input"
    });
    view.focus();
  };

  const handleInsertTable = (rows: number, cols: number) => {
    const view = viewRef.current;
    if (!view) return;
    let table = "\n";
    for (let i = 0; i < cols; i++) table += `| 列 ${i + 1} `;
    table += "|\n";
    for (let i = 0; i < cols; i++) table += "| --- ";
    table += "|\n";
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < cols; i++) table += "|     ";
      table += "|\n";
    }
    const { state } = view;
    const selection = state.selection.main;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: table },
      selection: { anchor: selection.from + table.length },
      userEvent: "input"
    });
    view.focus();
  };

  useLayoutEffect(() => {
    if (!editorRef.current) return;

    let compositionTimer: ReturnType<typeof setTimeout> | undefined;
    const updateLinkState = (state: EditorState) => {
      const range = linkRangeAt(state);
      setLinkReady(range !== null);
      setEditingLink(range?.existing ?? false);
    };
    const state = EditorState.create({
      doc: activeTab?.content || "",
      extensions: [
        EditorState.readOnly.of(isSnapshot || !!activeTab?.readOnly), EditorView.editable.of(!isSnapshot && !activeTab?.readOnly),
        // Non-editable content needs an explicit tab stop to receive keyboard commands.
        EditorView.contentAttributes.of(isSnapshot || activeTab?.readOnly ? { tabindex: "0" } : {}),
        editorHighlighting,
        languageCompartment.current.of([]),
        sharedNodeCounts,
        linkTargetDecoration,
        wikiLinkCompletion(() => tabRef.current?.path),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        highlightActiveLine(),
        search({ top: true }),
        EditorState.phrases.of({
          "next": "下一个",
          "previous": "上一个",
          "all": "全部",
          "match case": "区分大小写",
          "regexp": "正则表达式",
          "by word": "全词匹配",
          "replace": "替换",
          "replace all": "全部替换",
          "close": "关闭",
          "Find": "查找",
          "Replace": "替换为"
        }),
        keymap.of([
          { key: "Mod-a", run: selectAll, preventDefault: true },
          { key: "Mod-c", run: view => {
            if (!isSnapshot) return false;
            const text = view.state.selection.ranges.map(range => view.state.sliceDoc(range.from, range.to)).join("\n");
            if (text) void invoke("write_text_clipboard", { text }).catch(error => setAssetError(String(error)));
            return true;
          }, preventDefault: isSnapshot },
          { key: "Ctrl-Alt-l", preventDefault: true, run: view => {
            const tab = tabRef.current;
            if (tab) void formatCode(view, tab.path, () => viewRef.current === view && tabRef.current?.id === tab.id)
              .catch(error => setAssetError(`格式化失败：${error instanceof Error ? error.message : String(error)}`));
            return true;
          } },
          { key: "Mod-w", run: expandSelection, preventDefault: true },
          { key: "Shift-Enter", run: insertBlankLine },
          { key: "Tab", run: indentMore },
          { key: "Shift-Tab", run: indentLess },
          { key: "Mod-f", run: openSearchPanel },
          { key: "Mod-Shift-z", run: redo },
          ...searchKeymap,
          { key: "Mod-d", run: copyLineDown },
          { key: "Mod-y", run: deleteLine },
          { key: "Ctrl-Shift-ArrowUp", run: moveLineUp, preventDefault: true },
          { key: "Ctrl-Shift-ArrowDown", run: moveLineDown, preventDefault: true },
          { key: "Alt-Shift-ArrowUp", run: moveLineUp },
          { key: "Alt-Shift-ArrowDown", run: moveLineDown },
          { key: "Mod-/", run: toggleComment },
          {
            key: "Alt-Enter",
            run: (view) => {
              const { state } = view;
              const pos = state.selection.main.head;
              const currentLine = state.doc.lineAt(pos);

              const isListLine = (text: string) => {
                if (/^\s*$/.test(text)) return true;
                if (/^\s*\d+\.(?:\s|$)/.test(text)) return true;
                if (/^\s*[-*+](?:\s|$)/.test(text)) return true;
                if (/^\s+/.test(text)) return true;
                return false;
              };

              if (!isListLine(currentLine.text)) return false;

              let startLine = currentLine.number;
              while (startLine > 1) {
                if (!isListLine(state.doc.line(startLine - 1).text)) break;
                startLine--;
              }

              let endLine = currentLine.number;
              while (endLine < state.doc.lines) {
                if (!isListLine(state.doc.line(endLine + 1).text)) break;
                endLine++;
              }

              const changes = [];
              const counters: Record<number, number> = {};
              let hasOrderedList = false;

              for (let i = startLine; i <= endLine; i++) {
                const line = state.doc.line(i);
                const text = line.text;
                const match = text.match(/^(\s*)\d+\.(\s+.*)?$/);

                if (match) {
                  hasOrderedList = true;
                  const indent = match[1].length;
                  for (const key in counters) {
                    if (parseInt(key) > indent) delete counters[key];
                  }
                  counters[indent] = (counters[indent] || 0) + 1;
                  const newText = match[1] + counters[indent] + "." + (match[2] || "");
                  if (newText !== text) {
                    changes.push({ from: line.from, to: line.to, insert: newText });
                  }
                } else if (/^\s*[-*+](?:\s|$)/.test(text)) {
                  const indent = text.match(/^(\s*)/)![1].length;
                  for (const key in counters) {
                    if (parseInt(key) > indent) delete counters[key];
                  }
                }
              }

              if (!hasOrderedList) return false;

              if (changes.length > 0) {
                view.dispatch({ changes, userEvent: "input" });
              }
              return true;
            }
          },
          {
            key: "Mod-b",
            run: (view) => {
              const state = view.state;
              const pos = state.selection.main.head;
              const line = state.doc.lineAt(pos);

              const linkRegex = /\[\[([^\]]+)\]\]/g;
              let match;
              while ((match = linkRegex.exec(line.text)) !== null) {
                const start = line.from + match.index;
                const end = start + match[0].length;
                if (pos >= start && pos <= end) {
                  const linkTarget = match[1].split('#')[0];
                  if (linkTarget) {
                    const currentPath = tabRef.current?.path || "";
                    const targetPath = currentPath.replace(/[/\\][^/\\]+$/, "") + "/" + linkTarget;

                    useWorkspaceStore.getState().openTab({
                      id: targetPath, path: targetPath, title: linkTarget, isDirty: false
                    });
                    return true;
                  }
                }
              }
              return false;
            }
          },
          {
            key: "Enter",
            run: (view) => {
              const { state } = view;
              const selection = state.selection.main;
              if (!selection.empty) return false;
              const line = state.doc.lineAt(selection.head);
              const match = line.text.match(/^(\s*)([-*+]|\d+\.|- \[[ x]\])\s+(.*)$/);
              if (match) {
                const [_, indent, marker, content] = match;
                if (!content.trim()) {
                  view.dispatch({
                    changes: { from: line.from, to: line.to },
                    selection: { anchor: line.from }
                  });
                  return true;
                }
                let nextMarker = marker;
                if (/^\d+\./.test(marker)) {
                  nextMarker = `${parseInt(marker, 10) + 1}.`;
                } else if (marker === "- [x]" || marker === "- [ ]") {
                  nextMarker = "- [ ]";
                }
                view.dispatch({
                  changes: { from: selection.head, insert: `\n${indent}${nextMarker} ` },
                  selection: { anchor: selection.head + 1 + indent.length + nextMarker.length + 1 }
                });
                return true;
              }
              return false;
            }
          },
          { key: "Escape", run: () => { cancelDrag.current?.(); setLinkReady(false); return false; } },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          // IME transactions belong to CodeMirror until composition commits.
          // Avoid React state and navigation-store updates for intermediate text.
          if (composing.current || update.view.composing || compositionTimer !== undefined) return;
          if (update.docChanged || update.selectionSet) {
            updateLinkState(update.state);
          }
          if (update.docChanged && activeTabIdRef.current && !syncingContent.current && !update.view.composing) {
            queueEditorContent(activeTabIdRef.current, update.state.doc, pane);
          }
          if (update.selectionSet && update.transactions.some(tr => tr.isUserEvent("select") || tr.isUserEvent("input"))) {
            saveLocation(pane, activeTabIdRef.current, update.view);
            const pos = update.state.selection.main.head;
            if (tabRef.current?.path) {
              pushNavLocation(tabRef.current.path, pos);
            }
          }
        }),
        EditorView.domEventHandlers({
          compositionstart: () => {
            clearTimeout(compositionTimer);
            compositionTimer = undefined;
            composing.current = true;
            return false;
          },
          compositionend: (_event, view) => {
            composing.current = false;
            const id = activeTabIdRef.current;
            const path = tabRef.current?.path;
            const tabId = tabRef.current?.id;
            // Read after CodeMirror consumes the final composition/input event.
            clearTimeout(compositionTimer);
            compositionTimer = setTimeout(() => {
              compositionTimer = undefined;
              if (viewRef.current !== view || id !== activeTabIdRef.current ||
                  tabId !== tabRef.current?.id || path !== tabRef.current?.path || composing.current) return;
              updateLinkState(view.state);
              if (id && !syncingContent.current) queueEditorContent(id, view.state.doc, pane);
              if (path) pushNavLocation(path, view.state.selection.main.head);
              if (pendingCompositionFlush.current) {
                pendingCompositionFlush.current = false;
                flushEditorContent();
              }
            }, 0);
            return false;
          },
          dblclick: (event, view) => {
            if (!(event.target instanceof Element) || !event.target.closest(".cm-shared-node-count")) return false;
            const path = tabRef.current?.path;
            if (!path || !/\.tree$/i.test(path)) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos !== null) {
              flushEditorContent();
              useWorkspaceStore.getState().locateGraph(path, view.state.doc.lineAt(pos).number, pane);
              event.preventDefault();
              return true;
            }
            return false;
          },
          click: (_event, view) => {
            if (!composing.current && !view.composing && compositionTimer === undefined) updateLinkState(view.state);
            return false;
          },
          blur: () => {
            if (composing.current || compositionTimer !== undefined) pendingCompositionFlush.current = true;
            else flushEditorContent();
          },
          focusin: (event) => {
            const target = event.target as HTMLElement;
            if (target && target.tagName === "INPUT" && target.closest(".cm-search")) {
              target.setAttribute("autocomplete", "off");
            }
          },
          paste: (event) => {
            if (!/\.(md|markdown|mdown|mkd)$/i.test(tabRef.current?.path ?? "")) return false;
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.length) { event.preventDefault(); void importFiles(files); return true; }
            const text = event.clipboardData?.getData("text/plain") ?? "";
            const view = viewRef.current, id = tabRef.current?.id;
            event.preventDefault();
            const pasteText = () => {
              if (text && view && viewRef.current === view && tabRef.current?.id === id) {
                view.dispatch({ ...view.state.replaceSelection(text), userEvent: "input.paste", scrollIntoView: true });
              }
            };
            void fsApi.readFileClipboard().then(data => {
              if (data.paths.length && tabRef.current?.id === id) return importFiles([], data.paths);
              pasteText();
            }).catch(error => { if (text) pasteText(); else setAssetError(String(error)); });
            return true;
          },
          dragover: (event) => {
            if (/\.(md|markdown|mdown|mkd)$/i.test(tabRef.current?.path ?? "") && event.dataTransfer?.types.some(type => ["Files", "application/x-noteide-file", "application/x-noteide-logical-file"].includes(type))) { event.preventDefault(); return true; }
            return false;
          },
          drop: (event) => {
            if (!/\.(md|markdown|mdown|mkd)$/i.test(tabRef.current?.path ?? "")) return false;
            const path = event.dataTransfer?.getData("application/x-noteide-file") || event.dataTransfer?.getData("application/x-noteide-logical-file");
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (!path && !files.length) return false;
            event.preventDefault(); event.stopPropagation();
            void importFiles(files, path ? [path] : []); return true;
          },
          focus: () => {
            setFocusedPane(pane);
          }
        }),
        EditorView.theme({
          // Keep CodeMirror's panels and tooltips below application dialogs.
          "&": { height: "100%", isolation: "isolate", backgroundColor: "var(--ide-bg)", color: "var(--ide-fg)" },
          ".cm-scroller, .cm-content": { cursor: "text" },
          ".cm-gutters": { backgroundColor: "var(--ide-bg)", color: "#606366", border: "none" },
          ".cm-activeLineGutter": { backgroundColor: "var(--ide-selection-inactive)" },
          ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.03)" },
          ".cm-cursor": { borderLeftColor: "#a9b7c6" },
          ".cm-tooltip-autocomplete": { backgroundColor: "var(--ide-panel-bg)", color: "var(--ide-fg)", border: "1px solid var(--ide-panel-border)" },
          ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--ide-accent)", color: "white" },
          ".cm-link-target": { backgroundColor: "rgba(53, 116, 240, 0.25)", outline: "1px solid var(--ide-accent)" },
          ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
            backgroundColor: "rgba(255, 255, 255, 0.3)"
          },
          ".cm-content ::selection": { backgroundColor: "rgba(255, 255, 255, 0.3)" },
          ".cm-panel.cm-search": {
            backgroundColor: "var(--ide-panel-bg)",
            color: "var(--ide-fg)",
            padding: "8px 12px",
            borderBottom: "1px solid var(--ide-panel-border)",
            fontFamily: "inherit",
            fontSize: "12px",
            lineHeight: "28px"
          },
          ".cm-search input": {
            backgroundColor: "var(--ide-bg)",
            color: "var(--ide-fg)",
            border: "1px solid var(--ide-panel-border)",
            borderRadius: "4px",
            padding: "4px 8px",
            outline: "none",
            fontSize: "12px",
            marginRight: "8px",
            verticalAlign: "middle"
          },
          ".cm-search input:focus": {
            borderColor: "var(--ide-accent)"
          },
          ".cm-search button": {
            backgroundColor: "transparent",
            color: "var(--ide-fg)",
            border: "1px solid var(--ide-panel-border)",
            borderRadius: "4px",
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: "12px",
            transition: "all 0.2s",
            marginRight: "8px",
            verticalAlign: "middle"
          },
          ".cm-search button:hover": {
            backgroundColor: "var(--ide-selection-inactive)"
          },
          ".cm-search label": {
            display: "inline-flex",
            position: "relative",
            alignItems: "center",
            justifyContent: "center",
            padding: "4px",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "0 !important",
            lineHeight: "20px",
            marginRight: "8px",
            verticalAlign: "middle"
          },
          ".cm-search label::after": {
            fontSize: "13px"
          },
          '.cm-search label:has(input[name="case"])::after': {
            content: '"Aa"'
          },
          '.cm-search label:has(input[name="re"])::after': {
            content: '".*"'
          },
          '.cm-search label:has(input[name="word"])::after': {
            content: '"Ab"'
          },
          ".cm-search label:has(input:checked)": {
            backgroundColor: "#3574f0",
            color: "white"
          },
          ".cm-search label:has(input:focus-visible)": {
            outline: "2px solid var(--ide-accent)",
            outlineOffset: "2px"
          },
          ".cm-search input[type=checkbox]": {
            position: "absolute",
            opacity: "0",
            width: "1px",
            height: "1px",
            padding: "0",
            margin: "0",
            border: "none"
          },
          ".cm-search [name=close]": {
            position: "absolute",
            top: "8px",
            right: "8px",
            padding: "2px 6px",
            border: "none",
            fontSize: "16px",
            backgroundColor: "transparent",
            cursor: "pointer",
            marginRight: "0"
          },
          ".cm-search [name=close]:hover": {
            color: "white"
          }
        }, { dark: true })
      ]
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;
    const locationRoot = useWorkspaceStore.getState().rootPath;
    linkEditors.set(view, () => navigationEnabledRef.current ? tabRef.current : undefined);

    // Capture the outgoing document before React hides or replaces its DOM.
    const unsubscribeLocation = useWorkspaceStore.subscribe((state, previous) => {
      const activeId = pane === "left" ? state.activeLeftTabId : state.activeRightTabId;
      const previousId = pane === "left" ? previous.activeLeftTabId : previous.activeRightTabId;
      if ((activeId !== previousId || state.rootPath !== previous.rootPath) && previousId === previousTabId.current) saveLocation(pane, previousTabId.current, view, previous.rootPath);
    });
    const snapshotLocation = () => saveLocation(pane, previousTabId.current, view, locationRoot);
    const trackLocation = () => {
      if (previousTabId.current === tabRef.current?.id) snapshotLocation();
    };
    view.scrollDOM.addEventListener("scroll", trackLocation, { passive: true });
    window.addEventListener("noteide-snapshot-ui", snapshotLocation);
    window.addEventListener("blur", snapshotLocation);

    const handleJump = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const state = useWorkspaceStore.getState();
      const activeId = pane === "left" ? state.activeLeftTabId : state.activeRightTabId;
      if (navigationEnabledRef.current && activeId === tabRef.current?.id && detail.path === tabRef.current?.path && viewRef.current) {
        viewRef.current.dispatch({
          selection: { anchor: detail.pos },
          scrollIntoView: true
        });
        viewRef.current.focus();
      }
    };
    window.addEventListener("editor-jump", handleJump);

    return () => {
      unsubscribeLocation();
      view.scrollDOM.removeEventListener("scroll", trackLocation);
      window.removeEventListener("noteide-snapshot-ui", snapshotLocation);
      window.removeEventListener("blur", snapshotLocation);
      saveLocation(pane, previousTabId.current, view, locationRoot);
      clearTimeout(compositionTimer);
      window.removeEventListener("editor-jump", handleJump);
      cancelDrag.current?.();
      linkEditors.delete(view);
      flushEditorContent();
      view.destroy();
    };
  }, []); // 仅挂载时初始化

  useEffect(() => {
    cancelDrag.current?.();
    setLinkReady(false);
  }, [activeTabId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    view.dispatch({ effects: languageCompartment.current.reconfigure([]) });
    languageForPath(activeTab?.path ?? "").then(extension => {
      if (!cancelled && viewRef.current === view) {
        view.dispatch({ effects: languageCompartment.current.reconfigure(extension) });
      }
    }).catch(error => console.error("Unable to load syntax highlighting", error));
    return () => { cancelled = true; };
  }, [activeTab?.path]);

  // Content updates (including autosave feedback) must not restore a saved location.
  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      const currentDoc = view.state.doc.toString();
      const content = activeTab?.content ?? "";
      const pendingLocalEdit = previousTabId.current === activeTabId && activeTabId && hasPendingEditorContent(activeTabId, pane);
      if (currentDoc !== content && !pendingLocalEdit && !composing.current && !view.composing) {
        syncingContent.current = true;
        try {
          view.dispatch({
          changes: {
            from: 0,
            to: currentDoc.length,
            insert: content
          }
          });
        } finally {
          syncingContent.current = false;
        }
      }
    }
  }, [activeTabId, activeTab?.content]);

  // Restore only after switching documents, once the new content has synced.
  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      const previousId = previousTabId.current;
      const root = useWorkspaceStore.getState().rootPath;
      const location = root ? locationsRef.current.get(`${projectKey(root)}:${activeTabId}`) : undefined;
      const saved = root && activeTabId ? readUI<{ anchor: number; head: number; top: number; left: number }>(root, `editor:${pane}:${activeTabId}`) : undefined;
      if (location) {
        const length = view.state.doc.length;
        const anchor = Math.min(location.anchor, length);
        const head = Math.min(location.head, length);
        view.dispatch({ selection: { anchor, head }, effects: location.scroll });
      } else if (saved && [saved.anchor, saved.head, saved.top, saved.left].every(value => Number.isFinite(value) && value >= 0)) {
        const length = view.state.doc.length;
        view.dispatch({ selection: { anchor: Math.min(saved.anchor, length), head: Math.min(saved.head, length) } });
        view.requestMeasure({ read: () => null, write: () => {
          if (previousTabId.current !== activeTabId) return;
          view.scrollDOM.scrollTop = saved.top;
          view.scrollDOM.scrollLeft = saved.left;
        } });
      } else if (previousId !== activeTabId) {
        view.dispatch({ selection: { anchor: 0 } });
        view.scrollDOM.scrollTop = 0;
        view.scrollDOM.scrollLeft = 0;
      }
      previousTabId.current = activeTabId;
    }
  }, [activeTabId]);

  // Apply after the active document has synced, including newly mounted editors.
  useEffect(() => {
    const view = viewRef.current;
    if (!navigationEnabled || !view || !editorJump || editorJump.path !== activeTab?.path || editorJump.pane !== pane) return;
    const line = view.state.doc.line(Math.max(1, Math.min(editorJump.line, view.state.doc.lines)));
    view.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    view.focus();
    if (useWorkspaceStore.getState().editorJump === editorJump) useWorkspaceStore.setState({ editorJump: null });
  }, [editorJump, activeTabId, activeTab?.path, activeTab?.content, pane, navigationEnabled]);

  return (
    <>
    {assetError && <div role="alert" className="absolute bottom-2 left-2 right-2 z-30 bg-ide-panel-bg p-2 text-xs text-red-400" onClick={() => setAssetError("")}>{assetError}（点击关闭）</div>}
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild disabled={isSnapshot || !isMarkdown}>
        <div
          ref={editorRef}
          className="absolute inset-0 text-sm font-mono"
          onClick={() => { setFocusedPane(pane); setSpeechTarget({ kind: "editor", pane }); }}
        />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="ide-menu w-56 text-sm" collisionPadding={8}>
          {isMarkdown && !isSnapshot && (
            <>
              <ContextMenu.Item className="ide-menu-item" onSelect={() => insertMarkdown("## ", "", "标题")}>
                <Heading2 size={14} className="text-gray-400" /> 二级标题
              </ContextMenu.Item>
              <ContextMenu.Item className="ide-menu-item" onSelect={() => insertMarkdown("**", "**", "加粗文本")}>
                <Bold size={14} className="text-gray-400" /> 粗体
              </ContextMenu.Item>
              <ContextMenu.Item className="ide-menu-item" onSelect={() => insertMarkdown("*", "*", "斜体文本")}>
                <Italic size={14} className="text-gray-400" /> 斜体
              </ContextMenu.Item>
              <ContextMenu.Separator className="h-px bg-[#4b5054] my-1 mx-2" />
              <ContextMenu.Item className="ide-menu-item" onSelect={() => insertMarkdown("```\n", "\n```", "代码块")}>
                <Code size={14} className="text-gray-400" /> 代码块
              </ContextMenu.Item>
              <ContextMenu.Item className="ide-menu-item" onSelect={() => insertMarkdown("> ", "", "引用内容")}>
                <Quote size={14} className="text-gray-400" /> 引用块
              </ContextMenu.Item>
              <ContextMenu.Separator className="h-px bg-[#4b5054] my-1 mx-2" />
              <ContextMenu.Item className="ide-menu-item" onSelect={() => insertMarkdown("[", "](url)", "链接文本")}>
                <LinkIcon size={14} className="text-gray-400" /> 链接
              </ContextMenu.Item>
              <ContextMenu.Item className="ide-menu-item" onSelect={() => insertMarkdown("![", "](url)", "图片描述")}>
                <ImageIcon size={14} className="text-gray-400" /> 图片
              </ContextMenu.Item>
              <ContextMenu.Item className="ide-menu-item" onSelect={() => insertMarkdown("[", "](url)", "视频描述")}>
                <VideoIcon size={14} className="text-gray-400" /> 视频
              </ContextMenu.Item>
              <ContextMenu.Item className="ide-menu-item" onSelect={() => setTableDialogOpen(true)}>
                <TableIcon size={14} className="text-gray-400" /> 表格...
              </ContextMenu.Item>
              <ContextMenu.Item className="ide-menu-item" onSelect={() => insertMarkdown("\n---\n", "", "")}>
                <Minus size={14} className="text-gray-400" /> 水平分割线
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
    {linkReady && (
      <div className="absolute top-2 right-4 z-20 flex items-center gap-2 rounded border border-blue-500/60 bg-ide-panel-bg px-3 py-2 text-xs shadow-lg">
        <button type="button" onPointerDown={startLinkDrag} className="cursor-crosshair touch-none text-blue-400" aria-label={editingLink ? "拖拽重新设置双链目标" : "拖拽到文件或标题生成双链"}>
          {dragging ? "松手链接到目标文件或标题" : editingLink ? "⤳ 拖拽重新建立链接" : "⤳ 拖拽到文件或标题生成双链"}
        </button>
        <button type="button" onClick={() => { cancelDrag.current?.(); setLinkReady(false); }} aria-label="取消双链生成">×</button>
      </div>
    )}
    {tableDialogOpen && (
      <InsertTableDialog
        onClose={() => setTableDialogOpen(false)}
        onInsert={handleInsertTable}
      />
    )}
    </>
  );
};
