type Path = (string | number)[];

export function compileExtractionTemplate(template: string, marker = "{{content}}"): Path[] {
  const cleaned = template.trim().replace(/^data:\s*/, "");
  if (!cleaned) return [];
  const value: unknown = JSON.parse(cleaned);
  const paths: Path[] = [];
  function visit(node: unknown, path: Path) {
    if (node === marker) paths.push(path);
    else if (Array.isArray(node)) node.forEach((child, index) => visit(child, [...path, index]));
    else if (node && typeof node === "object") Object.entries(node).forEach(([key, child]) => visit(child, [...path, key]));
  }
  visit(value, []);
  if (!paths.length) throw new Error(`请在 JSON 模板中使用 "${marker}" 标记需要提取的节点。`);
  return paths;
}

export function extractStreamContent(body: string, template: string): { content: string; matches: number } {
  const values = extractValues(body, template);
  return { content: values.join(""), matches: values.length };
}

export interface ExtractedUrl {
  url: string;
  kind: "image" | "video" | "file";
}

export function extractResponseUrls(body: string): ExtractedUrl[] {
  const results: ExtractedUrl[] = [];
  const seen = new Set<string>();
  const scan = (text: string) => {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\\]+/gi)) {
      const candidate = match[0].replace(/[.,;:!，。；！？]+$/, "").replace(/\)+$/, suffix => {
        const opens = (match[0].match(/\(/g) || []).length;
        const closes = (match[0].match(/\)/g) || []).length;
        return suffix.slice(0, Math.max(0, suffix.length - Math.max(0, closes - opens)));
      });
      try {
        const url = new URL(candidate);
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        let path = url.pathname;
        try { path = decodeURIComponent(path); } catch { /* Keep the original path. */ }
        const extension = path.split(".").pop()?.toLowerCase() || "";
        const kind = /^(png|jpe?g|gif|webp|svg|bmp|ico|avif|apng|tiff?)$/.test(extension) ? "image"
          : /^(mp4|webm|ogv|ogg|mov|m4v|avi|mkv|mpeg|mpg|3gp|ts|m3u8)$/.test(extension) ? "video" : "file";
        results.push({ url: url.href, kind });
      } catch { /* Ignore invalid URLs. */ }
    }
  };
  // Decode JSON strings first, including escaped slashes and Unicode escapes.
  const decoded = body.replace(/"(?:[^"\\]|\\.)*"/g, value => {
    try { return `"${JSON.parse(value)}"`; } catch { return value; }
  });
  scan(decoded);
  return results;
}

function extractValues(body: string, template: string, marker = "{{content}}"): string[] {
  const paths = compileExtractionTemplate(template, marker);
  if (!paths.length) return [];
  const normalized = body.replace(/\r\n?/g, "\n");
  const isSse = /^data:/m.test(normalized);
  const records = isSse
    ? normalized.split(/\n\s*\n/).map(event => event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n"))
    : (() => { try { JSON.parse(normalized); return [normalized]; } catch { return normalized.split("\n"); } })();
  const values: string[] = [];
  for (const record of records) {
    if (!record.trim() || record.trim() === "[DONE]") continue;
    let value: unknown;
    try { value = JSON.parse(record); } catch { continue; }
    for (const path of paths) {
      let node = value;
      for (const key of path) {
        node = node !== null && typeof node === "object" ? (node as Record<string | number, unknown>)[key] : undefined;
      }
      if (typeof node === "string") { values.push(node); }
    }
  }
  return values;
}
