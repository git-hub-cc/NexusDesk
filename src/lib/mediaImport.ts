import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface MediaImportResult { imported: number; skipped: number; covers: number; errors: string[] }

export async function importMedia(kind: "music" | "video"): Promise<MediaImportResult | null> {
  const paths = await open({
    title: kind === "music" ? "导入音乐（自动匹配同名封面）" : "导入视频",
    multiple: true,
    directory: false,
    filters: [{ name: kind === "music" ? "音乐文件" : "视频文件", extensions: kind === "music"
      ? ["mp3", "flac", "m4a", "ogg", "wav", "aac"]
      : ["mp4", "m4v", "webm", "mov", "mkv", "avi", "ogv"] }],
  });
  if (!paths || !paths.length) return null;
  return invoke("import_media_files", { paths: Array.isArray(paths) ? paths : [paths], kind });
}

export function importSummary(result: MediaImportResult): string {
  return [`已导入 ${result.imported} 个文件`, result.covers ? `匹配 ${result.covers} 张专辑封面` : "",
    result.skipped ? `跳过 ${result.skipped} 个已在库中的文件或重复选择` : "",
    result.errors.length ? `${result.errors.length} 个文件导入失败：${result.errors.join("；")}` : ""].filter(Boolean).join("；");
}
