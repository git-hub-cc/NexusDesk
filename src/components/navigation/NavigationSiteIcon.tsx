import { invoke, isTauri } from "@tauri-apps/api/core";
import { Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import sprite01 from "@/assets/navigation/images/sprite-01.webp";
import sprite02 from "@/assets/navigation/images/sprite-02.webp";
import sprite03 from "@/assets/navigation/images/sprite-03.webp";
import sprite04 from "@/assets/navigation/images/sprite-04.webp";
import sprite05 from "@/assets/navigation/images/sprite-05.webp";
import type { NavigationSite } from "./navigationData";

const spriteUrls: Record<string, string> = {
  "sprite-01.webp": sprite01,
  "sprite-02.webp": sprite02,
  "sprite-03.webp": sprite03,
  "sprite-04.webp": sprite04,
  "sprite-05.webp": sprite05,
};

function DefaultIcon() {
  return <Globe size={24} aria-hidden="true" className="shrink-0 opacity-55" />;
}

function ImageIcon({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <DefaultIcon />;
  return <img loading="lazy" decoding="async" src={src} alt=""
    className="h-6 w-6 shrink-0 object-contain" onError={() => setFailed(true)} />;
}

const iconRequests = new Map<string, Promise<string | null>>();

function fetchIcon(url: string) {
  const cached = iconRequests.get(url);
  if (cached) return cached;
  const request = invoke<string | null>("navigation_fetch_icon", { url }).catch(() => null);
  if (iconRequests.size >= 128) {
    const oldest = iconRequests.keys().next().value;
    if (oldest !== undefined) iconRequests.delete(oldest);
  }
  iconRequests.set(url, request);
  return request;
}

function RemoteIcon({ url }: { url: string }) {
  const placeholder = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!placeholder.current) return;
    let active = true;
    const observer = new IntersectionObserver(entries => {
      if (!active || !entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void fetchIcon(url).then(value => { if (active) setSrc(value); });
    });
    observer.observe(placeholder.current);
    return () => { active = false; observer.disconnect(); };
  }, [url]);

  return src ? <ImageIcon src={src} /> : <span ref={placeholder} className="h-6 w-6 shrink-0"><DefaultIcon /></span>;
}

export function NavigationSiteIcon({ icon }: { icon: NavigationSite["icon"] }) {
  if (typeof icon === "string") {
    const value = icon.trim();
    if (/^data:image\//i.test(value)) return <ImageIcon key={value} src={value} />;
    if (/^https?:\/\//i.test(value) && isTauri()) return <RemoteIcon key={value} url={value} />;
  }
  if (icon && typeof icon === "object") {
    const sprite = spriteUrls[icon.sprite.split("/").pop() || ""];
    if (sprite) return <span aria-hidden="true" className="h-6 w-6 shrink-0 bg-no-repeat" style={{
      backgroundImage: `url(${sprite})`,
      backgroundPosition: `-${icon.x * (24 / icon.width)}px -${icon.y * (24 / icon.height)}px`,
      backgroundSize: `${icon.spriteWidth * (24 / icon.width)}px ${icon.spriteHeight * (24 / icon.height)}px`,
    }} />;
  }
  return <DefaultIcon />;
}
