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
export const CUSTOM_CATEGORY_ID = "custom-user-sites";

export function navigationFaviconUrl(value: string): string {
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error("请输入 HTTP 或 HTTPS 网站地址");
  return `${url.origin}/favicon.ico`;
}

export function findNavigationBookmark(data: NavigationData, url: string): NavigationSite | undefined {
  return data.categories.find(category => category.categoryId === CUSTOM_CATEGORY_ID)?.sites.find(site => {
    try { return new URL(site.url).href === new URL(url).href; }
    catch { return false; }
  });
}

export function upsertNavigationSite(data: NavigationData, categoryId: string, site: NavigationSite): NavigationData {
  let categories = data.categories;
  if (!categories.some(category => category.categoryId === categoryId)) {
    if (categoryId !== CUSTOM_CATEGORY_ID) throw new Error("导航分类已不存在，请重新打开后再试");
    categories = [{ categoryId, categoryName: "我的导航", sites: [] }, ...categories];
  }
  return { categories: categories.map(category => {
    if (category.categoryId !== categoryId) return category;
    const duplicate = category.sites.find(item => {
      if (item.id === site.id) return false;
      try { return new URL(item.url).href === new URL(site.url).href; }
      catch { return false; }
    });
    if (duplicate) throw new Error("该网址已存在，请编辑已有网站");
    const exists = category.sites.some(item => item.id === site.id);
    return { ...category, sites: exists ? category.sites.map(item => item.id === site.id ? site : item) : [site, ...category.sites] };
  }) };
}

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
    const custom = stored.categories.find(category => category.categoryId === CUSTOM_CATEGORY_ID)
      ?? { categoryId: CUSTOM_CATEGORY_ID, categoryName: "我的导航", sites: [] };
    const normalized = { categories: [custom, ...stored.categories.filter(category => category.categoryId !== CUSTOM_CATEGORY_ID)].map(category => ({
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
  const migrated = { categories: [
    ...merged.filter(category => category.categoryId === CUSTOM_CATEGORY_ID),
    ...merged.filter(category => category.categoryId !== CUSTOM_CATEGORY_ID),
  ] };
  saveNavigationData(migrated);
  return migrated;
}

export function saveNavigationData(data: NavigationData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  window.dispatchEvent(new CustomEvent("nexusdesk-navigation-data-changed", { detail: data }));
}

export const navigationStorageKey = STORAGE_KEY;
