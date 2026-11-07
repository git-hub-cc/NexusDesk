/* Markdown 预览 worker：解析、清理和基础代码高亮都在后台线程完成。 */

const escapeHtml = value => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");

const restoreSafeHtml = value => value.replace(/&lt;(\/?)((?:table|thead|tbody|tfoot|tr|th|td|p|div|span|a|br|hr|strong|em|del|details|summary|u|kbd|sub|sup))(.*?)&gt;/gi, (_, slash, tag, rawAttrs) => {
  const attrs = [];
  rawAttrs.replace(/\s+(id|name|class|title|href)=(?:&quot;([^&]*)&quot;|&#39;([^&]*)&#39;|([^\s>]+))/gi, (_match, name, doubleValue, singleValue, bareValue) => {
    const value = doubleValue || singleValue || bareValue || "";
    if ((name.toLowerCase() === "href" && !safeUrl(value)) || /[<>]/.test(value)) return;
    attrs.push(` ${name.toLowerCase()}="${escapeHtml(value)}"`);
  });
  return `<${slash}${tag.toLowerCase()}${attrs.join("")}>`;
});

const safeUrl = (value, image = false) => {
  const url = String(value || "").trim();
  if (image && /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon);base64,/i.test(url)) return url;
  if (/^(?:https?:|mailto:|#|tauri:|asset:|blob:)/i.test(url)) return url;
  return url && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : "";
};

const inline = value => {
  let text = escapeHtml(value);
  const tokens = [];
  const hold = html => `\u0000${tokens.push(html) - 1}\u0000`;
  text = text.replace(/!\[([^\]]*)\]\((\S+?)(?:\s+[\"']([^\"']*)[\"'])?\)/g, (_, alt, src, title) => {
    const url = safeUrl(src, true);
    if (!url) return "";
    const media = /\.(?:mp4|webm|ogg|mov)(?:[?#].*)?$/i.test(url)
      ? `<video controls preload="metadata" src="${escapeHtml(url)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(alt)}</video>`
      : `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ""}>`;
    return hold(media);
  });
  text = text.replace(/\[([^\]]+)\]\((\S+?)(?:\s+[\"']([^\"']*)[\"'])?\)/g, (_, label, href, title) => {
    const url = safeUrl(href);
    return url ? hold(`<a href="${escapeHtml(url)}"${/^(?:https?:|mailto:)/i.test(url) ? ' target="_blank" rel="noopener noreferrer"' : ""}${title ? ` title="${escapeHtml(title)}"` : ""}>${label}</a>`) : label;
  });
  text = text.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>").replace(/_([^_]+)_/g, "<em>$1</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return restoreSafeHtml(text.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]));
};

const highlight = (value, language) => {
  let code = escapeHtml(value);
  if (!language) return code;
  const parts = [];
  code = code.replace(/(\/\/.*|#.*|\/\*[\s\S]*?\*\/)/g, match => `\u0000${parts.push(`<span class="hljs-comment">${match}</span>`) - 1}\u0000`);
  code = code.replace(/(&quot;.*?&quot;|&#39;.*?&#39;|`.*?`)/g, match => `\u0000${parts.push(`<span class="hljs-string">${match}</span>`) - 1}\u0000`);
  code = code.replace(/\b(const|let|var|function|return|if|else|for|while|class|new|import|from|export|async|await|throw|try|catch|def|in|SELECT|FROM|WHERE)\b/g, '<span class="hljs-keyword">$1</span>');
  code = code.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="hljs-number">$1</span>');
  return code.replace(/\u0000(\d+)\u0000/g, (_, index) => parts[Number(index)]);
};

const render = markdown => {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let paragraph = [], list = null, quote = [], code = null, table = null;
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${inline(paragraph.join(" "))}</p>`); paragraph = []; } };
  const flushList = () => { if (list) { output.push(`<${list.type}>${list.items.join("")}</${list.type}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { output.push(`<blockquote>${quote.map(item => `<p>${inline(item)}</p>`).join("")}</blockquote>`); quote = []; } };
  const flushTable = () => { if (table) { const [head, ...rows] = table; output.push(`<table><thead><tr>${head.map(cell => `<th>${inline(cell.trim())}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell.trim())}</td>`).join("")}</tr>`).join("")}</tbody></table>`); table = null; } };
  const flushCode = () => { if (code) { output.push(`<pre><code class="${code.lang ? `language-${escapeHtml(code.lang)} ` : ""}hljs">${highlight(code.lines.join("\n"), code.lang)}</code></pre>`); code = null; } };
  for (const line of lines) {
    if (code) { if (/^```/.test(line.trim())) flushCode(); else code.lines.push(line); continue; }
    const fence = line.match(/^\s*```\s*([^\s]*)\s*$/); if (fence) { flushParagraph(); flushList(); flushQuote(); flushTable(); code = { lang: fence[1], lines: [] }; continue; }
    if (!line.trim()) { flushParagraph(); flushList(); flushQuote(); flushTable(); continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/); if (heading) { flushParagraph(); flushList(); flushQuote(); flushTable(); const level = heading[1].length; const id = `user-content-${heading[2].toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "")}`; output.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flushParagraph(); flushList(); flushQuote(); flushTable(); output.push("<hr>"); continue; }
    const quoteLine = line.match(/^\s*>\s?(.*)$/); if (quoteLine) { flushParagraph(); flushList(); flushTable(); quote.push(quoteLine[1]); continue; } if (quote.length) flushQuote();
    const item = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/); if (item) { flushParagraph(); flushQuote(); flushTable(); const type = /^\d/.test(item[1]) ? "ol" : "ul"; if (!list || list.type !== type) { flushList(); list = { type, items: [] }; } const task = item[2].match(/^\[([ xX])\]\s+(.*)$/); list.items.push(`<li>${task ? `<input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""}> ${inline(task[2])}` : inline(item[2])}</li>`); continue; } if (list) flushList();
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) continue;
    if (line.includes("|") && !table) { flushParagraph(); const cells = line.replace(/^\||\|$/g, "").split("|"); table = [cells]; continue; }
    if (table && line.includes("|")) { table.push(line.replace(/^\||\|$/g, "").split("|")); continue; } if (table) flushTable();
    paragraph.push(line.trim());
  }
  flushCode(); flushParagraph(); flushList(); flushQuote(); flushTable();
  return output.join("");
};

self.onmessage = event => {
  const message = event.data || {};
  if (message.type !== "render") return;
  try { self.postMessage({ type: "rendered", id: message.id, html: render(message.markdown) }); }
  catch (error) { self.postMessage({ type: "error", id: message.id, error: String(error) }); }
};
