import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ExternalLink, Globe, Plus, Search, Trash2 } from "lucide-react";
import engineConfigUrl from "@/assets/navigation/data/00engines.json?url";
import sprite01 from "@/assets/navigation/img/sprite-01.webp";
import sprite02 from "@/assets/navigation/img/sprite-02.webp";
import sprite03 from "@/assets/navigation/img/sprite-03.webp";
import sprite04 from "@/assets/navigation/img/sprite-04.webp";
import sprite05 from "@/assets/navigation/img/sprite-05.webp";
import { loadNavigationData, mergeNavigationData, saveNavigationData, type NavigationCategory, type NavigationData, type NavigationSite, CUSTOM_CATEGORY_ID, upsertNavigationSite } from "./navigationData";
import { initializeNavigationSync } from "./navigationSync";
import { NavigationSiteDialog } from "./NavigationSiteDialog";
import "./navigation.css";

type SearchEngine = { name: string; url: string; proxy?: boolean; desc?: string };
type SearchConfig = { categories: { label: string; value: string }[]; engines: Record<string, SearchEngine[]> };
const spriteUrls: Record<string, string> = {
  "sprite-01.webp": sprite01,
  "sprite-02.webp": sprite02,
  "sprite-03.webp": sprite03,
  "sprite-04.webp": sprite04,
  "sprite-05.webp": sprite05,
};

function newSite(): NavigationSite { return { id: crypto.randomUUID(), title: "", url: "https://", desc: "", proxy: false }; }

export function NavigationHome({ onNavigate }: { onNavigate: (url: string) => void }) {
  const [data, setData] = useState<NavigationData>({ categories: [] });
  const [searchConfig, setSearchConfig] = useState<SearchConfig>({ categories: [], engines: {} });
  const [searchType, setSearchType] = useState("");
  const [selectedEngines, setSelectedEngines] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("");
  const [proxyMode, setProxyMode] = useState(localStorage.getItem("proxy-mode-preference") === "true");
  const [dark, setDark] = useState(true);
  const [editing, setEditing] = useState<{ categoryId: string; site: NavigationSite } | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const editedDuringLoad = useRef(false);
  const dataRef = useRef(data);
  const dataRevision = useRef(0);
  dataRef.current = data;

  useEffect(() => {
    let alive = true;
    void (async () => {
      const revision = dataRevision.current;
      const [navigation, config] = await Promise.all([
        loadNavigationData(),
        fetch(engineConfigUrl, { signal: AbortSignal.timeout(10000) }).then(response => {
          if (!response.ok) throw new Error(`读取搜索配置失败 (${response.status})`);
          return response.json() as Promise<SearchConfig>;
        }),
      ]);
      if (!alive) return;
      if (revision === dataRevision.current) setData(navigation);
      setSearchConfig(config);
      setSearchType(config.categories[0]?.value || "");
      setSelectedEngines(config.engines[config.categories[0]?.value || ""]?.[0] ? [config.engines[config.categories[0]?.value || ""][0].name] : []);
      setActiveCategory(navigation.categories[0]?.categoryId || "");
      setReady(true);
      setLoadError("");
    })().catch(error => {
      console.error("无法加载导航数据:", error);
      if (alive) setLoadError(String(error));
    });
    void initializeNavigationSync().then(async result => {
      if (!alive || !result) return;
      const syncedNavigation = await loadNavigationData();
      if (!alive || !syncedNavigation) return;
      if (editedDuringLoad.current) {
        window.alert("云端同步已完成。同步期间你编辑了导航，已保留这些编辑并与同步结果合并。");
        const merged = mergeNavigationData(dataRef.current, syncedNavigation);
        dataRef.current = merged;
        saveNavigationData(merged);
        setData(merged);
      } else setData(syncedNavigation);
    }).catch(error => console.error("导航云同步初始化失败:", error));
    const theme = localStorage.getItem("theme-preference");
    setDark(theme ? theme === "dark" : true);
    const updatePreferences = (event: Event) => {
      const preferences = (event as CustomEvent<{ theme?: string; proxyMode?: boolean }>).detail;
      if (preferences.theme === "dark" || preferences.theme === "light") setDark(preferences.theme === "dark");
      if (typeof preferences.proxyMode === "boolean") setProxyMode(preferences.proxyMode);
    };
    window.addEventListener("nexusdesk-navigation-preferences-changed", updatePreferences);
    return () => {
      alive = false;
      window.removeEventListener("nexusdesk-navigation-preferences-changed", updatePreferences);
    };
  }, [loadAttempt]);

  useEffect(() => {
    const update = (event: Event) => {
      const next = (event as CustomEvent<NavigationData>).detail;
      dataRevision.current += 1;
      dataRef.current = next;
      setData(next);
    };
    window.addEventListener("nexusdesk-navigation-data-changed", update);
    return () => window.removeEventListener("nexusdesk-navigation-data-changed", update);
  }, []);

  const commit = (next: NavigationData) => { editedDuringLoad.current = true; dataRef.current = next; setData(next); saveNavigationData(next); };
  const engines = useMemo(() => (searchConfig.engines[searchType] || []).filter(engine => proxyMode || !engine.proxy), [proxyMode, searchConfig, searchType]);
  const indexedCategories = useMemo(() => data.categories.map(category => ({
    category,
    searchName: category.categoryName.toLocaleLowerCase(),
    sites: category.sites.map(site => ({
      site,
      searchText: `${site.title} ${site.desc || ""} ${site.url}`.toLocaleLowerCase(),
    })),
  })), [data]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim() || !engines.length) return;
    for (const engine of engines.filter(item => selectedEngines.includes(item.name))) {
      onNavigate(engine.url.replace("%s", encodeURIComponent(query.trim())));
    }
  };

  const toggleProxy = () => {
    const next = !proxyMode;
    setProxyMode(next);
    localStorage.setItem("proxy-mode-preference", String(next));
    window.dispatchEvent(new Event("nexusdesk-navigation-preferences-changed"));
  };

  const saveSite = async (site: NavigationSite) => {
    if (!editing) return;
    const latest = await loadNavigationData();
    commit(upsertNavigationSite(latest, editing.categoryId, site));
  };

  const deleteSite = (categoryId: string, siteId: string) => {
    if (!window.confirm("删除这个网站？")) return;
    commit({ categories: data.categories.map(category => category.categoryId === categoryId ? { ...category, sites: category.sites.filter(site => site.id !== siteId) } : category) });
  };

  const canEdit = (category: NavigationCategory) => category.categoryId === CUSTOM_CATEGORY_ID || category.categoryId.startsWith("custom-");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleCategories = indexedCategories.map(({ category, searchName, sites }) => ({
    category,
    sites: sites.filter(({ site, searchText }) => (proxyMode || !site.proxy) && (!normalizedQuery || searchName.includes(normalizedQuery) || searchText.includes(normalizedQuery))),
    matchesCategory: !normalizedQuery || searchName.includes(normalizedQuery),
  })).filter(item => item.matchesCategory || item.sites.length > 0);

  return <div data-theme={dark ? "dark" : "light"} className="nav-home h-full min-h-0 overflow-hidden">
    <div className="nav-layout flex h-full min-h-0">
      <aside className="nav-sidebar flex w-[210px] shrink-0 flex-col border-r">
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {visibleCategories.map(({ category }) => <button key={category.categoryId} type="button" onClick={() => { setActiveCategory(category.categoryId); document.getElementById(category.categoryId)?.scrollIntoView({ behavior: "smooth", block: "start" }); }} className={`nav-category block w-full truncate rounded px-3 py-2 text-left text-xs ${activeCategory === category.categoryId ? "active" : ""}`}>
            {category.categoryName}
          </button>)}
        </div>
        <div className="nav-footer flex items-center justify-between border-t px-3 py-3">
          <button type="button" title={proxyMode ? "关闭代理资源显示" : "显示代理资源"} aria-label="切换代理资源显示" onClick={toggleProxy} className={`nav-icon-button ${proxyMode ? "selected" : ""}`}><Globe size={16} /></button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="nav-main mx-auto max-w-[1500px] px-8 py-7">
          <section className="nav-search mb-8">
            <div className="mb-4 flex flex-wrap gap-1.5">{searchConfig.categories.map(category => <button key={category.value} onClick={() => { setSearchType(category.value); setSelectedEngines(searchConfig.engines[category.value]?.[0] ? [searchConfig.engines[category.value][0].name] : []); }} className={`nav-search-tab rounded px-3 py-1.5 text-xs ${searchType === category.value ? "active" : ""}`}>{category.label}</button>)}</div>
            <form onSubmit={submitSearch} className="nav-search-form flex h-12 items-center gap-3 rounded-md border px-4">
              <Search size={18} className="shrink-0 opacity-60" />
              <input aria-label="搜索" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索网络内容..." className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
              <button type="submit" aria-label="开始搜索" className="nav-icon-button"><ExternalLink size={17} /></button>
            </form>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">{engines.map(engine => <label key={engine.name} title={engine.desc} className="flex items-center gap-1.5 text-xs opacity-70"><input type="checkbox" checked={selectedEngines.includes(engine.name)} onChange={event => setSelectedEngines(current => event.target.checked ? [...current, engine.name] : current.filter(name => name !== engine.name))} />{engine.name}</label>)}</div>
          </section>
          {!ready ? <div className="py-12 text-sm opacity-60" role={loadError ? "alert" : "status"}>{loadError ? <><span>导航加载失败：{loadError}</span><button type="button" className="ml-3 underline" onClick={() => { setLoadError(""); setLoadAttempt(attempt => attempt + 1); }}>重试</button></> : "正在加载导航..."}</div> : visibleCategories.map(({ category, sites }) => <section id={category.categoryId} key={category.categoryId} className="nav-section mb-9 scroll-mt-6">
            <header className="mb-4 flex items-center justify-between border-b pb-2">
              <h2 className="text-base font-semibold">{category.categoryName}</h2>
              {canEdit(category) && <button type="button" className="nav-add-button flex items-center gap-1 rounded px-2 py-1 text-xs" onClick={() => setEditing({ categoryId: category.categoryId, site: newSite() })}><Plus size={14} />新增网站</button>}
            </header>
            <div className="nav-card-grid grid grid-cols-[repeat(auto-fill,minmax(195px,1fr))] gap-2.5">
              {sites.map(({ site }) => <article key={site.id || site.url} className="nav-card group relative min-h-[98px] rounded-md border p-3" onDoubleClick={() => onNavigate(site.url)}>
                {site.proxy && <span title="需代理" className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-amber-400" />}
                <button type="button" onClick={() => onNavigate(site.url)} className="w-full text-left" title={site.url}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    {typeof site.icon === "string" ? <img loading="lazy" decoding="async" src={site.icon} alt="" className="h-6 w-6 shrink-0 object-contain" onError={event => { event.currentTarget.style.visibility = "hidden"; }} /> : site.icon ? <span aria-hidden="true" className="h-6 w-6 shrink-0 bg-no-repeat" style={{ backgroundImage: `url(${spriteUrls[site.icon.sprite.split("/").pop() || ""] || ""})`, backgroundPosition: `-${site.icon.x * (24 / site.icon.width)}px -${site.icon.y * (24 / site.icon.height)}px`, backgroundSize: `${site.icon.spriteWidth * (24 / site.icon.width)}px ${site.icon.spriteHeight * (24 / site.icon.height)}px` }} /> : <Globe size={20} className="shrink-0 opacity-55" />}
                    <h3 className="truncate text-sm font-medium">{site.title}</h3>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs leading-5 opacity-60">{site.desc || site.url}</p>
                </button>
                {canEdit(category) && <div className="absolute bottom-2 right-2 hidden gap-1 group-hover:flex">
                  <button type="button" className="nav-card-action" title="编辑" onClick={() => setEditing({ categoryId: category.categoryId, site })}>编辑</button>
                  <button type="button" className="nav-card-action danger" title="删除" onClick={() => deleteSite(category.categoryId, site.id)}><Trash2 size={13} /></button>
                </div>}
              </article>)}
            </div>
          </section>)}
        </div>
      </main>
    </div>
    {editing && <NavigationSiteDialog key={editing.site.id} site={editing.site}
      mode={data.categories.find(category => category.categoryId === editing.categoryId)?.sites.some(site => site.id === editing.site.id) ? "edit" : "add"}
      onSave={saveSite} onClose={() => setEditing(null)} />}
  </div>;
}
