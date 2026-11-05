import { autocompletion, acceptCompletion } from "@codemirror/autocomplete";
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { fsApi } from "@/lib/api";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { relativeNotePath } from "./dragLink";
import { wikiCompletionRange } from "./wikiLink";

export function wikiLinkCompletion(currentPath: () => string | undefined) {
  let cachedRoot: string | null = null;
  let expires = 0;
  let files: Promise<string[]> | undefined;
  async function listFiles(path: string): Promise<string[]> {
    const nodes = await fsApi.readDirectory(path);
    const result: string[] = [];
    // Walk sequentially to avoid flooding the native bridge on large projects.
    for (const node of nodes) {
      if (node.missing) continue;
      if (node.isLeaf) result.push(node.id);
      else if (![".git", "node_modules", "target", ".idea"].includes(node.name)) {
        result.push(...await listFiles(node.id).catch(() => []));
      }
    }
    return result;
  }
  return [
    autocompletion({
      activateOnTypingDelay: 0,
      interactionDelay: 0,
      override: [async context => {
        const source = currentPath();
        const root = useWorkspaceStore.getState().rootPath;
        if (!source || !root || context.state.readOnly || !context.state.selection.main.empty) return null;
        const line = context.state.doc.lineAt(context.pos);
        const range = wikiCompletionRange(line.text, context.pos - line.from);
        if (!range) return null;
        if (!files || cachedRoot !== root || Date.now() > expires) {
          cachedRoot = root;
          expires = Date.now() + 5000;
          files = listFiles(root).catch(() => []);
        }
        const paths = await files;
        if (context.aborted || currentPath() !== source || useWorkspaceStore.getState().rootPath !== root) return null;
        return {
          from: line.from + range.from,
          to: line.from + range.to,
          options: paths.filter(path => !/[\[\]#|\r\n]/.test(path)).map(path => {
            const relative = relativeNotePath(source, path);
            return {
              label: relative,
              displayLabel: path.split(/[/\\]/).pop(),
              detail: relative,
              type: "file",
              apply: (view: import("@codemirror/view").EditorView, _completion: unknown, from: number, to: number) => {
                const insert = relative + "]]";
                view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.complete" });
              },
            };
          }),
        };
      }],
    }),
    Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
  ];
}
