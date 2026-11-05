import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/browserPool.ts', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/export /g, '');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('browser views are allocated on demand without warming or speculative navigation', () => {
  let id = 0;
  const context = vm.createContext({
    crypto: { randomUUID: () => String(++id) },
    getCurrentWindow: () => ({ label: 'main' }),
  });
  vm.runInContext(compiled, context);
  const run = code => vm.runInContext(code, context);

  run('warmBrowserPool(); speculateBrowser("https://example.com/")');
  const first = run('reserveBrowser()');
  const second = run('reserveBrowser()');
  assert.equal(first.warm, false);
  assert.equal(second.warm, false);
  assert.notEqual(first.label, second.label);
  assert.equal(run('takeSpeculativeBrowser("https://example.com/")'), undefined);
});
