import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/speechPreferences.ts", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function read(value) {
  const context = { exports: {}, settingsStorage: { getItem: () => value } };
  vm.runInNewContext(compiled, context);
  return JSON.parse(JSON.stringify(context.exports.readSpeechPreferences()));
}

test("migrates every Whisper model while preserving supported preferences", () => {
  for (const model of ["tiny", "base", "small", "medium", "sensevoice-small"]) {
    assert.deepEqual(read(JSON.stringify({ model, acceleration: true, language: "zh", filterNoise: false })), {
      model: "sensevoice-small", language: "zh", filterNoise: false,
      minVolume: 0.018, minDurationSeconds: 0.5, minTextLength: 2,
    });
  }
});

test("unsupported languages migrate to automatic detection and Cantonese is supported", () => {
  for (const language of ["fr", "de", "es", "ru", "unknown"]) {
    assert.equal(read(JSON.stringify({ model: "medium", language })).language, "");
  }
  assert.equal(read(JSON.stringify({ language: "yue" })).language, "yue");
});

test("invalid stored values safely use SenseVoice defaults", () => {
  for (const value of [null, "null", "[]", "42", "invalid JSON"]) {
    assert.deepEqual(read(value), {
      model: "sensevoice-small", filterNoise: true, language: "",
      minVolume: 0.018, minDurationSeconds: 0.5, minTextLength: 2,
    });
  }
});

test("clamps recognition thresholds and preserves valid custom values", () => {
  assert.deepEqual(read(JSON.stringify({ minVolume: 0.032, minDurationSeconds: 1.2, minTextLength: 4 })), {
    model: "sensevoice-small", filterNoise: true, language: "",
    minVolume: 0.032, minDurationSeconds: 1.2, minTextLength: 4,
  });
  assert.equal(read(JSON.stringify({ minVolume: 2 })).minVolume, 0.1);
});
