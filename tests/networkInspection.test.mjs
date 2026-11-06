import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync(
  new URL("../src/lib/networkInspection.ts", import.meta.url),
  "utf8",
);
const context = vm.createContext({ exports: {} });
vm.runInContext(
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText,
  context,
);
const { inspectMessage, readableItems, responseItems } = context.exports;
const stream = (body) =>
  "200 OK\r\ncontent-type: text/event-stream\r\nx-request-id: abc:123\r\n\r\n" +
  body;
const event = (type, value) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;

test("request inspection separates headers, preserves values and reads role-based input", () => {
  const body = {
    model: "example",
    input: [
      {
        role: "user",
        type: "message",
        content: [{ type: "input_text", text: "你好\nC:\\test" }],
      },
      {
        role: "developer",
        type: "additional_tools",
        tools: [{ name: "example" }],
      },
    ],
  };
  const parsed = inspectMessage(
    "POST https://example.com/v1/responses\nx-meta: a:b\nx-meta: c\n\n" +
      JSON.stringify(body),
  );
  assert.equal(parsed.headers[0].value, "a:b");
  assert.equal(parsed.headers.length, 2);
  assert.equal(parsed.json.model, "example");
  const items = readableItems(parsed.json.input);
  assert.equal(items[0].text, "你好\nC:\\test");
  assert.equal(items[1].role, "developer");
  assert.equal(items[1].value.tools[0].name, "example");
});

test("SSE final output and usage supersede deltas without duplicate text", () => {
  const parsed = inspectMessage(
    stream(
      event("response.created", {
        response: { id: "r1", model: "example", output: [] },
      }) +
        event("response.output_text.delta", { delta: "Hi" }) +
        event("response.output_text.delta", { delta: "!" }) +
        event("response.completed", {
          response: {
            status: "completed",
            output: [{ role: "assistant", content: [{ text: "Hi!" }] }],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        }),
    ),
  );
  assert.equal(parsed.events.length, 4);
  assert.equal(parsed.response.model, "example");
  assert.equal(parsed.response.status, "completed");
  assert.equal(parsed.usage.total_tokens, 12);
  assert.equal(responseItems(parsed)[0].text, "Hi!");
});

test("live stream groups concurrent outputs and replaces deltas with done text", () => {
  const parsed = inspectMessage(
    stream(
      event("response.output_text.delta", { item_id: "a", delta: "Hel" }) +
        event("response.output_text.delta", { item_id: "b", delta: "Other" }) +
        event("response.output_text.delta", { item_id: "a", delta: "lo" }) +
        event("response.output_text.done", { item_id: "a", text: "Hello!" }),
    ),
  );
  const items = responseItems(parsed);
  assert.equal(items.length, 2);
  assert.equal(items[0].text, "Hello!");
  assert.equal(items[1].text, "Other");
});

test("multiline SSE data, comments, DONE and partial trailing frames are retained", () => {
  const parsed = inspectMessage(
    stream(
      ': keepalive\n\nevent: custom\ndata: {"a":\ndata: 1}\n\ndata: [DONE]\n\nevent: response.output_text.delta\ndata: {"delta":',
    ),
  );
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.events[0].value.a, 1);
  assert.equal(parsed.events[1].type, "done");
  assert.equal(parsed.events[2].incomplete, true);
  assert.equal(parsed.events[2].data, '{"delta":');
});

test("completed output items do not hide other items that are still streaming", () => {
  const parsed = inspectMessage(
    stream(
      event("response.output_text.delta", { item_id: "a", delta: "first" }) +
        event("response.output_item.done", {
          item: { id: "a", role: "assistant", content: [{ text: "first" }] },
        }) +
        event("response.output_text.delta", { item_id: "b", delta: "second" }),
    ),
  );
  assert.equal(
    responseItems(parsed)
      .map((item) => item.text)
      .join("|"),
    "first|second",
  );
});

test("serialized messages, invalid JSON and empty responses preserve their readable body", () => {
  const parsed = inspectMessage(
    JSON.stringify(
      '200 OK\r\ncontent-type: application/json\r\n\r\n{"output":[]}',
    ),
  );
  assert.equal(parsed.headers[0].name, "content-type");
  assert.equal(parsed.json.output.length, 0);
  for (const body of ["", "plain text", '{"broken":']) {
    assert.equal(inspectMessage(body).body, body);
  }
});
