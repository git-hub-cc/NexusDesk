import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { utils } from "@e965/xlsx";

const source = readFileSync(new URL("../src/lib/spreadsheetPreview.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { prepareSpreadsheetPreview, filterSpreadsheetRows } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("稀疏表仅保存已有单元格，搜索不再读取或格式化工作表", () => {
  let formatted = 0;
  const data = prepareSpreadsheetPreview({
    A1: { t: "s", v: "Start" }, IV100000: { t: "s", v: "END" }, "!ref": "A1:IV100000",
  }, { ...utils, format_cell(cell) { formatted++; return utils.format_cell(cell); } });
  assert.equal(data.rows.length, 100000);
  assert.equal(data.columns, 256);
  assert.equal(formatted, 2);
  assert.equal(data.rows.reduce((count, row) => count + Object.keys(row.cells).length, 0), 2);
  assert.deepEqual(data.rows[1].cells, {});
  assert.deepEqual(filterSpreadsheetRows(data.rows, " end ").map(row => row.index), [99999]);
  assert.deepEqual(filterSpreadsheetRows(data.rows, "START").map(row => row.index), [0]);
  assert.equal(filterSpreadsheetRows(data.rows, ""), data.rows);
  assert.equal(formatted, 2);
});

test("预览保留原始行号和已保存的格式化值，忽略超限单元格", () => {
  const data = prepareSpreadsheetPreview({
    C3: { t: "n", v: 0.25, z: "0%", f: "1/4" },
    D3: { t: "b", v: true },
    A100001: { t: "s", v: "outside row" },
    IW1: { t: "s", v: "outside column" },
    "!ref": "C3:IW100001",
  }, utils);
  assert.equal(data.truncated, true);
  assert.equal(data.rows.length, 100000);
  assert.equal(data.columns, 256);
  assert.equal(data.rows[2].cells[2], "25%");
  assert.equal(data.rows[2].cells[3], "TRUE");
  assert.deepEqual(filterSpreadsheetRows(data.rows, "25%").map(row => row.index), [2]);
  assert.equal(filterSpreadsheetRows(data.rows, "outside").length, 0);
});

test("缺失或空工作表没有虚假的空白行", () => {
  for (const worksheet of [undefined, {}]) {
    assert.deepEqual(prepareSpreadsheetPreview(worksheet, utils), { rows: [], columns: 0, truncated: false });
  }
});
