import { fsApi } from "./api";

const drafts = new Map<string, string>();
const updates = new Map<string, Promise<void>>();
export const commitDraftEvent = "commit-draft-updated";
export const getCommitDraft = (root: string) => drafts.get(root);
export function rememberCommitDraft(root: string, message: string) {
  drafts.set(root, message);
}

export async function fillCodexCommitMessage(root: string, message: string): Promise<void> {
  if (!message.trim() || message.trimStart().startsWith("/")) return;
  const previous = updates.get(root) ?? Promise.resolve();
  const update = previous.catch(() => {}).then(async () => {
    const path = `${root}/.git/noteide_commit_msg.txt`;
    if (!await fsApi.isDirectory(`${root}/.git`)) return;
    let saved = drafts.get(root);
    if (saved === undefined) {
      try { saved = await fsApi.readFile(path); } catch { saved = ""; }
    }
    // Recheck after I/O so a user's edits are included in the appended draft.
    const current = drafts.get(root) ?? saved;
    const next = current.trim() ? `${current}\n${message}` : message;
    await fsApi.writeFile(path, next);
    drafts.set(root, next);
    window.dispatchEvent(new CustomEvent(commitDraftEvent, { detail: { root, message: next } }));
  });
  updates.set(root, update);
  await update.finally(() => {
    if (updates.get(root) === update) updates.delete(root);
  });
}

export function codexComposerInput(buffer: {
  baseY: number; cursorY: number;
  getLine(row: number): { isWrapped: boolean; translateToString(trim?: boolean): string } | undefined;
}): string | undefined {
  const lines: string[] = [];
  for (let row = buffer.baseY + buffer.cursorY; row >= buffer.baseY; row--) {
    const line = buffer.getLine(row);
    if (!line) return;
    const text = line.translateToString(true);
    const prompt = /^\s*› ?(.*)$/.exec(text);
    if (prompt) return [prompt[1], ...lines].join("").trim();
    if (!line.isWrapped) return;
    lines.unshift(text);
  }
}
