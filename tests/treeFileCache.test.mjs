import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync(new URL('../src/lib/treeFileCache.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { readCachedTreeFile: read, invalidateTreeFiles: invalidate } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('tree cache deduplicates concurrent reads and reuses content until invalidated', async () => {
  invalidate([]);
  let calls = 0;
  const loader = async () => String(++calls);
  assert.deepEqual(await Promise.all([read('C:\\notes\\a.tree', loader), read('c:/notes/a.tree', loader)]), ['1', '1']);
  assert.equal(await read('c:/notes/a.tree', loader), '1');
  invalidate(['C:/notes']);
  assert.equal(await read('c:/notes/a.tree', loader), '2');
});

test('invalidated in-flight reads cannot overwrite fresh content; failures can retry', async () => {
  invalidate([]);
  let finish;
  const stale = read('a.tree', () => new Promise(resolve => { finish = resolve; }));
  invalidate(['a.tree']);
  assert.equal(await read('a.tree', async () => 'fresh'), 'fresh');
  finish('stale');
  await stale;
  assert.equal(await read('a.tree', async () => 'unexpected'), 'fresh');
  await assert.rejects(read('failed.tree', async () => { throw new Error('read failed'); }));
  assert.equal(await read('failed.tree', async () => 'retry'), 'retry');
});

test('remote paths preserve case and separate connections', async () => {
  invalidate([]);
  assert.equal(await read('sftp://one/A.tree', async () => 'A'), 'A');
  assert.equal(await read('sftp://one/a.tree', async () => 'a'), 'a');
  assert.equal(await read('sftp://two/A.tree', async () => 'other'), 'other');
});
