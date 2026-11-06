import { fsApi } from "@/lib/api";

const STORAGE_KEY = "note.project-save-location";

export async function getProjectSaveLocation(): Promise<string> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)?.trim();
    if (saved) return saved;
  } catch { /* Storage may be unavailable in restricted webviews. */ }
  return fsApi.desktopDirectory();
}

export function rememberProjectSaveLocation(path: string) {
  const location = path.trim();
  if (!location) return;
  try { localStorage.setItem(STORAGE_KEY, location); } catch { /* Keep the current dialog usable. */ }
}
