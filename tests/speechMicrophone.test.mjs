import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/utils/speechMicrophone.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source.replace(/export /g, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function setup(getUserMedia) {
  const context = { navigator: { mediaDevices: { getUserMedia } }, Error, setTimeout, clearTimeout };
  vm.runInNewContext(compiled, context);
  return context;
}

test("audio startup resumes a suspended context and validates its state", async () => {
  const env = setup();
  const context = { state: "suspended", async resume() { this.state = "running"; } };
  await env.resumeSpeechAudio(context);
  await assert.rejects(env.resumeSpeechAudio({ state: "suspended", async resume() {} }), /音频引擎未运行/);
});

test("audio startup times out instead of leaving the listener stuck", async () => {
  let timeout;
  const env = { Error, navigator: {}, setTimeout: callback => { timeout = callback; return 1; }, clearTimeout() {} };
  vm.runInNewContext(compiled, env);
  const pending = env.resumeSpeechAudio({ state: "suspended", resume: () => new Promise(() => {}) });
  timeout();
  await assert.rejects(pending, /音频引擎未能启动/);
});

test("microphone opens without imposing the recognition sample rate on hardware", async () => {
  const stream = {};
  const env = setup(async constraints => {
    assert.equal(constraints.audio.channelCount, 1);
    assert.equal(constraints.audio.echoCancellation, false);
    assert.equal(constraints.audio.noiseSuppression, false);
    assert.equal(constraints.audio.autoGainControl, false);
    assert.equal("sampleRate" in constraints.audio, false);
    return stream;
  });
  assert.equal(await env.openSpeechMicrophone(), stream);
});

test("selected microphone is preserved when audio constraints fall back", async () => {
  let calls = 0;
  const stream = {};
  const env = setup(async constraints => {
    assert.equal(constraints.audio.deviceId.exact, "usb-mic");
    if (++calls === 1) throw Object.assign(new Error("unsupported"), { name: "OverconstrainedError" });
    assert.equal("channelCount" in constraints.audio, false);
    return stream;
  });
  assert.equal(await env.openSpeechMicrophone("usb-mic"), stream);
  assert.equal(calls, 2);
});

test("microphone list excludes output devices and duplicate Windows aliases", async () => {
  const env = setup();
  env.navigator.mediaDevices.enumerateDevices = async () => [
    { kind: "audioinput", deviceId: "default" },
    { kind: "audioinput", deviceId: "communications" },
    { kind: "audiooutput", deviceId: "speaker" },
    { kind: "audioinput", deviceId: "usb-mic" },
  ];
  assert.equal((await env.listSpeechMicrophones()).map(device => device.deviceId).join(), "usb-mic");
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
