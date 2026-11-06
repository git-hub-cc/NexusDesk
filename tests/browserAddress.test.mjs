import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/editor/BrowserEditor.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.replace(/^import .*;\r?$/gm, '').replace('import.meta.env.BASE_URL', '"/"')
  + '\nexports.validateBrowserAddress = validateBrowserAddress;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;
const context = { exports: {}, URL };
vm.runInNewContext(compiled, context);
const { validateBrowserAddress } = context.exports;

test('complete HTTP URLs are accepted and normalized', () => {
  assert.equal(validateBrowserAddress(' https://example.org/path?q=1 '), 'https://example.org/path?q=1');
  assert.equal(validateBrowserAddress('http://localhost:8080/'), 'http://localhost:8080/');
});

test('domains without a scheme are accepted and normalized to HTTP', () => {
  assert.equal(validateBrowserAddress('example.org'), 'http://example.org/');
  assert.equal(validateBrowserAddress('localhost:8080'), 'http://localhost:8080/');
});

test('plain text and malformed addresses are rejected', () => {
  for (const value of ['search terms', 'https://', 'https://example.org/path with spaces']) {
    assert.throws(() => validateBrowserAddress(value));
  }
});

test('address bar no longer contains suggestion or search behavior', () => {
  assert.doesNotMatch(source, /BrowserSuggestionPopup|suggestionsOpen|nexusdesk:speculate/);
  assert.doesNotMatch(source, /gemini\.google\.com\/app\?prompt=/);
});
