import { Globe } from "lucide-react";
import { useState } from "react";
import sprite01 from "@/assets/navigation/img/sprite-01.webp";
import sprite02 from "@/assets/navigation/img/sprite-02.webp";
import sprite03 from "@/assets/navigation/img/sprite-03.webp";
import sprite04 from "@/assets/navigation/img/sprite-04.webp";
import sprite05 from "@/assets/navigation/img/sprite-05.webp";
import type { NavigationSite } from "./navigationData";

const spriteUrls: Record<string, string> = {
  "sprite-01.webp": sprite01,
  "sprite-02.webp": sprite02,
  "sprite-03.webp": sprite03,
  "sprite-04.webp": sprite04,
  "sprite-05.webp": sprite05,
};

export function NavigationSiteIcon({ icon }: { icon: NavigationSite["icon"] }) {
  const [failedIcon, setFailedIcon] = useState<string>();
  if (typeof icon === "string" && icon && icon !== failedIcon) {
    return <img key={icon} loading="lazy" decoding="async" src={icon} alt="" referrerPolicy="no-referrer"
      className="h-6 w-6 shrink-0 object-contain" onError={() => setFailedIcon(icon)} />;
  }
  if (icon && typeof icon === "object") {
    const sprite = spriteUrls[icon.sprite.split("/").pop() || ""];
    if (sprite) return <span aria-hidden="true" className="h-6 w-6 shrink-0 bg-no-repeat" style={{
      backgroundImage: `url(${sprite})`,
      backgroundPosition: `-${icon.x * (24 / icon.width)}px -${icon.y * (24 / icon.height)}px`,
      backgroundSize: `${icon.spriteWidth * (24 / icon.width)}px ${icon.spriteHeight * (24 / icon.height)}px`,
    }} />;
  }
  return <Globe size={24} aria-hidden="true" className="shrink-0 opacity-55" />;
}
