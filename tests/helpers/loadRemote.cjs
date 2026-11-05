const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

module.exports = function loadRemote(invoke = async () => {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/lib/remote.ts'), 'utf8');
  const context = { exports: {}, require: name => {
    if (name === '@tauri-apps/api/core') return { invoke };
    throw new Error(`Unexpected dependency: ${name}`);
  } };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
  return context.exports;
};
