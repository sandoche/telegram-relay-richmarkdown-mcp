const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const path = require("node:path");
const Module = require("node:module");
const { NextRequest } = require("next/server");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

// Resolve the same @/ alias as Next.js for the compiled route. No handler mocks:
// requests pass through the real auth gate, mcp-handler, and MCP SDK.
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...args) {
  return resolve.call(this, name.startsWith("@/")
    ? path.join(__dirname, ".compiled", name.slice(2)) : name, ...args);
};
const { POST } = require("./.compiled/app/[accessKey]/[transport]/route.js");
Module._resolveFilename = resolve;

const key = "test_access_key_" + "x".repeat(32);
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const originalSetInterval = global.setInterval;
let networkCalls;

beforeEach(() => {
  process.env.MCP_ACCESS_TOKEN = key;
  process.env.TELEGRAM_BOT_TOKEN = "test_bot_token_DO_NOT_EXPOSE";
  process.env.TELEGRAM_CHANNEL_ID = "@test_destination_DO_NOT_EXPOSE";
  global.telegramRichMcpGuardState = undefined;
  networkCalls = 0;
  global.fetch = async () => { networkCalls++; throw new Error("Unexpected network request"); };
  // mcp-handler owns a recurring idle-session cleanup timer. Keep it functional
  // without letting that background housekeeping keep Node's test process alive.
  global.setInterval = (...args) => originalSetInterval(...args).unref();
});
afterEach(() => {
  global.fetch = originalFetch;
  global.setInterval = originalSetInterval;
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
  global.telegramRichMcpGuardState = undefined;
  assert.equal(networkCalls, 0, "status must never contact Telegram or any external service");
});

async function routeFetch(url, init) {
  const request = new NextRequest(url, init);
  const [, accessKey, transport] = new URL(request.url).pathname.split("/");
  return POST(request, { params: Promise.resolve({ accessKey, transport }) });
}
async function connect(t) {
  const client = new Client({ name: "status-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://localhost/${key}/mcp`), { fetch: routeFetch }
  ));
  return client;
}
function assertSafe(result, configured) {
  assert.equal(result.isError, undefined);
  assert.deepEqual(Object.keys(result.structuredContent).sort(),
    ["ok", "status_version", "telegram_configured", "telegram_api_checked", "message"].sort());
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.status_version, 1);
  assert.equal(result.structuredContent.telegram_configured, configured);
  assert.equal(result.structuredContent.telegram_api_checked, false);
  assert.equal(result.content[0].text, result.structuredContent.message);
  for (const value of [key, "test_bot_token_DO_NOT_EXPOSE", "@test_destination_DO_NOT_EXPOSE"])
    assert.equal(JSON.stringify(result).includes(value), false);
}

test("authenticated tools/list preserves send tools and exposes read-only status metadata", async (t) => {
  const client = await connect(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "get_telegram_relay_status", "send_photo_to_telegram_channel", "send_rich_markdown_to_telegram_channel"
  ]);
  const status = tools.find(tool => tool.name === "get_telegram_relay_status");
  assert.deepEqual(status.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false
  });
  assert.deepEqual(status.inputSchema.properties, {});
  for (const tool of tools.filter(tool => tool.name.startsWith("send_"))) {
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.idempotentHint, false);
  }
  assertSafe(await client.callTool({ name: status.name, arguments: {} }), true);
  assert.equal(global.telegramRichMcpGuardState, undefined);
});

test("status reports missing/blank configuration without leaking values or claiming delivery", async (t) => {
  const client = await connect(t);
  for (const [bot, destination] of [[undefined, undefined], [undefined, "channel"], ["bot", undefined], ["", "channel"], ["bot", "   "]]) {
    if (bot === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = bot;
    if (destination === undefined) delete process.env.TELEGRAM_CHANNEL_ID;
    else process.env.TELEGRAM_CHANNEL_ID = destination;
    assertSafe(await client.callTool({ name: "get_telegram_relay_status", arguments: {} }), false);
  }
});

test("repeated status calls ignore exhausted send limits and leave guards and environment unchanged", async (t) => {
  const client = await connect(t);
  const state = { sendTimestamps: Array(30).fill(Date.now()), duplicateHashes: new Map([["existing", Date.now()]]) };
  global.telegramRichMcpGuardState = state;
  const snapshot = structuredClone(state);
  const env = { ...process.env };
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    client.callTool({ name: "get_telegram_relay_status", arguments: {} })));
  results.forEach(result => { assertSafe(result, true); assert.deepEqual(result, results[0]); });
  assert.equal(global.telegramRichMcpGuardState, state);
  assert.deepEqual(state, snapshot);
  assert.deepEqual({ ...process.env }, env);
});

test("unexpected arguments cannot turn status into a send or select a destination", async (t) => {
  const client = await connect(t);
  const result = await client.callTool({ name: "get_telegram_relay_status", arguments: { send: true, chat_id: "other" } });
  assertSafe(result, true);
  assert.equal(global.telegramRichMcpGuardState, undefined);
});

test("status stays behind the existing access-token and transport checks", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_telegram_relay_status", arguments: {} } });
  const init = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body };
  for (const url of [`http://localhost/wrong/mcp`, `http://localhost/${key}/sse`]) {
    const response = await routeFetch(url, init);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not found");
  }
  for (const token of [undefined, "weak"]) {
    if (token === undefined) delete process.env.MCP_ACCESS_TOKEN;
    else process.env.MCP_ACCESS_TOKEN = token;
    const response = await routeFetch(`http://localhost/${key}/mcp`, init);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "server_not_configured" });
  }
});
