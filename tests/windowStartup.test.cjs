const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

for (const scenario of ['frames', 'hidden', 'cancel']) {
  test(`window startup: ${scenario}`, () => {
    let id = 0, shown = 0;
    const frames = new Map(), timers = new Map();
    const context = {
      exports: {},
      requestAnimationFrame: fn => { frames.set(++id, fn); return id; },
      cancelAnimationFrame: id => frames.delete(id),
      setTimeout: fn => { timers.set(++id, fn); return id; },
      clearTimeout: id => timers.delete(id),
    };
    const source = fs.readFileSync(new URL('../src/lib/windowStartup.ts', `file://${__filename.replaceAll('\\', '/')}`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText, context);
    const cancel = context.exports.scheduleWindowReveal(() => shown++);
    const tick = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(fn => fn());
    };
    assert.equal(shown, 0);
    if (scenario === 'frames') {
      tick();
      assert.equal(shown, 0);
      tick();
      assert.equal(shown, 1);
      assert.equal(timers.size, 0);
    } else if (scenario === 'hidden') {
      [...timers.values()][0]();
      assert.equal(shown, 1);
      assert.equal(frames.size, 0);
    } else {
      cancel();
      assert.equal(shown, 0);
      assert.equal(frames.size, 0);
      assert.equal(timers.size, 0);
    }
  });
}
