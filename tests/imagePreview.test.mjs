import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/imagePreview.ts', import.meta.url), 'utf8');
const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 });
const { imagePreviewScale } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('large images fit both viewport dimensions, including scales below 10%', () => {
  assert.equal(imagePreviewScale(4000, 2000, 800, 600), 0.2);
  assert.equal(imagePreviewScale(2000, 4000, 800, 600), 0.15);
  assert.equal(imagePreviewScale(20000, 10000, 800, 600), 0.04);
});

test('small images enlarge until the short side is 100px', () => {
  assert.equal(imagePreviewScale(20, 10, 800, 600), 10);
  assert.equal(imagePreviewScale(1, 1, 800, 600), 100);
  assert.equal(imagePreviewScale(50, 200, 800, 600), 2);
  assert.equal(imagePreviewScale(200, 300, 800, 600), 1);
});

test('viewport limits take priority when the minimum short side cannot fit', () => {
  assert.equal(imagePreviewScale(10000, 10, 800, 600), 0.08);
  assert.equal(imagePreviewScale(10, 10000, 800, 600), 0.06);
  assert.equal(imagePreviewScale(10, 10, 80, 60), 6);
});

test('resizing the viewport recalculates the fit; unloaded sizes stay valid', () => {
  assert.equal(imagePreviewScale(1600, 1200, 800, 600), 0.5);
  assert.equal(imagePreviewScale(1600, 1200, 400, 300), 0.25);
  assert.equal(imagePreviewScale(0, 0, 800, 600), 1);
  assert.equal(imagePreviewScale(100, 100, 0, 0), 1);
});
