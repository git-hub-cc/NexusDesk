const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(`${__dirname}/../src/lib/terminalHistory.ts`, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, context);
const { matchTerminalHistory: match, terminalPromptInput: input } = context.exports;

test('requires two characters and limits candidates to eight', () => {
  assert.equal(match(['git status'], 'g').length, 0);
  assert.equal(match(Array.from({ length: 20 }, (_, i) => `git ${i}`), 'gi').length, 8);
});
test('ranks prefix before substring before subsequence and highlights actual matches', () => {
  const results = match(['great idea', 'echo git', 'git status'], 'gi');
  assert.equal(results.map(r => r.command).join('|'), 'git status|echo git|great idea');
  assert.equal(results[2].indices.join(','), '0,6');
  assert.equal(match(['GIT status'], 'git')[0].indices.join(','), '0,1,2');
});
test('reads shell commands without retaining prompt and rejects ordinary application input', () => {
  assert.equal(input('PS C:\\work> git status'), 'git status');
  assert.equal(input('user@host:~$ npm test'), 'npm test');
  assert.equal(input('C:\\work> dir'), 'dir');
  assert.equal(input('Password: secret'), undefined);
});
