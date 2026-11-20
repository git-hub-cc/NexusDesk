import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function setup() {
  const listeners = {};
  class Element {
    constructor(options = {}) { Object.assign(this, options); }
    closest(selector) {
      if (selector.includes("aria-hidden")) return this.hidden ? this : null;
      if (selector.startsWith(".cm-editor")) return this.editor ? this : null;
      return this;
    }
    matches(selector) {
      return selector === ":disabled" ? !!this.disabled : !!this.android;
    }
    getClientRects() { return this.hidden ? [] : [{}]; }
    focus() { document.activeElement = this; }
    blur() { this.blurred = true; document.activeElement = null; }
  }
  class HTMLInputElement extends Element {}
  class HTMLTextAreaElement extends Element {}
  const document = {
    activeElement: null,
    fields: [],
    querySelectorAll() { return this.fields; },
    addEventListener(type, callback) { listeners[type] = callback; },
  };
  const context = {
    Element, HTMLElement: Element, HTMLInputElement, HTMLTextAreaElement, document,
    window: { addEventListener(type, callback) { listeners[type] = callback; } },
    exports: {},
  };
  const source = readFileSync(new URL("../src/utils/focusPolicy.ts", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  context.exports.installFocusPolicy();
  const dispatch = (type, target, options = {}) => {
    const event = {
      target, ...options,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
    };
    listeners[type](event);
    return event;
  };
  return { Element, HTMLInputElement, HTMLTextAreaElement, document, dispatch };
}

test("controls cannot take mouse or script focus while input surfaces remain usable", () => {
  const { Element, HTMLInputElement, HTMLTextAreaElement, document, dispatch } = setup();
  const input = new HTMLInputElement({ type: "text" });
  for (const control of [new Element(), new HTMLInputElement({ type: "checkbox" }),
    new HTMLInputElement({ type: "range" })]) {
    input.focus();
    assert.equal(dispatch("mousedown", control).defaultPrevented, true);
    assert.equal(document.activeElement, input, "toolbar clicks preserve text input focus");
    control.focus();
    assert.equal(dispatch("focus", control).stopped, true);
    assert.equal(control.blurred, true);
  }
  for (const field of [input, new HTMLTextAreaElement(),
    new Element({ isContentEditable: true }), new Element({ android: true })]) {
    assert.equal(dispatch("mousedown", field).defaultPrevented, undefined);
    field.focus();
    assert.equal(dispatch("focus", field).stopped, undefined);
    assert.equal(document.activeElement, field);
  }
});

test("Tab cycles through visible enabled text fields and preserves editor Tab handling", () => {
  const { Element, HTMLInputElement, HTMLTextAreaElement, document, dispatch } = setup();
  const first = new HTMLInputElement({ type: "search" });
  const last = new HTMLTextAreaElement();
  document.fields = [first, new HTMLInputElement({ type: "checkbox" }),
    new HTMLInputElement({ type: "text", disabled: true }),
    new HTMLInputElement({ type: "text", hidden: true }), last];
  dispatch("keydown", new Element(), { key: "Tab" });
  assert.equal(document.activeElement, first);
  dispatch("keydown", first, { key: "Tab" });
  assert.equal(document.activeElement, last);
  dispatch("keydown", last, { key: "Tab" });
  assert.equal(document.activeElement, first);
  dispatch("keydown", first, { key: "Tab", shiftKey: true });
  assert.equal(document.activeElement, last);
  assert.equal(dispatch("keydown", new Element({ editor: true }), { key: "Tab" }).defaultPrevented, undefined);
  document.fields = [];
  assert.equal(dispatch("keydown", new Element(), { key: "Tab" }).defaultPrevented, true);
});
