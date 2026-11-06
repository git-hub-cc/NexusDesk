import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/curlToHttp.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
new Function("exports", code)(exports);
const { curlToHttp } = exports;

test("converts multiline curl with headers and JSON body", () => {
  const curl = `curl https://api.chatgpt-code.com/v1/chat/completions \\
  -H 'Authorization: Bearer token' \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-6.1-terra",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`;
  assert.equal(curlToHttp(curl), `POST https://api.chatgpt-code.com/v1/chat/completions
Authorization: Bearer token
Content-Type: application/json

{
    "model": "gpt-6.1-terra",
    "messages": [{"role": "user", "content": "Hello"}]
  }`);
});

test("preserves shell variable placeholders in converted requests", () => {
  assert.equal(curlToHttp('curl -H "x-api-key: $NEW_API_KEY" https://example.com'), 'GET https://example.com\nx-api-key: $NEW_API_KEY');
  assert.equal(curlToHttp('curl "https://example.com/${PATH}"'), 'GET https://example.com/${PATH}');
});

test("preserves commands requiring shell command substitution", () => {
  for (const input of [
    'curl https://example.com -d "$(command)"',
    'curl https://example.com -d "`command`"',
  ]) assert.equal(curlToHttp(input), null);
  assert.equal(curlToHttp("curl https://example.com -d '$TOKEN'"), "POST https://example.com\nContent-Type: application/x-www-form-urlencoded\n\n$TOKEN");
  assert.equal(curlToHttp('curl https://example.com -d "\\$TOKEN"'), "POST https://example.com\nContent-Type: application/x-www-form-urlencoded\n\n$TOKEN");
});

test("preserves newlines in direct data arguments", () => {
  for (const option of ["-d", "--data", "--data-raw", "--data-binary"]) {
    assert.equal(curlToHttp(`curl https://example.com ${option} 'a\r\nb'`), "POST https://example.com\nContent-Type: application/x-www-form-urlencoded\n\na\r\nb");
  }
});

test("handles methods, repeated data and default content type", () => {
  assert.equal(curlToHttp("curl --request=PUT --url https://example.com -d a=1 --data-raw b=2"), "PUT https://example.com\nContent-Type: application/x-www-form-urlencoded\n\na=1&b=2");
  assert.equal(curlToHttp("curl 'https://example.com/a?x=1&y=2'"), "GET https://example.com/a?x=1&y=2");
});

test("leaves unsupported or malformed commands untouched", () => {
  for (const input of ["plain text", "curl https://example.com -F file=@a", "curl https://example.com -d @file", "curl https://example.com --compressed", "curl 'https://example.com", "curl https://a https://b"]) {
    assert.equal(curlToHttp(input), null);
  }
});
