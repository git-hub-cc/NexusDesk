const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');

const source = fs.readFileSync(`${__dirname}/../src/lib/terminalLinks.ts`, 'utf8');
const context = { exports: {}, URL };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, context);
const { terminalFileLinks, resolveTerminalPath } = context.exports;

test('real xterm buffer preserves complete links across wrapping and resize', async () => {
  const { Terminal } = require('@xterm/xterm');
  const terminal = new Terminal({ cols: 16, rows: 24, allowProposedApi: true });
  try {
    const path = 'C:/projects/very-long-directory/main.ts';
    await new Promise(resolve => terminal.write(`output\r\n${path}:12:3\r\n`, resolve));
    for (const cols of [16, 9, 30, 80]) {
      terminal.resize(cols, 24);
      const buffer = terminal.buffer.active;
      let segments = 0;
      for (let row = 1; row <= buffer.length; row++) {
        for (const link of context.exports.terminalBufferFileLinks(buffer, row, cols)) {
          segments++;
          assert.equal(link.path, path);
          assert.equal(link.line, 12);
          assert.equal(link.column, 3);
          assert.equal(link.text, `${path}:12:3`);
          assert.ok(link.range.start.y <= row && link.range.end.y >= row);
        }
      }
      assert.ok(segments > 0, `no links at width ${cols}`);
    }
  } finally {
    terminal.dispose();
  }
});

function wrappedBuffer(text, cols) {
  const rows = [];
  for (const char of text) {
    const width = char.codePointAt(0) > 0xff ? 2 : 1;
    if (!rows.length || rows.at(-1).length + width > cols) rows.push([]);
    rows.at(-1).push({ getChars: () => char, getWidth: () => width });
    if (width === 2) rows.at(-1).push({ getChars: () => '', getWidth: () => 0 });
  }
  return { length: rows.length, getLine: row => rows[row] && ({
    isWrapped: row > 0,
    getCell: col => rows[row][col] ?? { getChars: () => '', getWidth: () => 1 },
  }) };
}

test('recovers local ConPTY bundle paths when a repaint loses soft wrap flags', async () => {
  const { Terminal } = require('@xterm/xterm');
  const first = String.raw`        C:\Users\user\Desktop\NexusDeskTmp\src-tauri\target\release\bun`;
  const tail = String.raw`dle\nsis\NexusDesk_0.1.1_x64-setup.exe`;
  const path = first.trimStart() + tail;
  const terminal = new Terminal({ cols: first.length, rows: 12, allowProposedApi: true });
  try {
    await new Promise(resolve => terminal.write(
      `    Finished 1 bundle at:\r\n${first}\r\n${tail} (33.13 MiB)\r\n\r\nPS C:\\Users\\user\\Desktop\\NexusDeskTmp> `, resolve));
    assert.equal(terminal.buffer.active.getLine(2).isWrapped, false);
    for (const row of [2, 3]) {
      const links = context.exports.terminalBufferFileLinks(terminal.buffer.active, row, terminal.cols, true);
      assert.equal(links.length, 1);
      assert.equal(links[0].path, path);
      assert.equal(links[0].range.start.y, 2);
      assert.equal(links[0].range.end.y, 3);
      assert.equal(links[0].range.end.x, tail.length);
    }
    assert.equal(context.exports.terminalBufferFileLinks(terminal.buffer.active, 3, terminal.cols).length, 0);
  } finally {
    terminal.dispose();
  }
});

test('reassembles full paths and source positions after terminal reflow', () => {
  const text = 'error C:/projects/a-long-directory/main.ts:12:3';
  for (const cols of [12, 20, 80]) {
    const buffer = wrappedBuffer(text, cols);
    for (let row = 1; row <= buffer.length; row++) {
      const links = context.exports.terminalBufferFileLinks(buffer, row, cols);
      assert.equal(links.length, 1);
      assert.equal(links[0].path, 'C:/projects/a-long-directory/main.ts');
      assert.equal(links[0].line, 12);
      assert.equal(links[0].column, 3);
      assert.equal(links[0].range.start.x, 7);
      assert.equal(links[0].range.end.y, Math.ceil(text.length / cols));
    }
  }
});

test('maps wide characters to terminal cells and keeps hard line breaks separate', () => {
  const buffer = wrappedBuffer('中文 C:/目录/main.ts', 10);
  const links = context.exports.terminalBufferFileLinks(buffer, 1, 10);
  assert.equal(links[0].path, 'C:/目录/main.ts');
  assert.equal(links[0].range.start.x, 6);
  const hard = wrappedBuffer('C:/work/other.ts', 8);
  const getLine = hard.getLine;
  hard.getLine = row => { const line = getLine(row); if (line) line.isWrapped = false; return line; };
  assert.equal(context.exports.terminalBufferFileLinks(hard, 2, 8).length, 0);
});

test('recognizes Node, Rust, Python, .NET and TypeScript source locations', () => {
  for (const [text, path, line, column] of [
    ['    at fn (C:/work/app.ts:12:4)', 'C:/work/app.ts', 12, 4],
    ['D:/src/main.rs:22:5', 'D:/src/main.rs', 22, 5],
    ['File "C:/tmp/a b.py", line 9', 'C:/tmp/a b.py', 9, 1],
    ['at fn in C:/work/Foo.cs:line 18', 'C:/work/Foo.cs', 18, 1],
    ['c:/src/app.ts(3,7): error', 'c:/src/app.ts', 3, 7],
    ['C:\\my project\\app.ts:8:2', 'C:\\my project\\app.ts', 8, 2],
  ]) {
    const links = terminalFileLinks(text);
    assert.equal(links.length, 1, text);
    assert.equal(links[0].path, path, text);
    assert.equal(links[0].line, line, text);
    assert.equal(links[0].column, column, text);
  }
});

test('links every wrapped segment with buffer coordinates and complete quoted paths', () => {
  const text = 'open "C:/my project/long directory/notes.md" then D:/src/main.ts:27:8';
  for (const cols of [5, 11, 23, 100]) {
    const wrapped = wrappedBuffer(text, cols);
    const offset = 4;
    const buffer = {
      length: offset + wrapped.length,
      getLine: row => row < offset
        ? { isWrapped: false, getCell: () => ({ getChars: () => '', getWidth: () => 1 }) }
        : wrapped.getLine(row - offset),
    };
    for (let row = 1; row <= buffer.length; row++) {
      const links = context.exports.terminalBufferFileLinks(buffer, row, cols);
      const expected = terminalFileLinks(text).filter(link => {
        const startRow = offset + Math.floor(link.start / cols) + 1;
        const endRow = offset + Math.floor((link.start + link.length - 1) / cols) + 1;
        return row >= startRow && row <= endRow;
      });
      assert.equal(links.length, expected.length);
      links.forEach((link, index) => {
        const original = expected[index];
        assert.equal(link.path, original.path);
        assert.equal(link.text, text.slice(original.start, original.start + original.length));
        assert.equal(link.range.start.x, original.start % cols + 1);
        assert.equal(link.range.start.y, offset + Math.floor(original.start / cols) + 1);
        assert.equal(link.range.end.x, (original.start + original.length - 1) % cols + 1);
        assert.equal(link.range.end.y, offset + Math.floor((original.start + original.length - 1) / cols) + 1);
      });
    }
  }
});

test('resolves relative paths without losing Windows drives or UNC roots', () => {
  assert.equal(resolveTerminalPath('../app.ts', 'C:/work/src'), 'C:/work/app.ts');
  assert.equal(resolveTerminalPath('src/app.ts', '/work'), '/work/src/app.ts');
  assert.equal(resolveTerminalPath('\\\\server\\share\\app.ts', null), '//server/share/app.ts');
  assert.throws(() => resolveTerminalPath('app.ts', null));
});

test('ignores ordinary output and invalid line numbers', () => {
  assert.equal(terminalFileLinks('listening on localhost:3000').length, 0);
  assert.equal(terminalFileLinks('C:/src/app.ts:0').length, 0);
  assert.equal(terminalFileLinks('C:/src/a.ts:1 D:/src/b.ts:2:3').length, 2);
});

test('recognizes plain terminal paths and quoted paths containing spaces', () => {
  for (const [text, path] of [
    ['saved C:\\work\\notes.md', 'C:\\work\\notes.md'],
    ['edit D:/src/main.ts', 'D:/src/main.ts'],
    ['"C:\\my project\\notes.md"', 'C:\\my project\\notes.md'],
    ["'D:/tmp/my notes.md'", 'D:/tmp/my notes.md'],

  ]) {
    const links = terminalFileLinks(text);
    assert.equal(links.length, 1, text);
    assert.equal(links[0].path, path);
    assert.equal(text.slice(links[0].start, links[0].start + links[0].length), path);
    assert.equal(links[0].line, 1);
  }
});

test('ignores paths that do not start with a drive and root separator', () => {
  for (const text of [
    'README.md', 'src/main.ts', './src/main.ts', '../main.ts',
    'src/main.rs:22:5', 'src/app.ts(3,7): error',
    'File "/tmp/a b.py", line 9', "'/tmp/my notes.md'",
    '/tmp/app.ts:3', 'C:notes.md', 'file:///C:/work/app.ts',
    'file:///C:/work/app.ts:3', String.raw`\\server\share\app.ts`,
  ]) {
    assert.equal(terminalFileLinks(text).length, 0, text);
  }
});
