import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/lib/documentOcr.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/export /g, '')
    .replace('import("pdfjs-dist")', 'Promise.resolve(mockPdfjs)')
    .replace('import("pdfjs-dist/build/pdf.worker.min.mjs?url")', 'Promise.resolve({ default: "worker.mjs" })'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function setup(texts, afterInvoke = () => {}) {
    let calls = 0;
    let destroyed = false;
    let cleanups = 0;
    const progress = [];
    const document = {
        createElement: () => ({
            width: 0, height: 0,
            getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(1920 * 160 * 4).fill(255) }) }),
            toBlob: callback => callback(new Blob(['png'])),
        }),
    };
    const pdf = {
        numPages: texts.length,
        getPage: async () => ({
            getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
            getTextContent: () => { throw new Error('OCR 不应读取文本层'); },
            render: () => ({ promise: Promise.resolve() }),
            cleanup: () => { cleanups++; },
        }),
    };
    const mockPdfjs = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(pdf), destroy: async () => { destroyed = true; } }) };
    const invoke = async command => {
        assert.equal(command, 'document_ocr');
        const result = texts[Math.floor(calls++ / 2)];
        afterInvoke();
        return result;
    };
    const api = new Function('invoke', 'documentExtension', 'document', 'mockPdfjs', compiled + '\nreturn { convertDocumentWithOcr, isOcrDocument };')(
        invoke, path => path.split('.').pop().toLowerCase(), document, mockPdfjs,
    );
    const controller = new AbortController();
    return {
        ...api, controller, progress,
        run: () => api.convertDocumentWithOcr(new Uint8Array(), 'pdf', {
            signal: controller.signal, onProgress: (page, total) => progress.push([page, total]),
        }),
        stats: () => ({ calls, destroyed, cleanups }),
    };
}

test('PDF 始终走 OCR，保留页码和空白页并释放资源', async () => {
    const job = setup(['识别文字', '']);
    const result = await job.run();
    assert.match(result, /## 第 1 页\n\n识别文字/);
    assert.match(result, /## 第 2 页\n\n（本页未识别到文字。）/);
    assert.deepEqual(job.progress, [[1, 2], [2, 2]]);
    assert.deepEqual(job.stats(), { calls: 4, destroyed: true, cleanups: 2 });
});

test('取消后不再识别后续分块或页面，并释放 PDF', async () => {
    const job = setup(['文字', '后续页面'], () => job.controller.abort());
    await assert.rejects(job.run(), /CANCELLED/);
    assert.deepEqual(job.stats(), { calls: 1, destroyed: true, cleanups: 1 });
});

test('全文为空时报错，不生成空白 Markdown', async () => {
    const job = setup(['']);
    await assert.rejects(job.run(), /未识别到可用文字/);
    assert.equal(job.stats().destroyed, true);
});
