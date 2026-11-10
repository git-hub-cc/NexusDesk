import resourceDataUrl from "@/assets/navigation/data/01资源.json?url";
import serviceDataUrl from "@/assets/navigation/data/02服务.json?url";

export type NavigationSite = {
  id: string;
  title: string;
  url: string;
  desc?: string;
  icon?: string | { sprite: string; x: number; y: number; width: number; height: number; spriteWidth: number; spriteHeight: number };
  proxy?: boolean;
};

export type NavigationCategory = { categoryId: string; categoryName: string; sites: NavigationSite[] };
export type NavigationData = { categories: NavigationCategory[] };

const STORAGE_KEY = "nexusdesk-navigation-data-v1";
const LEGACY_KEYS = ["my-awesome-nav-data", "nav-custom-user-sites-data", "nav-custom-data-sources"];
const sourceFiles = [resourceDataUrl, serviceDataUrl];

function parseData(value: unknown): NavigationData | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as NavigationData).categories)) return null;
  return value as NavigationData;
}

function siteKey(site: NavigationSite) {
  return site.url.toLocaleLowerCase();
}

function mergeCategories(...groups: NavigationCategory[][]): NavigationCategory[] {
  const categories = new Map<string, NavigationCategory>();
  for (const group of groups) for (const incoming of group) {
    if (!incoming?.categoryId || !incoming.categoryName || !Array.isArray(incoming.sites)) continue;
    const category = categories.get(incoming.categoryId) ?? { ...incoming, sites: [] };
    const known = new Set(category.sites.map(siteKey));
    for (const site of incoming.sites) {
      if (!site?.url || !site?.title || known.has(siteKey(site))) continue;
      category.sites.push({ ...site, id: site.id || crypto.randomUUID() });
      known.add(siteKey(site));
    }
    categories.set(incoming.categoryId, category);
  }
  return [...categories.values()];
}

export function mergeNavigationData(primary: NavigationData, secondary: NavigationData): NavigationData {
  return { categories: mergeCategories(primary.categories, secondary.categories) };
}

async function loadBundledData(): Promise<NavigationData> {
  const data = await Promise.all(sourceFiles.map(async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("读取导航数据失败");
    return parseData(await response.json())?.categories ?? [];
  }));
  return { categories: mergeCategories(...data) };
}

export async function loadNavigationData(): Promise<NavigationData> {
  let stored: NavigationData | null = null;
  try { stored = parseData(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")); }
  catch { localStorage.removeItem(STORAGE_KEY); }
  if (stored) {
    const normalized = { categories: stored.categories.map(category => ({
      ...category,
      sites: category.sites.map(site => ({ ...site, id: site.id || crypto.randomUUID() })),
    })) };
    if (JSON.stringify(normalized) !== JSON.stringify(stored)) saveNavigationData(normalized);
    return normalized;
  }

  const base = await loadBundledData();
  const legacy: NavigationCategory[][] = [];
  let cachedBase: NavigationCategory[] | null = null;
  for (const key of LEGACY_KEYS) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "null");
      if (key === "nav-custom-data-sources" && Array.isArray(parsed)) {
        legacy.push(...parsed.map(source => parseData(source?.data)?.categories ?? []));
      } else if (key === "nav-custom-user-sites-data") {
        if (parsed && Array.isArray(parsed.sites)) legacy.push([{ ...parsed, categoryId: parsed.categoryId || "custom-user-sites", categoryName: parsed.categoryName || "我的导航" }]);
      } else if (key === "my-awesome-nav-data" && parseData(parsed)) cachedBase = parsed.categories;
      else if (parseData(parsed)) legacy.push(parsed.categories);
    } catch { /* Ignore invalid legacy cache and keep the bundled data usable. */ }
  }
  const merged = mergeCategories(...(cachedBase ? [cachedBase, base.categories] : [base.categories]), ...legacy);
  if (!merged.some(category => category.categoryId === "custom-user-sites")) {
    merged.unshift({ categoryId: "custom-user-sites", categoryName: "我的导航", sites: [] });
  }
  const migrated = { categories: merged };
  saveNavigationData(migrated);
  return migrated;
}

export function saveNavigationData(data: NavigationData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  window.dispatchEvent(new CustomEvent("nexusdesk-navigation-data-changed", { detail: data }));
}

export const navigationStorageKey = STORAGE_KEY;
