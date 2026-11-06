import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/httpStreamExtraction.ts', import.meta.url), 'utf8');
const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 });
const { extractStreamContent, extractResponseUrls } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const template = 'data: {"choices":[{"delta":{"content":"{{content}}"}}]}';

test('automatically extracts and classifies URLs, decodes JSON escapes and deduplicates', () => {
  const urls = ['https://cdn.example/a.PNG?token=1#preview', 'https://cdn.example/movie.mp4?q=2', 'https://cdn.example/file.pdf'];
  const body = urls.map(url => `data: ${JSON.stringify({url})}\n\n`).join('') + JSON.stringify({url: urls[0]});
  assert.deepEqual(extractResponseUrls(body), urls.map((url, i) => ({url, kind: ['image', 'video', 'file'][i]})));
  assert.deepEqual(extractResponseUrls(String.raw`{"url":"https:\/\/example.com\/a.png?x=1\u0026y=2"}`), [{url: 'https://example.com/a.png?x=1&y=2', kind: 'image'}]);
});

test('extracts plain and markdown URLs and ignores non-HTTP schemes', () => {
  assert.deepEqual(extractResponseUrls('![image](https://example.com/a.png) https://example.com/a.png https://example.com/file.zip. javascript:alert(1)'), [
    {url: 'https://example.com/a.png', kind: 'image'},
    {url: 'https://example.com/file.zip', kind: 'file'},
  ]);
  assert.deepEqual(extractResponseUrls('no urls'), []);
});

test('extracts SSE text, ignores changing metadata, missing nodes and DONE, decodes escapes', () => {
  const chunks = [
    { choices: [{ delta: { role: 'assistant' } }] },
    { id: 'a', choices: [{ delta: { content: '你好\n' } }] },
    { id: 'b', choices: [{ delta: { content: '"world"' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];
  const body = ': heartbeat\r\n\r\n' + chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
  assert.deepEqual(extractStreamContent(body, template), { content: '你好\n"world"', matches: 2 });
});

test('handles multiline SSE events and incomplete final JSON', () => {
  assert.deepEqual(extractStreamContent('event: delta\ndata: {"choices":\ndata: [{"delta":{"content":"ok"}}]}\n\ndata: {', template), { content: 'ok', matches: 1 });
});

test('handles JSONL and validates templates', () => {
  assert.deepEqual(extractStreamContent('{"text":"a"}\ninvalid\n{"text":"b"}', '{"text":"{{content}}"}'), { content: 'ab', matches: 2 });
  assert.throws(() => extractStreamContent('', '{}'));
  assert.throws(() => extractStreamContent('', '{'));
  assert.deepEqual(extractStreamContent('anything', ''), { content: '', matches: 0 });
});
