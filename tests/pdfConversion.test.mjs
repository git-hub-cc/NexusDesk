import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/lib/documentConverter.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.replace(/export /g, '')
    .replace('import("pdfjs-dist")', 'Promise.resolve(mockPdfjs)')
    .replace('import("pdfjs-dist/build/pdf.worker.min.mjs?url")', 'Promise.resolve({ default: "worker.mjs" })'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { pdfTextToMarkdown, convertPdfToMd } = new Function('mockPdfjs', compiled + '\nreturn { pdfTextToMarkdown, convertPdfToMd };')({
    GlobalWorkerOptions: {},
    getDocument: () => task,
});
let task;
const item = (str, x, y, extras = {}) => ({
    str, transform: [10, 0, 0, 10, x, y], width: str.replace(/\n/g, '').length * 6,
    height: 10, fontName: 'body', hasEOL: true, ...extras,
});
const content = items => ({ items, styles: { body: { fontFamily: 'sans-serif' } } });

test('PDF drawing order and hasEOL do not split syntax-highlighted code into unrelated lines', () => {
    // Like the reported PDF: gutter first, then identifiers, then colored strings.
    const page = content([
        item('Example', 36, 240), item('Python', 60, 210),
        item('1\n', 60, 190), item('2\n', 60, 170), item('3', 60, 150),
        item('agent', 86, 190), item('=', 122, 190), item('Agent(', 134, 190),
        item('name=', 110, 170), item(')', 86, 150),
        item(',', 194, 170), item('"Weather"', 140, 170),
        // This synthetic space overlaps the string and must not displace it.
        item(' ', 140, 170, { width: 54 }),
        item('After the example.', 36, 110), { type: 'beginMarkedContent' },
    ]);
    assert.equal(pdfTextToMarkdown(page), 'Example\n\n```python\nagent = Agent(\n    name="Weather",\n)\n```\n\nAfter the example.');
});

test('PDF code retains nested indentation, blank rows and internal string spacing', () => {
    const markdown = pdfTextToMarkdown(content([
        item('Python', 40, 220), item('def run():', 80, 200),
        item('if ready:', 104, 180), item('return "a  b"', 128, 160),
        item('run()', 80, 120),
    ]));
    assert.equal(markdown, '```python\ndef run():\n    if ready:\n        return "a  b"\n\nrun()\n```');
});

test('PDF code continuation includes initial punctuation and removes empty numbered rows', () => {
    const markdown = pdfTextToMarkdown(content([
        item('24', 60, 200), item(')', 86, 200), item('25', 60, 180),
        item('26', 60, 160), item('async def main():', 86, 160),
        item('27', 60, 140), item('return 1', 110, 140),
        item('Following prose.', 36, 100),
    ]));
    assert.match(markdown, /```python\n\)\n\nasync def main\(\):\n    return 1\n```/);
    assert.doesNotMatch(markdown, /24|25|26|27/);
    assert.ok(markdown.endsWith('Following prose.'));
});

test('ordinary prose, numbered lists and adjacent CJK fragments stay outside code blocks', () => {
    const markdown = pdfTextToMarkdown(content([
        item('1', 36, 200), item('First point', 60, 200),
        item('2', 36, 180), item('Second point', 60, 180),
        item('3', 36, 160), item('Third point', 60, 160),
        item('中文', 36, 140, { width: 20 }), item('段落', 56, 140),
    ]));
    assert.equal(markdown, '1 First point\n\n2 Second point\n\n3 Third point\n\n中文段落');
});

test('unlabelled code stops before prose at the same font size', () => {
    const markdown = pdfTextToMarkdown(content([
        item('def run():', 36, 200), item('return 1', 60, 180),
        item('The result is ready.', 36, 160),
    ]));
    assert.match(markdown, /^```python\ndef run\(\):\n    return 1\n```\n\nThe result is ready\.$/);
});

test('code fences accommodate literal backticks and JSON labels', () => {
    const markdown = pdfTextToMarkdown(content([
        item('JSON', 36, 200), item('{"text": "```"}', 36, 180),
    ]));
    assert.equal(markdown, '````json\n{"text": "```"}\n````');
});

test('page viewport rotation is applied before reconstructing visual rows', () => {
    const normal = content([item('Python', 40, 200), item('x = 1', 40, 180)]);
    const rotated = content(normal.items.map(value => ({
        ...value, transform: [0, 10, -10, 0, -value.transform[5], value.transform[4]],
    })));
    assert.equal(pdfTextToMarkdown(rotated, [0, 1, 1, 0, 0, 0]), pdfTextToMarkdown(normal));
});

test('PDF conversion uses layout extraction and releases resources for successful and scanned PDFs', async () => {
    let destroyed = 0;
    let cleaned = 0;
    let pageContent = content([item('Python', 40, 200), item('x = 1', 40, 180)]);
    task = {
        promise: Promise.resolve({ numPages: 1, getPage: async () => ({
            getTextContent: async () => pageContent,
            getViewport: () => ({ transform: [1, 0, 0, -1, 0, 300] }),
            cleanup: () => cleaned++,
        }) }),
        destroy: async () => destroyed++,
    };
    assert.match(await convertPdfToMd(new ArrayBuffer(0)), /## 第 1 页\n\n```python\nx = 1\n```/);
    pageContent = content([]);
    await assert.rejects(convertPdfToMd(new ArrayBuffer(0)), /OCR/);
    assert.equal(destroyed, 2);
    assert.equal(cleaned, 2);
});
