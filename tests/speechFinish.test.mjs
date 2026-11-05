import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/editor/SpeechToText.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("SpeechToText.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let stopSource;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "stop") {
    stopSource = node.initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);

function setup({ finishOnClose = true, preparing = false } = {}) {
  const calls = [];
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const ref = current => ({ current });
  const context = {
    finishOnClose, stoppingRef: ref(false), stopped: ref(false), preparingRef: ref(preparing),
    sessionId: "speech-test", releaseSpeechSession: id => calls.push(`release-session:${id}`),
    finishingRef: ref(false), failedRef: ref(false), pausedRef: ref(false), flushRequested: ref(true),
    retrySamples: ref(null), buffer: { current: { clear: () => calls.push("clear") } },
    setIsStopping() {}, setFinishing() {}, releaseMicrophone: () => calls.push("release"),
    flushRef: ref(() => { calls.push("flush"); return pending; }),
    invoke: async () => {}, cleanup: () => calls.push("cleanup"), onClose: () => calls.push("close"),
  };
  vm.runInNewContext(`globalThis.stop = ${stopSource};`, context);
  return { context, calls, resolve, stop: context.stop };
}

test("global close waits for the final transcription and insertion before releasing the window", async () => {
  const env = setup();
  const closing = env.stop();
  assert.deepEqual(env.calls, ["release", "release-session:speech-test", "flush"]);
  await env.stop();
  assert.deepEqual(env.calls, ["release", "release-session:speech-test", "flush"]);
  env.resolve();
  await closing;
  assert.equal(env.calls.at(-1), "close");
  assert.equal(env.context.finishingRef.current, true);
});

test("failed final insertion keeps its error visible and a second close dismisses the window", async () => {
  const env = setup();
  const closing = env.stop();
  env.context.failedRef.current = true;
  env.resolve();
  await closing;
  assert.equal(env.calls.includes("close"), false);
  await env.stop();
  assert.equal(env.calls.at(-1), "close");
});

test("workspace sessions and global startup can close immediately", async () => {
  for (const options of [{ finishOnClose: false }, { preparing: true }]) {
    const env = setup(options);
    await env.stop();
    assert.equal(env.calls.includes("flush"), false);
    assert.equal(env.calls.at(-1), "close");
  }
});
