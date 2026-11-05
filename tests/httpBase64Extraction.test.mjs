import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/httpBase64Extraction.ts', import.meta.url), 'utf8');
const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 });
const { extractResponseBase64: extract } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('extracts data URIs by MIME prefix and deduplicates', () => {
  const urls = ['data:image/png;base64,aGVsbG8=', 'data:video/mp4;base64,YWJj', 'data:audio/mpeg;base64,YWJj', 'data:application/pdf;base64,YWJj'];
  assert.deepEqual(extract(JSON.stringify([...urls, urls[0]])).map(({url, kind}) => ({url, kind})), urls.map((url, i) => ({url, kind: ['image', 'video', 'audio', 'file'][i]})));
});

test('handles JSON escapes, MIME parameters and default MIME', () => {
  assert.equal(extract(String.raw`{"image":"data:image\/png;base64,\/9j\/"}`)[0].url, 'data:image/png;base64,/9j/');
  assert.equal(extract(String.raw`data\u003aimage/png;base64,YWJj`)[0].kind, 'image');
  assert.equal(extract('data:text/plain;charset=utf-8;base64,YWJj')[0].mimeType, 'text/plain');
  assert.equal(extract('data:;base64,YWJj')[0].mimeType, 'text/plain');
});

test('ignores ordinary URLs, bare strings, empty and malformed payloads', () => {
  assert.deepEqual(extract('https://example.com/a.png YWJj data:image/png;base64, data:image/png;base64,A data:image/png;base64,YWJj='), []);
});
