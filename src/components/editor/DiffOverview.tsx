export interface DiffMark { top: number; height: number; kind: "added" | "removed" | "modified" }

export function DiffOverview({ marks, selected, onSelect }: { marks: DiffMark[]; selected: number; onSelect: (index: number) => void }) {
  return <div tabIndex={-1} className="git-diff-overview outline-none focus:outline-none" aria-label="差异位置概览">
    {marks.map((mark, index) => <button key={index} type="button"
      className={`git-diff-overview-mark ${mark.kind} ${selected === index ? "selected" : ""}`}
      style={{ top: `${Math.min(99, mark.top * 100)}%`, height: `${mark.height * 100}%` }}
      title={`第 ${index + 1} 处差异 · ${{ added: "新增", removed: "删除", modified: "修改" }[mark.kind]}`}
      aria-label={`跳转到第 ${index + 1} 处差异`} onClick={() => onSelect(index)} />)}
  </div>;
}
