const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const path = require("node:path");
const Module = require("node:module");
const { NextRequest } = require("next/server");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...args) {
  return resolve.call(this, name.startsWith("@/")
    ? path.join(__dirname, ".compiled", name.slice(2)) : name, ...args);
};
const { POST: mcp } = require("./.compiled/app/[accessKey]/[transport]/route.js");
const { POST: webhook } = require("./.compiled/app/telegram-webhook/route.js");
Module._resolveFilename = resolve;

const key = "access_key_" + "x".repeat(32);
const secret = "webhook_secret_" + "y".repeat(32);
const chatId = -1001234567890;
const botToken = "1234567890:test-token";
const redisUrl = "https://test.upstash.io";
const redisToken = "test-redis-token";
const date = 1234567890;
let calls;
let responses;

beforeEach((t) => {
  Object.assign(process.env, {
    MCP_ACCESS_TOKEN: key,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_CHANNEL_ID: String(chatId),
    TELEGRAM_WEBHOOK_SECRET: secret,
    UPSTASH_REDIS_REST_URL: redisUrl,
    UPSTASH_REDIS_REST_TOKEN: redisToken,
    MCP_MAX_MESSAGES_PER_MINUTE: "5",
    MCP_DUPLICATE_WINDOW_SECONDS: "120"
  });
  global.telegramRichMcpGuardState = undefined;
  calls = [];
  responses = [];
  t.mock.method(global, "fetch", async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return responses.shift() ?? new Response(null, { status: 500 });
  });
  const setInterval = global.setInterval;
  t.mock.method(global, "setInterval", (...args) => setInterval(...args).unref());
  t.mock.method(console, "error", () => {});
});
const originalEnv = { ...process.env };
afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
  global.telegramRichMcpGuardState = undefined;
  assert.equal(responses.length, 0, "all queued upstream responses must be consumed");
});

async function connect(t) {
  const client = new Client({ name: "topic-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost/${key}/mcp`), {
    fetch: (url, init) => mcp(new NextRequest(url, init), {
      params: Promise.resolve({ accessKey: key, transport: "mcp" })
    })
  }));
  return client;
}

function receive(update, provided = secret) {
  return webhook(new Request("http://localhost/telegram-webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": provided, "content-type": "application/json" },
    body: JSON.stringify(update)
  }));
}

function redis(result) {
  responses.push(Response.json({ result }));
}

function telegram(result) {
  responses.push(Response.json({ ok: true, result }));
}

test("creates a topic in the fixed chat, records the returned title, and lists and reads the archive", async (t) => {
  const client = await connect(t);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const { tools } = await client.listTools();
  for (const name of ["list_telegram_topics", "read_telegram_topic"]) {
    assert.equal(tools.find((tool) => tool.name === name).annotations.readOnlyHint, true);
  }
  assert.equal(tools.find((tool) => tool.name === "create_telegram_topic").annotations.idempotentHint, false);

  const topic = { message_thread_id: 22, name: "Alerts" };
  telegram({ ...topic, icon_color: 42 });
  redis(1);
  const created = await call("create_telegram_topic", { name: " Alerts ", chat_id: "other-chat" });
  assert.deepEqual(created.structuredContent, { ok: true, message: "Telegram topic created.", topic, topic_recorded: true });
  assert.deepEqual(calls[0].body, { name: "Alerts", chat_id: String(chatId) });
  assert.ok(calls[0].url.endsWith("/createForumTopic"));
  assert.deepEqual(calls[1].body.slice(5, 9), [22, "Alerts", 22, ""]);
  assert.deepEqual(calls[1].headers.authorization, `Bearer ${redisToken}`);
  assert.equal((await call("create_telegram_topic", { name: "Alerts" })).isError, true);
  assert.equal(calls.length, 2);

  const key = calls[1].body[3];
  const savedTopic = JSON.stringify({ name: "Alerts", eventId: 22 });
  redis(["22", savedTopic, "15", '{"eventId":0}']);
  const listed = await call("list_telegram_topics", {});
  assert.deepEqual(listed.structuredContent.topics, [topic, { message_thread_id: 15, name: null }]);
  assert.deepEqual(calls[2].body, ["HGETALL", key]);

  const first = { message_id: 25, date, kind: "text", text: "Latest" };
  const older = { message_id: 24, date, kind: "photo", text: "Photo caption" };
  redis(savedTopic);
  redis([JSON.stringify(first), JSON.stringify(older)]);
  const read = await call("read_telegram_topic", { message_thread_id: 22, limit: 1 });
  assert.deepEqual(read.structuredContent.messages, [first]);
  assert.equal(read.structuredContent.next_before_message_id, 25);
  redis(savedTopic);
  redis([JSON.stringify(older)]);
  const next = await call("read_telegram_topic", { message_thread_id: 22, limit: 1, before_message_id: 25 });
  assert.deepEqual(next.structuredContent.messages, [older]);
  assert.equal(next.structuredContent.next_before_message_id, undefined);
  assert.deepEqual(calls.at(-1).body, ["ZREVRANGEBYSCORE", `${key}:22`, "(25", "-inf", "LIMIT", 0, 2]);

  redis(null);
  const unknown = await call("read_telegram_topic", { message_thread_id: 99 });
  assert.equal(unknown.isError, true);
  assert.match(unknown.structuredContent.message, /not been observed/);
});

test("routes Rich Markdown and photos by topic ID without overriding the chat or retrying on archive failure", async (t) => {
  const client = await connect(t);
  const rich = (args) => client.callTool({ name: "send_rich_markdown_to_telegram_channel", arguments: { markdown: "Hello", ...args } });

  telegram({ message_id: 31, date });
  redis(1);
  const first = await rich({ message_thread_id: 20, chat_id: "other-chat" });
  assert.equal(first.structuredContent.history_recorded, true);
  assert.equal(first.structuredContent.message_thread_id, 20);
  assert.equal(calls[0].body.chat_id, String(chatId));
  assert.equal(calls[0].body.message_thread_id, 20);
  assert.deepEqual(JSON.parse(calls[1].body[8]), {
    message_id: 31, date, kind: "rich_markdown", sender: "Gateway", text: "Hello"
  });

  telegram({ message_id: 32, date });
  responses.push(new Response(null, { status: 503 }));
  const second = await rich({ message_thread_id: 21 });
  assert.equal(second.structuredContent.ok, true);
  assert.equal(second.structuredContent.history_recorded, false);
  assert.equal(calls[2].body.message_thread_id, 21);
  assert.equal((await rich({ message_thread_id: 21 })).isError, true);
  assert.equal((await rich({ message_thread_id: 0 })).isError, true);
  assert.equal(calls.length, 4);

  telegram({ message_id: 33, date });
  const defaultSend = await rich({});
  assert.equal(defaultSend.structuredContent.ok, true);
  assert.equal(defaultSend.structuredContent.history_recorded, undefined);
  assert.equal(Object.hasOwn(calls[4].body, "message_thread_id"), false);
  assert.equal(calls.length, 5);

  telegram({ message_id: 34, date });
  redis(1);
  const photo = await client.callTool({
    name: "send_photo_to_telegram_channel", arguments: { photo: "file_id", caption: "A photo", message_thread_id: 20 }
  });
  assert.equal(photo.structuredContent.history_recorded, true);
  assert.equal(calls[5].body.message_thread_id, 20);
  assert.equal(JSON.parse(calls[6].body[8]).kind, "photo");
});

test("topic creation and known-ID sends work without Redis while reads return setup guidance", async (t) => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  const client = await connect(t);
  const list = await client.callTool({ name: "list_telegram_topics", arguments: {} });
  assert.equal(list.isError, true);
  assert.match(list.structuredContent.message, /storage is not configured/);
  assert.equal(calls.length, 0);

  telegram({ message_thread_id: 22, name: "Alerts" });
  const create = await client.callTool({ name: "create_telegram_topic", arguments: { name: "Alerts" } });
  assert.equal(create.structuredContent.topic_recorded, false);
  telegram({ message_id: 30, date });
  const sent = await client.callTool({
    name: "send_rich_markdown_to_telegram_channel", arguments: { markdown: "Hello", message_thread_id: 22 }
  });
  assert.equal(sent.structuredContent.history_recorded, false);
  assert.equal(calls[1].body.message_thread_id, 22);
  assert.equal(calls.length, 2);
});

test("webhook authenticates updates and only records topic activity from the configured chat", async () => {
  const message = {
    chat: { id: chatId, type: "supergroup" }, date, message_id: 47, is_topic_message: true, message_thread_id: 22,
    from: { first_name: "Alice", last_name: "Example" }, text: "Hello"
  };
  assert.equal((await receive({ message }, key)).status, 404);
  assert.equal((await receive({ message: { ...message, chat: { ...message.chat, id: 999 } } })).status, 204);
  assert.equal((await receive({ message: { ...message, is_topic_message: undefined } })).status, 204);
  assert.equal((await receive({ message: { ...message, message_thread_id: 1 } })).status, 204);
  assert.equal((await receive({ guest_message: message })).status, 204);
  assert.equal(calls.length, 0);

  redis(1);
  assert.equal((await receive({ message })).status, 204);
  assert.deepEqual(JSON.parse(calls[0].body[8]), {
    message_id: 47, date, kind: "text", sender: "Alice Example", text: "Hello"
  });
  redis(1);
  assert.equal((await receive({ message: { ...message, forum_topic_edited: { name: "Renamed" } } })).status, 204);
  assert.deepEqual(calls[1].body.slice(5, 9), [22, "Renamed", 47, ""]);

  redis(1);
  const text = "😀".repeat(8_001);
  assert.equal((await receive({ update_id: 101, edited_message: { ...message, text, edit_date: date + 1 } })).status, 204);
  const edited = JSON.parse(calls[2].body[8]);
  assert.equal(edited.edited_at, date + 1);
  assert.equal(edited.text, "😀".repeat(8_000));
  assert.equal(edited.truncated, true);
  assert.deepEqual(calls[2].body.slice(10, 12), [date + 1, 101]);

  assert.equal((await receive({ message })).status, 503, "Telegram can retry a transient storage failure");
});
