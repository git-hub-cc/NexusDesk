import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/editor/speechBuffer.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { SpeechBuffer, SpeechTask, acquireSpeechSession, releaseSpeechSession } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("slow inference cannot grow the recording buffer without bound", () => {
  const buffer = new SpeechBuffer();
  const chunk = new Float32Array(16000);
  for (let i = 0; i < 24; i++) assert.equal(buffer.append(chunk), true);
  assert.equal(buffer.append(chunk), false);
  assert.equal(buffer.length, SpeechBuffer.capacity);
  buffer.clear();
  assert.equal(buffer.length, 0);
  assert.equal(buffer.take().length, 0);
});

test("splits across capture chunks without losing or reordering the final phrase", () => {
  const buffer = new SpeechBuffer();
  const input = Float32Array.from({ length: SpeechBuffer.segmentLength + 4321 }, (_, i) => i);
  buffer.append(input.subarray(0, 9000));
  buffer.append(input.subarray(9000));
  assert.deepEqual(buffer.take(), input.subarray(0, SpeechBuffer.segmentLength));
  assert.deepEqual(buffer.take(), input.subarray(SpeechBuffer.segmentLength));
  assert.equal(buffer.length, 0);
});

test("repeated capture callbacks and Finish await the same recognition task", async () => {
  const task = new SpeechTask();
  let release;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const work = async () => { calls++; await gate; };
  const first = task.run(work);
  for (let i = 0; i < 100; i++) assert.equal(task.run(work), first);
  const finish = task.run(work);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await finish;
  await task.run(work);
  assert.equal(calls, 2);
});

test("a failed recognition task releases the lock for retry", async () => {
  const task = new SpeechTask();
  await assert.rejects(task.run(async () => { throw new Error("inference failed"); }));
  let ran = false;
  await task.run(async () => { ran = true; });
  assert.equal(ran, true);
});

test("only one speech session can acquire the microphone at a time", () => {
  assert.equal(acquireSpeechSession("first"), true);
  assert.equal(acquireSpeechSession("second"), false);
  releaseSpeechSession("second");
  assert.equal(acquireSpeechSession("third"), false);
  releaseSpeechSession("first");
  assert.equal(acquireSpeechSession("third"), true);
  releaseSpeechSession("third");
});
