import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";

let source = readFileSync(new URL("../src/components/editor/formatCode.ts", import.meta.url), "utf8");
source = source.replace(/(["'])(@codemirror\/commands|prettier\/[^"']+)\1/g, (_, quote, name) => JSON.stringify(import.meta.resolve(name)));
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { formatCode } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
function editor(doc, selection, readOnly = false) {
  const view = { state: EditorState.create({ doc, selection, extensions: [history(), EditorState.readOnly.of(readOnly)] }), composing: false };
  view.dispatch = spec => { view.state = spec.state ?? view.state.update(spec).state; };
  return view;
}

test("formats a document and can undo in one step", async () => {
  const input = 'const x={a:1,b:2}';
  const view = editor(input);
  await formatCode(view, "test.ts", () => true);
  assert.equal(view.state.doc.toString(), 'const x = { a: 1, b: 2 };\n');
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), input);
});

test("selection formats only the selected statement", async () => {
  const input = 'const a={x:1};\nconst b={y:2};\n';
  const view = editor(input, { anchor: 0, head: 14 });
  await formatCode(view, "test.js", () => true);
  assert.equal(view.state.doc.toString(), 'const a = { x: 1 };\nconst b={y:2};\n');
});

test("does not overwrite edits, switched tabs, read-only documents or invalid code", async () => {
  const view = editor('{"a":1}');
  const pending = formatCode(view, "test.json", () => true);
  view.dispatch({ changes: { from: 0, insert: " " } });
  await pending;
  assert.equal(view.state.doc.toString(), ' {"a":1}');
  await formatCode(view, "test.json", () => false);
  assert.equal(view.state.doc.toString(), ' {"a":1}');
  const locked = editor('{"a":1}', undefined, true);
  await formatCode(locked, "test.json", () => true);
  assert.equal(locked.state.doc.toString(), '{"a":1}');
  const invalid = editor('{"a":');
  await assert.rejects(formatCode(invalid, "test.json", () => true));
  assert.equal(invalid.state.doc.toString(), '{"a":');
});

test("formats JSON bodies in HTTP requests and preserves other content", async () => {
  const input = '### first\nPOST https://example.com\nContent-Type: application/json\n\n{"a":1,"b":[2,3]}\n\n### second\nPOST https://example.com\n\nnot json\n';
  const view = editor(input);
  await formatCode(view, "test.http", () => true);
  assert.equal(view.state.doc.toString(), '### first\nPOST https://example.com\nContent-Type: application/json\n\n{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n\n### second\nPOST https://example.com\n\nnot json\n');
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), input);
});

test("formats only the selected REST request body", async () => {
  const input = 'POST https://a\n\n{"a":1}\n### next\nPOST https://b\n\n{"b":2}';
  const view = editor(input, { anchor: 15, head: 20 });
  await formatCode(view, "test.rest", () => true);
  assert.equal(view.state.doc.toString(), 'POST https://a\n\n{\n  "a": 1\n}\n### next\nPOST https://b\n\n{"b":2}');
});

test("formats consecutive HTTP requests without separators", async () => {
  const input = 'POST https://a\nContent-Type: application/json\n\n{"a":1}\n\nPOST https://b\n\n{"b":2}';
  const view = editor(input);
  await formatCode(view, "test.http", () => true);
  assert.equal(view.state.doc.toString(), 'POST https://a\nContent-Type: application/json\n\n{\n  "a": 1\n}\n\nPOST https://b\n\n{\n  "b": 2\n}');
});
