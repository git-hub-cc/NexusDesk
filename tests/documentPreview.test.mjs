import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/editor/DocumentPreview.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function setup() {
  const slots = [];
  let cursor = 0;
  let pending = [];
  let reads = 0;
  let destroyed = 0;
  const document = { numPages: 3 };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        pending.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@tauri-apps/api/core": { invoke: async () => {} },
    "@tauri-apps/plugin-opener": { openPath: async () => {} },
    "lucide-react": {},
    "@/lib/api": { fsApi: { readBinaryFile: async () => { reads++; return [37, 80, 68, 70]; } } },
    "@/lib/remote": { isRemotePath: path => path.startsWith("sftp://") },
    "@/lib/pdfPreview": {},
    "@/lib/spreadsheetPreview": {},
    "pdfjs-dist": { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(document), destroy: async () => { destroyed++; } }) },
    "pdfjs-dist/build/pdf.worker.min.mjs?url": { default: "worker.mjs" },
    "@e965/xlsx": { read: () => ({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } }) },
  };
  const exports = {};
  new Function("require", "exports", compiled)(name => {
    assert.ok(name in modules, `Unexpected module: ${name}`);
    return modules[name];
  }, exports);
  return {
    render(path, active) {
      cursor = 0;
      const tree = exports.DocumentPreview({ path, active });
      const effects = pending;
      pending = [];
      effects.forEach(effect => effect());
      return tree;
    },
    close() { slots.forEach(slot => slot?.cleanup?.()); },
    get reads() { return reads; },
    get destroyed() { return destroyed; },
  };
}

function flatten(node) {
  if (Array.isArray(node)) return node.flatMap(flatten);
  return node && typeof node === "object" ? [node, ...flatten(node.props?.children)] : [];
}

test("切换标签保留同一 PDF 预览资源，后台暂停渲染，关闭时才释放", async () => {
  const preview = setup();
  preview.render("test.pdf", true);
  await new Promise(resolve => setImmediate(resolve));
  const findPdf = tree => flatten(tree).find(node => node.type?.name === "PdfPreview");
  const initial = findPdf(preview.render("test.pdf", true));
  assert.ok(initial);
  const inactive = findPdf(preview.render("test.pdf", false));
  assert.equal(inactive.props.resource, initial.props.resource);
  assert.equal(inactive.props.active, false);
  const restored = findPdf(preview.render("test.pdf", true));
  assert.equal(restored.props.resource, initial.props.resource);
  assert.equal(restored.props.active, true);
  assert.equal(preview.reads, 1);
  assert.equal(preview.destroyed, 0);
  assert.equal(initial.props.resource.signal.aborted, false);
  preview.close();
  assert.equal(preview.destroyed, 1);
  assert.equal(initial.props.resource.signal.aborted, true);
});

test("远程 PDF 和 XLSX 提示保存到本地，不发起二进制读取", async () => {
  for (const path of ["sftp://server/report.pdf", "sftp://server/report.xlsx"]) {
    const preview = setup();
    preview.render(path, true);
    await new Promise(resolve => setImmediate(resolve));
    const tree = preview.render(path, true);
    const alert = flatten(tree).find(node => node.props?.role === "alert");
    assert.ok(alert);
    assert.match(JSON.stringify(alert), /请先将文档保存到本地/);
    assert.equal(preview.reads, 0);
    preview.close();
  }
});

test("切换标签保留同一工作簿和表格组件，重新加载才替换资源", async () => {
  const preview = setup();
  preview.render("test.xlsx", true);
  await new Promise(resolve => setImmediate(resolve));
  const findSheet = tree => flatten(tree).find(node => node.type?.name === "SpreadsheetPreview");
  const initial = findSheet(preview.render("test.xlsx", true));
  assert.ok(initial);
  assert.equal(findSheet(preview.render("test.xlsx", false)).props.workbook, initial.props.workbook);
  const restored = preview.render("test.xlsx", true);
  assert.equal(findSheet(restored).props.workbook, initial.props.workbook);
  assert.equal(preview.reads, 1);
  const reload = flatten(restored).find(node => node.type === "button" && node.props.children?.includes?.("重新加载"));
  assert.ok(reload);
  reload.props.onClick();
  preview.render("test.xlsx", true);
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(findSheet(preview.render("test.xlsx", true)).props.workbook, initial.props.workbook);
  assert.equal(preview.reads, 2);
  preview.close();
});
