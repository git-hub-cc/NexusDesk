import type { TreeFileStatus } from "@/lib/api";

export function buildTreeStatuses(
    entries: { path: string; status: string }[],
    root: string
): Record<string, TreeFileStatus> {
  const statuses: Record<string, TreeFileStatus> = {};

  // 状态优先级，决定父目录显示哪个子文件的状态（数值越大优先级越高）
  const priority: Record<TreeFileStatus, number> = {
    conflict: 7,
    deleted: 6,
    modified: 5,
    added: 4,
    untracked: 3,
    ignored: 2,
    clean: 1,
  };

  const normalizedRoot = root.replace(/\\/g, "/");

  for (const entry of entries) {
    let current = entry.path.replace(/\\/g, "/");
    const status = entry.status as TreeFileStatus;
    const weight = priority[status] || 0;

    // 向上冒泡状态直到根目录
    while (current.length >= normalizedRoot.length) {
      const existing = statuses[current];
      if (!existing || weight > (priority[existing] || 0)) {
        statuses[current] = status;
      }
      const slash = current.lastIndexOf("/");
      if (slash < 0) break;
      current = current.slice(0, slash);
    }
  }
  return statuses;
}

export function treeStatusFor(path: string, statuses: Record<string, TreeFileStatus>): TreeFileStatus | undefined {
  const status = statuses[path.replace(/\\/g, "/")];
  // clean 状态通常不需要在文件树 UI 中特别高亮，因此返回 undefined
  return status === "clean" ? undefined : status;
}

export const statusLabels: Record<TreeFileStatus, string> = {
  ignored: "已忽略",
  modified: "已修改",
  added: "新增",
  untracked: "未跟踪",
  conflict: "冲突",
  deleted: "已删除",
  clean: "未修改", // 修复：补充了 clean 状态
};