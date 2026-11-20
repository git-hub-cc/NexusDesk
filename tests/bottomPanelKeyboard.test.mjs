import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/layout/BottomPanel.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const handleTabKeyDown =');
const end = source.indexOf('\n  const closeSessions', start);
const code = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const handle = vm.runInNewContext(`${code}; handleTabKeyDown`);

function press(key, modifiers = {}) {
  const unexpected = () => assert.fail('Arrow keys must not move focus or activate a tab');
  const event = {
    key, nativeEvent: {},
    target: { focus: unexpected, click: unexpected, closest: unexpected },
    currentTarget: { querySelectorAll: unexpected },
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    ...modifiers,
  };
  handle(event);
  return event;
}

test('plain left and right arrows suppress default focus navigation without switching tabs', () => {
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    const event = press(key);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  }
});

test('other keys, modified shortcuts and composition retain their key handling', () => {
  for (const key of ['Enter', ' ', 'Home', 'End', 'Tab', 'ArrowDown']) {
    assert.equal(press(key).prevented, undefined);
  }
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
      assert.equal(press(key, { [modifier]: true }).prevented, undefined);
    }
    assert.equal(press(key, { nativeEvent: { isComposing: true } }).prevented, undefined);
  }
});
