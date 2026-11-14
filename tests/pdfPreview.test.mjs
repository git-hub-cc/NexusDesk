import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/pdfPreview.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { renderPdfPreviewPage, pdfPreviewPageSize, pdfPageAtScrollOffset } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
globalThis.window = { devicePixelRatio: 1 };

test("连续预览按各页实际比例缩放，支持横竖页混排", () => {
  assert.deepEqual(pdfPreviewPageSize({ width: 600, height: 800 }, 648, 1), { width: 600, height: 800 });
  assert.deepEqual(pdfPreviewPageSize({ width: 800, height: 600 }, 648, 1), { width: 600, height: 450 });
  assert.deepEqual(pdfPreviewPageSize({ width: 800, height: 600 }, 648, 2), { width: 1200, height: 900 });
});

test("连续滚动根据实际页面位置更新页码，正确处理间距和文档末尾", () => {
  const pages = [24, 848, 1322].map(offsetTop => ({ offsetTop }));
  for (const [offset, expected] of [[0, 1], [24, 1], [847, 1], [848, 2], [1200, 2], [1322, 3], [9999, 3]]) {
    assert.equal(pdfPageAtScrollOffset(pages, offset), expected);
  }
});

test("连续预览保留全部页面的位置，仅渲染进入可见范围的页面", () => {
  const componentSource = readFileSync(new URL("../src/components/editor/DocumentPreview.tsx", import.meta.url), "utf8");
  const preview = componentSource.slice(componentSource.indexOf("function PdfPreview("), componentSource.indexOf("function SpreadsheetPreview("));
  const js = ts.transpileModule(preview, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  const bindings = {
    React, useRef: () => ({ current: null }), useEffect() {},
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
    PdfPage: "PdfPage", ChevronLeft: "ChevronLeft", ChevronRight: "ChevronRight", ZoomIn: "ZoomIn", ZoomOut: "ZoomOut",
  };
  const render = new Function(...Object.keys(bindings), `${js}\nreturn PdfPreview;`)(...Object.values(bindings));
  const tree = render({ resource: { document: { numPages: 120 } }, active: true });
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === "object" ? [node, ...flatten(node.children)] : [];
  const nodes = flatten(tree);
  const placeholders = nodes.filter(node => node.props["data-pdf-page"]);
  const contents = nodes.filter(node => node.type === "PdfPage");
  assert.deepEqual(placeholders.map(node => node.props["data-pdf-page"]), Array.from({ length: 120 }, (_, index) => index + 1));
  assert.equal(contents.length, 120);
  assert.deepEqual(contents.filter(node => node.props.visible).map(node => node.props.page), [1]);
});

function setup(getPage) {
  const lifetime = new AbortController();
  const render = new AbortController();
  const resource = { document: { getPage }, signal: lifetime.signal };
  const canvas = { width: 0, height: 0, style: {} };
  return { lifetime, render, resource, canvas, run: () => renderPdfPreviewPage(resource, canvas, 1, 648, 1, render.signal) };
}

test("已销毁的 PDF 不再读取页面，避免标签切换和重载后访问失效 worker", async () => {
  let reads = 0;
  const preview = setup(() => { reads++; throw new TypeError("Cannot read properties of null (reading 'sendWithPromise')"); });
  preview.lifetime.abort();
  await preview.run();
  assert.equal(reads, 0);
  assert.equal(preview.canvas.width, 0);
});

test("getPage 同步抛错转为可捕获的异步错误，不逃逸到 React effect", async () => {
  const failure = new TypeError("Cannot read properties of null (reading 'sendWithPromise')");
  const preview = setup(() => { throw failure; });
  let result;
  assert.doesNotThrow(() => { result = preview.run(); });
  await assert.rejects(result, error => error === failure);
});

test("页面加载期间释放文档后不再开始绘制", async () => {
  let resolvePage;
  let renders = 0;
  const preview = setup(() => new Promise(resolve => { resolvePage = resolve; }));
  const result = preview.run();
  preview.lifetime.abort();
  resolvePage({ render() { renders++; } });
  await result;
  assert.equal(renders, 0);
});

test("文档仍有效时，旧的缩放或翻页请求取消后也不再绘制", async () => {
  let resolvePage;
  const preview = setup(() => new Promise(resolve => { resolvePage = resolve; }));
  const result = preview.run();
  preview.render.abort();
  resolvePage({ render() { assert.fail("过期的渲染不应执行"); } });
  await result;
  assert.equal(preview.lifetime.signal.aborted, false);
});

test("正常页面按预览宽度绘制并完成", async () => {
  let renderOptions;
  const preview = setup(async () => ({
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render(options) {
      renderOptions = options;
      return { promise: Promise.resolve(), cancel() { assert.fail("已完成的渲染不应取消"); } };
    },
  }));
  await preview.run();
  assert.equal(preview.canvas.width, 600);
  assert.equal(preview.canvas.height, 800);
  assert.equal(preview.canvas.style.width, "600px");
  assert.equal(renderOptions.canvas, preview.canvas);
  preview.lifetime.abort();
  preview.render.abort();
});

test("释放文档会取消正在进行的绘制", async () => {
  let cancelCount = 0;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const preview = setup(async () => ({
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render() {
      let rejectRender;
      const promise = new Promise((_, reject) => { rejectRender = reject; });
      started();
      return { promise, cancel() { cancelCount++; rejectRender(new Error("Rendering cancelled")); } };
    },
  }));
  const result = preview.run();
  const rejection = assert.rejects(result, /Rendering cancelled/);
  await ready;
  preview.lifetime.abort();
  await rejection;
  assert.equal(cancelCount, 1);
  preview.render.abort();
  assert.equal(cancelCount, 1);
});
