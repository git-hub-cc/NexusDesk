import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { paths, assetsUrl } from "./helpers/loadSource.mjs";

const { samePath, isWithinPath, normalizePath } = paths;
const { isImage, canReadAsText, canPreview, canCompareAsText } = await import(assetsUrl);

test("Windows and UNC paths ignore case; POSIX and SFTP paths preserve it", () => {
  assert.ok(samePath("C:\\Project\\A.md", "c:/project/a.md/"));
  assert.ok(samePath("\\\\Server\\Share\\A.md", "//server/share/a.md"));
  assert.equal(samePath("/notes/A.md", "/notes/a.md"), false);
  assert.equal(samePath("sftp://one/notes/A.md", "sftp://one/notes/a.md"), false);
  assert.equal(samePath("sftp://one/a.md", "sftp://two/a.md"), false);
});

test("containment respects directory boundaries and filesystem roots", () => {
  assert.ok(isWithinPath("C:/Project/a.md", "c:/project/"));
  assert.equal(isWithinPath("C:/Project-other/a.md", "c:/project"), false);
  assert.ok(isWithinPath("/notes/a.md", "/"));
  assert.ok(isWithinPath("C:/a.md", "C:/"));
  assert.ok(isWithinPath("sftp://one/a.md", "sftp://one/"));
  assert.equal(isWithinPath("sftp://two/a.md", "sftp://one/"), false);
  assert.equal(normalizePath("/"), "/");
});

test("file capabilities distinguish editable SVG, binary previews and unsupported binaries", () => {
  assert.ok(isImage("photo.AVIF"));
  assert.ok(canPreview("photo.AVIF"));
  assert.equal(canReadAsText("photo.AVIF"), false);
  assert.equal(canCompareAsText("photo.AVIF"), false);
  assert.ok(canReadAsText("drawing.svg"));
  assert.equal(canCompareAsText("drawing.svg"), false);
  for (const path of ["movie.mp4", "document.pdf", "sheet.xlsx"]) {
    assert.ok(canPreview(path));
    assert.equal(canReadAsText(path), false);
  }
  assert.equal(canPreview("archive.zip"), false);
  assert.equal(canReadAsText("archive.zip"), false);
  assert.ok(canCompareAsText("file.tree"));
});

test("filesystem text reads use the same file capabilities as previews and comparison", async () => {
  const assets = await import(assetsUrl);
  const reads = [];
  const context = { exports: {}, require: name => {
    if (name === "./assets") return assets;
    if (name === "./remote") return {
      isRemotePath: path => path.startsWith("sftp://"),
      invokePathCommand: async (command, { path }) => { reads.push([command, path]); return "text"; },
    };
    return {};
  } };
  const source = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  const api = context.exports.fsApi;
  assert.equal(await api.readFile("image.avif"), "");
  assert.equal(await api.readFile("document.pdf"), "");
  assert.equal(await api.readFile("image.svg"), "text");
  assert.equal(await api.readFile("sftp://one/note.md"), "text");
  assert.deepEqual(reads, [["read_file", "image.svg"], ["read_file", "sftp://one/note.md"]]);
});
