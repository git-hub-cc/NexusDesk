const supportedExtensions = new Set(["docx", "xlsx", "xls", "csv", "pdf", "pptx", "doc", "ppt"]);

export function documentExtension(path: string): string {
    return path.split(/[/\\]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
}

export function isConvertibleDocument(path: string): boolean {
    return supportedExtensions.has(documentExtension(path));
}

export interface DocumentConversionOptions {
    saveImage?: (bytes: Uint8Array, name: string) => Promise<string>;
    saveAsset?: (bytes: Uint8Array, name: string) => Promise<string>;
}

function markdownLabel(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/[\[\]<>]/g, value => `\\${value}`).replace(/[\r\n]/g, " ");
}

async function documentAsset(bytes: Uint8Array, name: string, options: DocumentConversionOptions): Promise<string> {
    const save = options.saveAsset ?? options.saveImage;
    if (save) return (await save(bytes, name)).replace(/\(/g, "%28").replace(/\)/g, "%29");
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" } as Record<string, string>)[documentExtension(name)] ?? "application/octet-stream";
    return `data:${mime};base64,${btoa(binary)}`;
}

/** Recover the file inside an OLE package, retaining unknown objects as OLE files. */
async function unpackOfficeAttachment(bytes: Uint8Array, fallback: string): Promise<{ bytes: Uint8Array; name: string }> {
    if (bytes[0] !== 0xd0 || bytes[1] !== 0xcf) return { bytes, name: fallback };
    const CFB = await import("cfb");
    const compound = CFB.read(bytes, { type: "array" });
    const native = CFB.find(compound, "/\u0001Ole10Native");
    if (native) {
        const data = new Uint8Array(native.content);
        const view = new DataView(data.buffer);
        // Ole10Native can contain a size-prefixed native bitmap instead of a
        // Package header. Its "BM" signature is not a pair of package flags.
        if (data.length >= 6 && data[4] === 0x42 && data[5] === 0x4d) {
            const length = view.getUint32(0, true);
            if (length > data.length - 4) throw new Error("附件内容不完整。");
            return { bytes: data.slice(4, 4 + length), name: fallback.replace(/\.[^.]+$/, ".bmp") };
        }
        // Only Package objects have the filename/path fields below. Preserve
        // other native OLE formats in their original container.
        if (data.length < 6 || view.getUint16(4, true) !== 2) {
            return { bytes, name: fallback.replace(/\.[^.]+$/, ".ole") };
        }
        let offset = 6; // total size and flags
        const readString = () => {
            const end = data.indexOf(0, offset);
            if (end < 0) throw new Error("附件文件名数据不完整。");
            const value = data.subarray(offset, end);
            offset = end + 1;
            try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
            catch { return new TextDecoder("gb18030").decode(value); }
        };
        const name = readString().split(/[/\\]/).pop() || fallback;
        readString(); // original path
        offset += 4; // reserved flags
        if (offset + 4 > data.length) throw new Error("附件数据不完整。");
        const pathLength = view.getUint32(offset, true);
        offset += 4 + pathLength;
        if (offset + 4 > data.length) throw new Error("附件路径数据不完整。");
        const length = view.getUint32(offset, true);
        offset += 4;
        if (length > data.length - offset) throw new Error("附件内容不完整。");
        return { bytes: data.slice(offset, offset + length), name };
    }
    const packageEntry = CFB.find(compound, "/Package");
    if (packageEntry) {
        const payload = new Uint8Array(packageEntry.content);
        const { default: JSZip } = await import("jszip");
        if (payload[0] === 0x50 && payload[1] === 0x4b) {
            const zip = await JSZip.loadAsync(payload);
            const extension = zip.file("xl/workbook.xml") ? "xlsx" : zip.file("word/document.xml") ? "docx" : zip.file("ppt/presentation.xml") ? "pptx" : "zip";
            return { bytes: payload, name: fallback.replace(/\.[^.]+$/, `.${extension}`) };
        }
        return { bytes: payload, name: fallback };
    }
    const extension = CFB.find(compound, "/Workbook") || CFB.find(compound, "/Book") ? "xls"
        : CFB.find(compound, "/WordDocument") ? "doc" : "ole";
    return { bytes, name: fallback.replace(/\.[^.]+$/, `.${extension}`) };
}

/** PPT stores compressed OLE objects in ExOleObjStg records; LibreOffice can discard them. */
async function legacyPptAttachments(arrayBuffer: ArrayBuffer, options: DocumentConversionOptions): Promise<string> {
    const input = new Uint8Array(arrayBuffer);
    if (input[0] !== 0xd0 || input[1] !== 0xcf) return "";
    const CFB = await import("cfb");
    const compound = CFB.read(input, { type: "array" });
    const entry = CFB.find(compound, "/PowerPoint Document");
    if (!entry) return "";
    const bytes = new Uint8Array(entry.content);
    const view = new DataView(bytes.buffer);
    const objects: Uint8Array[] = [];
    const scan = (start: number, end: number, depth = 0) => {
        if (depth > 64) throw new Error("PPT 对象嵌套过深。");
        for (let offset = start; offset + 8 <= end;) {
            const version = view.getUint16(offset, true);
            const type = view.getUint16(offset + 2, true);
            const length = view.getUint32(offset + 4, true);
            const next = offset + 8 + length;
            if (next > end) throw new Error("PPT 对象记录不完整。");
            if (type === 4113) objects.push(bytes.slice(offset, next));
            else if ((version & 15) === 15) scan(offset + 8, next, depth + 1);
            offset = next;
        }
    };
    scan(0, bytes.length);
    const links: string[] = [];
    const seen = new Set<string>();
    for (const record of objects) {
        const header = new DataView(record.buffer);
        const compressed = (header.getUint16(0, true) >> 4) === 1;
        let payload = record.slice(8);
        if (compressed) {
            const stream = new Blob([record.slice(12)]).stream().pipeThrough(new DecompressionStream("deflate"));
            payload = new Uint8Array(await new Response(stream).arrayBuffer());
            if (payload.length !== header.getUint32(8, true)) throw new Error("PPT 附件解压后长度不匹配。");
        }
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", payload)), byte => byte.toString(16).padStart(2, "0")).join("");
        if (seen.has(digest)) continue;
        seen.add(digest);
        const attachment = await unpackOfficeAttachment(payload, `attachment-${links.length + 1}.bin`);
        const url = await documentAsset(attachment.bytes, attachment.name, options);
        links.push(`- [${markdownLabel(attachment.name)}](${url})`);
    }
    return links.length ? `\n\n## 附件\n\n${links.join("\n")}` : "";
}

export async function convertDocxToMd(arrayBuffer: ArrayBuffer, options: DocumentConversionOptions = {}): Promise<string> {
    const [{ default: mammoth }, { default: TurndownService }, { gfm }] = await Promise.all([
        import("mammoth"), import("turndown"), import("turndown-plugin-gfm"),
    ]);
    let imageIndex = 0;
    let imageFailure: unknown;
    const result = await mammoth.convertToHtml({ arrayBuffer }, options.saveImage ? {
        convertImage: mammoth.images.imgElement(async image => {
            const index = ++imageIndex;
            const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/svg+xml": "svg", "image/webp": "webp", "image/bmp": "bmp", "image/tiff": "tiff", "image/x-emf": "emf", "image/x-wmf": "wmf" };
            try {
                const bytes = await image.readAsArrayBuffer();
                return { src: await options.saveImage!(new Uint8Array(bytes), `image-${index}.${extensions[image.contentType] ?? "bin"}`) };
            } catch (error) {
                // Mammoth normally logs image errors and continues with missing pictures.
                imageFailure = error;
                throw error;
            }
        }),
    } : {});
    if (imageFailure) throw imageFailure;
    const bookmark = (node: HTMLElement) => {
        const id = node.getAttribute("id") || node.getAttribute("name");
        const escaped = id?.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return escaped ? `<a id="${escaped}"></a>` : "";
    };
    const service = new TurndownService({
        headingStyle: "atx", codeBlockStyle: "fenced",
        blankReplacement: (_content, node) => node.nodeName === "A" ? bookmark(node as HTMLElement) : (node as HTMLElement & { isBlock?: boolean }).isBlock ? "\n\n" : "",
    });
    service.use(gfm);
    service.addRule("wordBookmarks", {
        filter: node => node.nodeName === "A" && !node.getAttribute("href"),
        replacement: (content, node) => bookmark(node as HTMLElement) + content,
    });
    // Word tables commonly have only td cells. Convert every table rather than
    // relying on GFM's heading-row detection, which otherwise keeps raw HTML.
    service.addRule("wordTables", {
        filter: "table",
        replacement: (_content, node) => {
            const table = node as HTMLTableElement;
            const rows: string[][] = [];
            Array.from(table.rows).forEach((row, rowIndex) => {
                const output = rows[rowIndex] ??= [];
                let column = 0;
                for (const cell of Array.from(row.cells)) {
                    while (output[column] !== undefined) column++;
                    const value = service.turndown(cell.innerHTML).trim().replace(/\|/g, "&#124;").replace(/\r\n?|\n/g, "<br>");
                    const height = cell.rowSpan === 0 ? table.rows.length - rowIndex : cell.rowSpan;
                    for (let down = 0; down < Math.min(height, table.rows.length - rowIndex); down++) {
                        const target = rows[rowIndex + down] ??= [];
                        for (let across = 0; across < cell.colSpan; across++) {
                            target[column + across] = down === 0 && across === 0 ? value : "";
                        }
                    }
                    column += cell.colSpan;
                }
            });
            const width = Math.max(0, ...rows.map(row => row.length));
            if (!width) return "";
            const lines = rows.map(row => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`);
            lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
            return `\n\n${lines.join("\n")}\n\n`;
        },
    });
    return service.turndown(result.value);
}

export function markdownTable(rows: unknown[][]): string {
    if (!rows.some(row => row.some(value => value != null && String(value).trim() !== ""))) return "";
    const width = Math.max(0, ...rows.map(row => row.length));
    if (!width) return "";
    const cell = (value: unknown) => String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\\/g, "&#92;").replace(/\|/g, "&#124;").replace(/\r\n?|\n/g, "<br>");
    const lines = rows.map(row => `| ${Array.from({ length: width }, (_, index) => cell(row[index])).join(" | ")} |`);
    lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
    return lines.join("\n");
}

export async function convertExcelToMd(arrayBuffer: ArrayBuffer, csv = false): Promise<string> {
    const { read, utils } = await import("xlsx");
    // Decode CSV explicitly so UTF-8 Chinese text is not interpreted as a legacy code page.
    const workbook = csv
        ? read(new TextDecoder().decode(arrayBuffer), { type: "string" })
        : read(arrayBuffer, { type: "array" });
    return workbook.SheetNames.flatMap(name => {
        const rows = utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, defval: "", raw: false });
        const table = markdownTable(rows);
        return table ? [`## ${name.replace(/[\r\n]/g, " ")}\n\n${table}`] : [];
    }).join("\n\n");
}

interface PdfTextItem {
    str: string;
    transform: number[];
    width: number;
    height: number;
    fontName: string;
    dir?: string;
}

interface PdfTextContent {
    items: (PdfTextItem | { type: string })[];
    styles: Record<string, { fontFamily: string }>;
}

interface PdfLine {
    items: PdfTextItem[];
    y: number;
    height: number;
}

const pdfCodeLanguages: Record<string, string> = {
    python: "python", py: "python", javascript: "javascript", js: "javascript",
    typescript: "typescript", ts: "typescript", json: "json", bash: "bash",
    shell: "sh", sql: "sql", java: "java", "c++": "cpp", "c#": "csharp",
    go: "go", rust: "rust", html: "html", css: "css", yaml: "yaml",
};

function median(values: number[]): number {
    const sorted = values.filter(value => value > 0 && Number.isFinite(value)).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1;
}

function pdfLineText(line: PdfLine, characterWidth?: number, left = 0): string {
    // Synthetic space items can overlap syntax-highlighted text drawn later.
    // Measure gaps between visible fragments instead of trusting those items.
    const items = line.items.filter(item => item.str.trim());
    let text = "";
    let end = left;
    for (const item of items) {
        const value = item.str.replace(/[\r\n]/g, "");
        const gap = item.transform[4] - end;
        const unit = characterWidth ?? Math.max(1, item.height * 0.25);
        const spaces = characterWidth ? Math.max(0, Math.round(gap / unit)) : gap > unit * 0.5 ? 1 : 0;
        if (text || characterWidth) text += " ".repeat(Math.min(spaces, 500));
        text += value;
        end = item.transform[4] + item.width;
    }
    return text.trimEnd();
}

/** Reconstruct visual lines before detecting code: PDF drawing order is not reading order. */
export function pdfTextToMarkdown(content: PdfTextContent, viewportTransform = [1, 0, 0, -1, 0, 0]): string {
    const [a, b, c, d, e, f] = viewportTransform;
    const items = content.items.filter((item): item is PdfTextItem => "str" in item && !!item.str.trim())
        .map(item => {
            const [ta, tb, , , x, y] = item.transform;
            const scale = Math.hypot(a * ta + c * tb, b * ta + d * tb) / (Math.hypot(ta, tb) || 1);
            return { ...item, width: item.width * scale, height: item.height * scale,
                transform: [1, 0, 0, 1, a * x + c * y + e, b * x + d * y + f] };
        }).sort((first, second) => first.transform[5] - second.transform[5] || first.transform[4] - second.transform[4]);
    const lines: PdfLine[] = [];
    for (const item of items) {
        const previous = lines[lines.length - 1];
        if (previous && Math.abs(previous.y - item.transform[5]) <= Math.max(1, Math.min(previous.height, item.height) * 0.2)) {
            previous.items.push(item);
            previous.height = Math.max(previous.height, item.height);
        } else {
            lines.push({ items: [item], y: item.transform[5], height: item.height });
        }
    }
    lines.forEach(line => line.items.sort((first, second) => first.transform[4] - second.transform[4]));
    const plain = lines.map(line => pdfLineText(line));
    const isMono = (line: PdfLine) => line.items.every(item => /mono|courier|consolas|menlo|code/i.test(content.styles[item.fontName]?.fontFamily ?? item.fontName));
    const isCode = (text: string) => /^(?:(?:async\s+)?def\s+\w+\s*\(|class\s+\w+.*:|from\s+[\w.]+\s+import\s|import\s+[\w.]+|(?:const|let|var)\s+\w+\s*=|(?:async\s+)?function\s+\w+\s*\(|@\w+|\w[\w.]*\s*=\s*\S)/.test(text.replace(/^\d+\s+/, ""));
    // A code sample may continue on the next page without a language label.
    const numberedCodeLines = new Set<number>();
    for (let start = 0; start < lines.length;) {
        const first = lines[start].items[0];
        if (!/^\d+$/.test(first.str.trim())) { start++; continue; }
        let end = start + 1;
        while (end < lines.length && /^\d+$/.test(lines[end].items[0].str.trim()) &&
            Math.abs(lines[end].items[0].transform[4] - first.transform[4]) < 2 &&
            Math.abs(lines[end].height - lines[start].height) < lines[start].height * 0.2 &&
            lines[end].y - lines[end - 1].y < lines[start].height * 3) end++;
        if (end - start >= 3 && plain.slice(start, end).some(text => isCode(text))) {
            for (let offset = start; offset < end; offset++) numberedCodeLines.add(offset);
        }
        start = end;
    }
    const output: string[] = [];
    for (let index = 0; index < lines.length;) {
        const language = pdfCodeLanguages[plain[index].trim().toLowerCase()];
        const start = language ? index + 1 : index;
        const first = lines[start];
        const detected = first && (language || numberedCodeLines.has(start) || isCode(plain[start]));
        if (!detected) {
            if (index && output[output.length - 1] !== "" && lines[index].y - lines[index - 1].y > Math.max(lines[index].height, lines[index - 1].height) * 1.5) output.push("");
            output.push(plain[index++]);
            continue;
        }
        let end = start + 1;
        while (end < lines.length) {
            const line = lines[end];
            if (pdfCodeLanguages[plain[end].trim().toLowerCase()] ||
                Math.abs(line.height - first.height) > first.height * 0.2 ||
                line.y - lines[end - 1].y > first.height * (numberedCodeLines.has(end) || isCode(plain[end]) || /^\w[\w.]*\(/.test(plain[end]) ? 5 : 3) ||
                (!language && !numberedCodeLines.has(end) && !isMono(line) && !isCode(plain[end]) &&
                    !/^(?:return\b|await\b|if\b.*:|else:|for\b.*:|while\b.*:|["'#@}\])]|\w[\w.]*\()/.test(plain[end]))) break;
            end++;
        }
        const block = lines.slice(start, end).map(line => ({ ...line, items: [...line.items] }));
        // Remove a repeated line-number gutter only inside an identified code block.
        const numbered = block.filter(line => line.items.length > 1 && /^\d+$/.test(line.items[0].str.trim()));
        const gutter = numbered.length >= 2 && numbered.every(line => Math.abs(line.items[0].transform[4] - numbered[0].items[0].transform[4]) < 2)
            ? numbered[0].items[0].transform[4] : undefined;
        if (gutter !== undefined) {
            for (const line of block) {
                if (/^\d+$/.test(line.items[0].str.trim()) && Math.abs(line.items[0].transform[4] - gutter) < 2) line.items.shift();
            }
        }
        const fragments = block.flatMap(line => line.items);
        const unit = median(fragments.map(item => item.width / item.str.replace(/[\r\n]/g, "").length));
        const left = Math.min(...fragments.map(item => item.transform[4]));
        const spacing = median(block.slice(1).map((line, offset) => line.y - block[offset].y));
        const code: string[] = [];
        block.forEach((line, offset) => {
            if (offset) {
                const blanks = Math.min(8, Math.max(0, Math.round((line.y - block[offset - 1].y) / spacing) - 1));
                code.push(...Array<string>(blanks).fill(""));
            }
            code.push(pdfLineText(line, unit, left));
        });
        const body = code.join("\n");
        const fence = "`".repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), match => match[0].length + 1)));
        const inferredLanguage = /^(?:from\s+\S+\s+import|(?:async\s+)?def\s+|@\w)/m.test(body) ? "python" : "";
        output.push("", `${fence}${language ?? inferredLanguage}\n${body}\n${fence}`, "");
        index = end;
    }
    return output.join("\n").trim();
}

export async function convertPdfToMd(arrayBuffer: ArrayBuffer): Promise<string> {
    const [pdfjs, { default: workerSrc }] = await Promise.all([
        import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    const task = pdfjs.getDocument({ data: arrayBuffer });
    try {
        const pdf = await task.promise;
        const pages: string[] = [];
        let hasText = false;
        for (let index = 1; index <= pdf.numPages; index++) {
            const page = await pdf.getPage(index);
            const content = await page.getTextContent();
            const text = pdfTextToMarkdown(content, page.getViewport({ scale: 1 }).transform);
            hasText ||= !!text;
            pages.push(`## 第 ${index} 页\n\n${text || "（本页未检测到文本层，可能需要 OCR 识别。）"}`);
            page.cleanup();
        }
        if (!hasText) throw new Error("未检测到 PDF 文本层，可能是扫描件。请先使用 OCR 识别，或转换为带文本层的 PDF 后重试。");
        return pages.join("\n\n---\n\n");
    } finally {
        await task.destroy();
    }
}

export async function convertPptxToMd(arrayBuffer: ArrayBuffer, options: DocumentConversionOptions = {}): Promise<string> {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(arrayBuffer);
    const xml = async (path: string) => {
        const entry = zip.file(path);
        if (!entry) throw new Error("PPTX 文档结构不完整，无法提取幻灯片。");
        const doc = new DOMParser().parseFromString(await entry.async("string"), "application/xml");
        if (doc.getElementsByTagName("parsererror").length) throw new Error("PPTX XML 解析失败。");
        return doc;
    };
    const presentation = await xml("ppt/presentation.xml");
    const relationships = await xml("ppt/_rels/presentation.xml.rels");
    const targets = new Map(Array.from(relationships.getElementsByTagNameNS("*", "Relationship"))
        .filter(node => node.getAttribute("TargetMode") !== "External")
        .map(node => [node.getAttribute("Id"), node.getAttribute("Target") ?? ""]));
    const pages: string[] = [];
    const saved = new Map<string, { name: string; url: string }>();
    let hasContent = false;
    for (const slide of Array.from(presentation.getElementsByTagNameNS("*", "sldId"))) {
        const id = slide.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
        const target = targets.get(id);
        if (!target) throw new Error("PPTX 幻灯片引用缺失。");
        const path = new URL(target, "https://pptx.local/ppt/presentation.xml").pathname.slice(1);
        const doc = await xml(path);
        const paragraphs = Array.from(doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "p"))
            .map(p => Array.from(p.getElementsByTagNameNS("*", "t")).map(t => t.textContent ?? "").join("").trim())
            .filter(Boolean);
        const assets: string[] = [];
        const relPath = path.replace(/([^/]+)$/, "_rels/$1.rels");
        if (zip.file(relPath)) {
            const rels = await xml(relPath);
            const used = new Set<string>();
            for (const rel of Array.from(rels.getElementsByTagNameNS("*", "Relationship"))) {
                const type = rel.getAttribute("Type")?.split("/").pop();
                if (!["image", "oleObject", "package", "audio", "video", "media"].includes(type ?? "")) continue;
                const target = rel.getAttribute("Target");
                if (!target) throw new Error("PPTX 附件引用缺失。");
                if (rel.getAttribute("TargetMode") === "External") {
                    assets.push(`- [外部${type === "image" ? "图片" : "附件"}](${target.replace(/\(/g, "%28").replace(/\)/g, "%29")})`);
                    continue;
                }
                const assetPath = decodeURIComponent(new URL(target, `https://pptx.local/${path}`).pathname.slice(1));
                if (used.has(assetPath)) continue;
                used.add(assetPath);
                let asset = saved.get(assetPath);
                if (!asset) {
                    const entry = zip.file(assetPath);
                    if (!entry) throw new Error(`PPTX 附件缺失：${assetPath}`);
                    const bytes = await entry.async("uint8array");
                    const fileName = assetPath.split("/").pop()!;
                    const attachment = type === "oleObject" || type === "package"
                        ? await unpackOfficeAttachment(bytes, fileName) : { bytes, name: fileName };
                    asset = { name: attachment.name, url: await documentAsset(attachment.bytes, attachment.name, options) };
                    saved.set(assetPath, asset);
                }
                const label = markdownLabel(asset.name);
                assets.push(type === "image" && /\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(asset.name)
                    ? `![${label}](${asset.url})` : `- [${label}](${asset.url})`);
            }
        }
        hasContent ||= paragraphs.length > 0 || assets.length > 0;
        pages.push(`## 第 ${pages.length + 1} 页\n\n${[paragraphs.map(text => `- ${text}`).join("\n"), assets.join("\n\n")].filter(Boolean).join("\n\n")}`);
    }
    if (!hasContent) throw new Error("幻灯片中未检测到可提取的文本或附件，请导出为 PDF 或使用 OCR 识别。");
    return pages.join("\n\n---\n\n");
}

export async function convertDocumentToMarkdown(arrayBuffer: ArrayBuffer, extension: string, options: DocumentConversionOptions = {}): Promise<string> {
    let content: string;
    switch (extension.toLowerCase()) {
        case "docx": content = await convertDocxToMd(arrayBuffer, options); break;
        case "xlsx": case "xls": case "csv": content = await convertExcelToMd(arrayBuffer, extension.toLowerCase() === "csv"); break;
        case "pdf": content = await convertPdfToMd(arrayBuffer); break;
        case "pptx": content = await convertPptxToMd(arrayBuffer, options); break;
        case "doc": case "ppt": {
            const { invoke } = await import("@tauri-apps/api/core");
            const bytes = await invoke<number[]>("convert_legacy_office", {
                bytes: Array.from(new Uint8Array(arrayBuffer)), extension: extension.toLowerCase(),
            });
            const converted = await convertDocumentToMarkdown(new Uint8Array(bytes).buffer, extension.toLowerCase() === "doc" ? "docx" : "pptx", options);
            const attachments = extension.toLowerCase() === "ppt" ? await legacyPptAttachments(arrayBuffer, options) : "";
            return (converted.trimEnd() + attachments).trim() + "\n";
        }
        default: throw new Error("不支持此文档格式。");
    }
    if (!content.trim()) throw new Error("未提取到可用内容；扫描件或图片文档请先使用 OCR 识别。");
    return content.trim() + "\n";
}
