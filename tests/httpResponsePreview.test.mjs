import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/httpResponsePreview.ts', import.meta.url), 'utf8');
const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 });
const { compactResponseBase64 } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('large data URLs and bare Base64 stay compact while copying restores original selections', () => {
  const first = 'Ab9/'.repeat(250000);
  const second = 'Cd0+'.repeat(300);
  const body = JSON.stringify({ image: `data:image/png;base64,${first}`, other: second, message: 'hello' });
  const preview = compactResponseBase64(body);
  assert.ok(preview.text.length < 500);
  assert.equal(preview.copySelection(0, preview.text.length), body);
  const start = preview.text.indexOf('Cd0+');
  const end = preview.text.indexOf('","message"');
  assert.equal(preview.copySelection(start, end), second);
  assert.equal(preview.copySelection(preview.text.indexOf('hello'), preview.text.indexOf('hello') + 5), 'hello');
});

test('short text is preserved', () => {
  const body = '{"text":"normal response", "base64":"aGVsbG8="}';
  assert.equal(compactResponseBase64(body).text, body);
});
