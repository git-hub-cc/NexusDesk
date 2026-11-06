import { useRef, useState } from "react";
import { gitApi } from "@/lib/api";
import { isImage } from "@/lib/assets";
import { diffChanges, parseGitDiff } from "@/lib/gitDiff";
import { flushPendingWrites, useWorkspaceStore, type Tab } from "@/store/workspaceStore";
import { EditableGitDiff } from "./EditableGitDiff";
import { GitDiffEditor } from "./GitDiffEditor";

let navigationToken = 0;

export function GitComparison({ tab, pane, onChange }: { tab: Tab; pane: "left" | "right"; onChange: (text: string) => void }) {
  const navigating = useRef(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const boundary = async (direction: number) => {
    const context = tab.diffContext;
    if (!context || navigating.current) return;
    navigating.current = true; setBusy(true); setNotice("");
    try {
      await flushPendingWrites();
      const staged = !!tab.diffStaged;
      const files = tab.revision ? await gitApi.revisionChanges(context.root, tab.revision)
        : (await gitApi.status(context.root)).filter(file => !file.conflict && (staged ? file.staged : file.unstaged));
      const ordered = files.filter(file => !isImage(file.path)).sort((a, b) => a.path.localeCompare(b.path));
      const current = ordered.findIndex(file => file.path === context.path);
      // Continue in the same comparison scope, without wrapping back to the first file.
      const candidates = current >= 0 ? (direction > 0 ? ordered.slice(current + 1) : ordered.slice(0, current).reverse())
        : ordered.filter(file => direction > 0 ? file.path.localeCompare(context.path) > 0 : file.path.localeCompare(context.path) < 0).sort((a, b) => direction * a.path.localeCompare(b.path));
      for (const file of candidates) {
        const patch = tab.revision ? await gitApi.revisionDiff(context.root, tab.revision, file.path)
          : await gitApi.diff(context.root, file.path, staged);
        if (!diffChanges(parseGitDiff(patch)).length) continue;
        const store = useWorkspaceStore.getState();
        if ((pane === "left" ? store.activeLeftTabId : store.activeRightTabId) !== tab.id || store.rootPath !== context.root) return;
        store.setFocusedPane(pane);
        store.openTab({
          id: tab.revision ? `git-revision:${context.root}:${tab.revision}:${file.path}` : `git-diff:${context.root}:${file.path}:${staged}`,
          path: !tab.revision && "worktreePath" in file && typeof file.worktreePath === "string" && !staged ? file.worktreePath : file.path,
          title: `${file.path.split("/").pop()} ${tab.revision ? `@${tab.revision.slice(0, 8)}` : staged ? "(已暂存)" : "(工作区)"}`,
          diff: patch, diffStaged: staged, diffReadOnly: file.status === "删除", revision: tab.revision,
          diffLabels: tab.diffLabels, diffContext: { root: context.root, path: file.path },
          diffEntry: { edge: direction > 0 ? "first" : "last", token: ++navigationToken },
        });
        return;
      }
      setNotice(direction > 0 ? "已是最后一处差异" : "已是第一处差异");
    } catch (error) { setNotice(String(error)); }
    finally { navigating.current = false; setBusy(false); }
  };
  const editable = !tab.revision && !tab.diffStaged && !tab.diffReadOnly && !/^(?:Binary files |GIT binary patch)/m.test(tab.diff ?? "");
  const props = { patch: tab.diff ?? "", title: tab.title, labels: tab.diffLabels, initialEdge: tab.diffEntry?.edge,
    onBoundary: tab.diffContext ? boundary : undefined, navigationBusy: busy };
  return <>
    {editable ? <EditableGitDiff {...props} path={tab.path} onChange={onChange} /> : <GitDiffEditor {...props} staged={!!tab.diffStaged} />}
    {notice && <div role="status" className="git-diff-navigation-notice" onClick={() => setNotice("")}>{notice}</div>}
  </>;
}
