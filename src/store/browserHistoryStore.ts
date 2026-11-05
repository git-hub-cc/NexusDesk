import { create } from "zustand";
import { persist } from "zustand/middleware";
import { globalJsonStorage } from "@/lib/globalSettings";

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
}

export function recordVisit(entries: BrowserHistoryEntry[], value: string): BrowserHistoryEntry[] {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return entries;
    return [{ url: url.href, title: url.hostname, visitedAt: Date.now() },
      ...entries.filter(entry => entry.url !== url.href)].slice(0, 500);
  } catch { return entries; }
}

export function searchHistory(entries: BrowserHistoryEntry[], query: string): BrowserHistoryEntry[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => {
    let decoded = entry.url;
    try { decoded = decodeURI(entry.url); } catch { /* Keep malformed escapes searchable. */ }
    const text = `${entry.title} ${entry.url} ${decoded}`.toLocaleLowerCase();
    return words.every(word => text.includes(word));
  }).slice(0, 8);
}

export function removeHistoryEntry(entries: BrowserHistoryEntry[], value: string): BrowserHistoryEntry[] {
  return entries.filter(entry => entry.url !== value);
}

export const useBrowserHistoryStore = create<{
  entries: BrowserHistoryEntry[];
  visit: (url: string) => void;
  remove: (url: string) => void;
}>()(persist((set) => ({
  entries: [],
  visit: url => set(state => ({ entries: recordVisit(state.entries, url) })),
  remove: url => set(state => ({ entries: removeHistoryEntry(state.entries, url) })),
}), { name: "nexusdesk-browser-history", storage: globalJsonStorage, version: 1 }));
