import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/speechMicrophone.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source.replace(/export /g, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function setup(getUserMedia) {
  const context = { navigator: { mediaDevices: { getUserMedia } }, Error };
  vm.runInNewContext(compiled, context);
  return context;
}

test("microphone opens without imposing the recognition sample rate on hardware", async () => {
  const stream = {};
  const env = setup(async constraints => {
    assert.equal(constraints.audio.channelCount, 1);
    assert.equal("sampleRate" in constraints.audio, false);
    return stream;
  });
  assert.equal(await env.openSpeechMicrophone(), stream);
});

test("device and constraint failures fall back to the default audio configuration", async () => {
  for (const name of ["NotReadableError", "OverconstrainedError"]) {
    let calls = 0;
    const stream = {};
    const env = setup(async constraints => {
      if (++calls === 1) throw Object.assign(new Error("Could not start audio source"), { name });
      assert.equal(constraints.audio, true);
      return stream;
    });
    assert.equal(await env.openSpeechMicrophone(), stream);
    assert.equal(calls, 2);
  }
});

test("denied permissions do not trigger another microphone request", async () => {
  let calls = 0;
  const error = Object.assign(new Error("denied"), { name: "NotAllowedError" });
  const env = setup(async () => { calls++; throw error; });
  await assert.rejects(env.openSpeechMicrophone(), candidate => candidate === error);
  assert.equal(calls, 1);
  assert.match(env.speechStartupError(error), /桌面应用访问/);
});

test("persistent hardware failures remain failures with actionable guidance", async () => {
  let calls = 0;
  const error = Object.assign(new Error("Could not start audio source"), { name: "NotReadableError" });
  const env = setup(async () => { calls++; throw error; });
  await assert.rejects(env.openSpeechMicrophone(), candidate => candidate === error);
  assert.equal(calls, 2);
  assert.match(env.speechStartupError(error), /独占麦克风/);
  assert.match(env.speechStartupError("engine failed"), /engine failed/);
});
