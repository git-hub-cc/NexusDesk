import { File, FileCode, FileJson, FileText, Image, FileArchive, FileAudio, FileVideo, Settings, Folder, FolderOpen, FileType, FolderCode, FolderCog, FolderGit2, FolderClosed, FolderCheck, FileSpreadsheet, Database, Braces, FileTerminal, Globe } from "lucide-react";

export function FileIcon({ name, directory = false, open = false }: { name: string; directory?: boolean; open?: boolean }) {
  if (directory) {
    const lower = name.toLowerCase();
    const [ClosedIcon, color] = ["src", "source", "lib", "components"].includes(lower) ? [FolderCode, "#74b0f4"]
      : ["test", "tests", "__tests__", "spec"].includes(lower) ? [FolderCheck, "#85c88a"]
      : ["assets", "images", "public", "static"].includes(lower) ? [Folder, "#b79ad8"]
      : lower === ".git" ? [FolderGit2, "#dfa082"]
      : [".idea", ".vscode", ".config", "config", ".note"].includes(lower) ? [FolderCog, "#a8a29e"]
      : ["node_modules", "vendor", "target", "dist", "build"].includes(lower) ? [FolderClosed, "#a78b70"]
      : [Folder, "#d9b864"];
    const Icon = open ? FolderOpen : ClosedIcon;
    return <Icon size={14} className="shrink-0" style={{ color }} aria-hidden="true" />;
  }
  const lower = name.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  const [Icon, color] = lower === ".gitignore" || /^(dockerfile|makefile|\.env.*)$/.test(lower)
    ? [Settings, "#a8a29e"]
    : ["json", "jsonc"].includes(ext) ? [FileJson, "#d9b864"]
    : ext === "tsx" ? [Braces, "#74b0f4"]
    : ext === "jsx" ? [Braces, "#61c9db"]
    : ["ts", "mts", "cts"].includes(ext) ? [FileCode, "#74b0f4"]
    : ["sh", "bash", "zsh", "ps1", "bat", "cmd"].includes(ext) ? [FileTerminal, "#85c88a"]
    : ["sql", "db", "sqlite", "sqlite3"].includes(ext) ? [Database, "#d9b864"]
    : ["csv", "tsv", "xls", "xlsx"].includes(ext) ? [FileSpreadsheet, "#85c88a"]
    : ["css", "scss", "sass", "less"].includes(ext) ? [FileCode, "#b79ad8"]
    : ["js", "jsx", "mjs", "cjs"].includes(ext) ? [FileCode, "#e8cb69"]
    : ["rs"].includes(ext) ? [FileCode, "#dfa082"]
    : ["py", "java", "c", "h", "cpp", "go", "vue", "html", "css", "scss", "sh", "ps1", "sql"].includes(ext) ? [FileCode, "#94bd96"]
    : ["md", "mdx", "txt"].includes(ext) ? [FileText, "#91b8d9"]
    : ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"].includes(ext) ? [Image, "#b79ad8"]
    : ["zip", "tar", "gz", "7z", "rar"].includes(ext) ? [FileArchive, "#c8aa79"]
    : ["mp3", "wav", "ogg", "flac"].includes(ext) ? [FileAudio, "#b79ad8"]
    : ["mp4", "webm", "mov"].includes(ext) ? [FileVideo, "#b79ad8"]
    : ["toml", "yaml", "yml", "ini", "xml", "lock"].includes(ext) ? [Settings, "#a8a29e"]
    : ["ttf", "woff", "woff2", "otf"].includes(ext) ? [FileType, "#a8a29e"]
    : ["http", "rest"].includes(ext) ? [Globe, "#3574f0"]
    : [File, "#9ca3af"];
  return <Icon size={14} className="shrink-0" style={{ color }} aria-hidden="true" />;
}