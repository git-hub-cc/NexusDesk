import { invoke } from "@tauri-apps/api/core";
import { documentExtension } from "./documentConverter";

const extensions = new Set(["pdf", "png", "jpg", "jpeg", "webp", "bmp", "gif"]);

export function isOcrDocument(path: string): boolean {
    return extensions.has(documentExtension(path));
}

interface OcrOptions {
    signal: AbortSignal;
    onProgress: (page: number, total: number) => void;
}

function checkCancelled(signal: AbortSignal) {
    if (signal.aborted) throw new Error("CANCELLED");
}

function canvas(width: number, height: number): HTMLCanvasElement {
    if (width * height > 24_000_000) throw new Error("页面尺寸过大，请拆分后重试。");
    const result = document.createElement("canvas");
    result.width = width;
    result.height = height;
    return result;
}

async function recognize(page: HTMLCanvasElement, signal: AbortSignal): Promise<string> {
    const context = page.getContext("2d")!;
    const parts: string[] = [];
    const tile = canvas(page.width, 1200);
    try {
        for (let top = 0; top < page.height;) {
            checkCancelled(signal);
            let bottom = Math.min(top + 1200, page.height);
            if (bottom < page.height) {
                // 在分块底部寻找文字较少的行，尽量避免切断同一行文字。
                const start = bottom - 160;
                const pixels = context.getImageData(0, start, page.width, 160).data;
                let minimum = Infinity;
                for (let row = 159; row >= 0; row--) {
                    let ink = 0;
                    for (let x = 0; x < page.width; x++) {
                        const offset = (row * page.width + x) * 4;
                        if (Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 200) ink++;
                    }
                    if (ink < minimum) { minimum = ink; bottom = start + row + 1; }
                    if (!ink) break;
                }
            }
            tile.height = bottom - top;
            tile.getContext("2d")!.drawImage(page, 0, top, page.width, tile.height, 0, 0, tile.width, tile.height);
            const blob = await new Promise<Blob>((resolve, reject) => {
                tile.toBlob(value => value ? resolve(value) : reject(new Error("无法生成 OCR 图像。")), "image/png");
            });
            checkCancelled(signal);
            const text = await invoke<string>("document_ocr", { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) });
            checkCancelled(signal);
            if (text.trim()) parts.push(text.trim());
            top = bottom;
        }
        return parts.join("\n\n");
    } finally {
        tile.width = tile.height = 0;
    }
}

export async function convertDocumentWithOcr(bytes: Uint8Array, extension: string, options: OcrOptions): Promise<string> {
    const { signal, onProgress } = options;
    checkCancelled(signal);
    const pages: string[] = [];
    let hasText = false;
    const extract = async (image: HTMLCanvasElement, index: number, total: number) => {
        try {
            onProgress(index, total);
            const text = await recognize(image, signal);
            hasText ||= !!text;
            pages.push(`## 第 ${index} 页\n\n${text || "（本页未识别到文字。）"}`);
        } finally {
            image.width = image.height = 0;
        }
    };
    if (extension === "pdf") {
        const [pdfjs, { default: workerSrc }] = await Promise.all([
            import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        ]);
        checkCancelled(signal);
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
        const task = pdfjs.getDocument({ data: bytes });
        const cancel = () => { void task.destroy().catch(() => {}); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
            const pdf = await task.promise;
            for (let index = 1; index <= pdf.numPages; index++) {
                checkCancelled(signal);
                const page = await pdf.getPage(index);
                let image: HTMLCanvasElement | undefined;
                try {
                    const width = page.getViewport({ scale: 1 }).width;
                    const viewport = page.getViewport({ scale: Math.min(2.5, 1920 / width) });
                    image = canvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
                    await page.render({ canvas: image, viewport, background: "white" }).promise;
                    await extract(image, index, pdf.numPages);
                } finally {
                    if (image) image.width = image.height = 0;
                    page.cleanup();
                }
            }
        } catch (error) {
            checkCancelled(signal);
            throw error;
        } finally {
            signal.removeEventListener("abort", cancel);
            await task.destroy();
        }
    } else {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
        let image: HTMLCanvasElement | undefined;
        try {
            checkCancelled(signal);
            const scale = Math.min(1, 1920 / bitmap.width);
            image = canvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
            const context = image.getContext("2d")!;
            context.fillStyle = "white";
            context.fillRect(0, 0, image.width, image.height);
            context.drawImage(bitmap, 0, 0, image.width, image.height);
            await extract(image, 1, 1);
        } finally {
            bitmap.close();
            if (image) image.width = image.height = 0;
        }
    }
    checkCancelled(signal);
    if (!hasText) throw new Error("未识别到可用文字，请检查图片清晰度或文档内容。");
    return pages.join("\n\n---\n\n") + "\n";
}
