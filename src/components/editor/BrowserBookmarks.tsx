import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { CUSTOM_CATEGORY_ID, findNavigationBookmark, loadNavigationData, saveNavigationData, upsertNavigationSite, type NavigationData, type NavigationSite } from "@/components/navigation/navigationData";
import { NavigationSiteDialog } from "@/components/navigation/NavigationSiteDialog";
import { initializeNavigationSync } from "@/components/navigation/navigationSync";

export function BrowserBookmarks({ currentUrl, pageTitle }: { currentUrl: string; pageTitle: string }) {
  const [data, setData] = useState<NavigationData>({ categories: [] });
  const [editing, setEditing] = useState<{ site: NavigationSite; mode: "add" | "edit" } | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const opening = useRef(false);
  const bookmark = findNavigationBookmark(data, currentUrl);

  useEffect(() => {
    let alive = true;
    let changed = false;
    const update = (event: Event) => {
      changed = true;
      setData((event as CustomEvent<NavigationData>).detail);
    };
    window.addEventListener("nexusdesk-navigation-data-changed", update);
    void loadNavigationData().then(next => { if (alive && !changed) setData(next); }).catch(reason => { if (alive) setError(String(reason)); });
    void initializeNavigationSync().catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; window.removeEventListener("nexusdesk-navigation-data-changed", update); };
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 3000);
    return () => window.clearTimeout(timer);
  }, [message]);

  const openBookmark = async () => {
    if (opening.current) return;
    opening.current = true;
    setMessage("");
    setError("");
    try {
      const url = new URL(currentUrl);
      const title = pageTitle.trim() || url.hostname;
      const latest = await loadNavigationData();
      const existing = findNavigationBookmark(latest, url.href);
      setEditing(existing ? { site: existing, mode: "edit" } : {
        site: { id: crypto.randomUUID(), title, url: url.href, desc: "", proxy: false }, mode: "add",
      });
    } catch (reason) { opening.current = false; setError(String(reason)); }
  };

  return <>
    <button type="button" title={bookmark ? "编辑书签" : "添加当前网页到我的导航"}
      aria-label={bookmark ? "编辑书签" : "添加当前网页到我的导航"}
      onClick={() => { void openBookmark(); }} className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white">
      <Star size={15} className={bookmark ? "fill-amber-400 text-amber-400" : ""} />
    </button>
    {(message || error) && <span role={error ? "alert" : "status"} className={`max-w-48 truncate text-xs ${error ? "text-red-400" : "text-green-400"}`} title={error || message}>{error || message}</span>}
    {editing && <NavigationSiteDialog key={editing.site.id} site={editing.site} mode={editing.mode} focusDescription
      onClose={() => { opening.current = false; setEditing(null); }} onSave={async site => {
        const latest = await loadNavigationData();
        const existing = findNavigationBookmark(latest, site.url);
        const nextSite = editing.mode === "add" && existing ? { ...site, id: existing.id } : site;
        saveNavigationData(upsertNavigationSite(latest, CUSTOM_CATEGORY_ID, nextSite));
        setMessage(editing.mode === "add" ? "已添加到我的导航" : "书签已更新");
      }} />}
  </>;
}
