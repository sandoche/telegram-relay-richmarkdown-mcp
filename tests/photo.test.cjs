const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");
const { validatePhotoInput, sendTelegramPhoto, MAX_PHOTO_UPLOAD_BYTES } = require("./.compiled/lib/telegram-photo.js");
const { handlePhotoSend } = require("./.compiled/lib/photo-tool.js");
const { recordSuccessfulSend } = require("./.compiled/lib/rate-limit.js");
const { sendTelegramRichMarkdown, validateRichMarkdown, TelegramApiError } = require("./.compiled/lib/telegram.js");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3x8AAAAASUVORK5CYII=";
const dataUrl = `data:image/png;base64,${PNG}`;
const options = {
  botToken: "123:test-token", channelId: "-1001234567890",
  photo: { kind: "reference", value: "https://example.com/photo.png" },
  caption: "Caption", silent: false, hasSpoiler: false, protectContent: true
};
const originalFetch = global.fetch;
const originalEnv = { ...process.env };
const originalError = console.error;
let calls;
let logs;
function success() {
  return Response.json({ ok: true, result: { message_id: 42, date: 1234567890,
    photo: [{ file_id: "large_id", width: 800, height: 600 }, { file_id: "small_id", width: 80, height: 60 }] } });
}
beforeEach(() => {
  calls = [];
  logs = [];
  global.telegramRichMcpGuardState = undefined;
  process.env.TELEGRAM_BOT_TOKEN = options.botToken;
  process.env.TELEGRAM_CHANNEL_ID = options.channelId;
  for (const name of ["TELEGRAM_PROTECT_CONTENT", "MCP_MAX_MESSAGES_PER_MINUTE", "MCP_DUPLICATE_WINDOW_SECONDS"]) delete process.env[name];
  global.fetch = async (...args) => { calls.push(args); return success(); };
  console.error = (...args) => logs.push(args);
});
afterEach(() => {
  global.fetch = originalFetch;
  console.error = originalError;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  global.telegramRichMcpGuardState = undefined;
});

test("accepts and normalizes HTTPS URLs and reuses Telegram file IDs", () => {
  assert.equal(validatePhotoInput({ photo: "https://EXAMPLE.com:443/photo.png?q=1" }).photo.value, "https://example.com/photo.png?q=1");
  assert.equal(validatePhotoInput({ photo: "AgACAgIAAxkBAAIB_123-abc" }).valid, true);
});
test("rejects absent, ambiguous, empty, or incorrectly typed sources", () => {
  for (const input of [{}, { photo: "" }, { photo: null }, { image_data_url: null }, { photo: "id", image_data_url: dataUrl }]) {
    assert.equal(validatePhotoInput(input).valid, false);
  }
});
test("rejects unsafe URLs, local paths, sandbox links, and attach references", () => {
  for (const photo of ["http://example.com/photo.jpg", "javascript:alert(1)", "file:///tmp/a.png", "sandbox:/mnt/data/a.png",
    "/tmp/a.png", "C:\\photo.jpg", "attach://photo", "https://user:pass@example.com/a.png", "https://example.com:8443/a.png",
    "https://localhost/a.png", "https://a.local/a.png", "https://a.internal/a.png", "https://a.lan/a.png", "https://a.home/a.png",
    "https://127.0.0.1/a.png", "https://2130706433/a.png", "https://0x7f000001/a.png", "https://169.254.169.254/latest/meta-data",
    "https://8.8.8.8/a.png", "https://[::1]/a.png", "https://[::ffff:127.0.0.1]/a.png", "https://example.com/a.png#secret",
    "https://example.com/\nphoto.png", "https:\\example.com\\a.png", "data:image/png;base64," + PNG]) {
    assert.equal(validatePhotoInput({ photo }).valid, false, photo);
  }
});
test("limits reference length and validates Unicode captions without rejecting emojis", () => {
  assert.equal(validatePhotoInput({ photo: "https://example.com/" + "a".repeat(4096) }).valid, false);
  assert.equal(validatePhotoInput({ photo: "id", caption: "😀".repeat(1024) }).valid, true);
  assert.equal(validatePhotoInput({ photo: "id", caption: "😀".repeat(1025) }).valid, false);
  assert.equal(validatePhotoInput({ photo: "id", caption: "bad\u0000caption" }).valid, false);
});
test("accepts PNG bytes and JPEG signatures as uploads", () => {
  const png = validatePhotoInput({ image_data_url: dataUrl });
  assert.equal(png.valid, true);
  assert.equal(png.photo.filename, "photo.png");
  assert.deepEqual(Buffer.from(png.photo.bytes), Buffer.from(PNG, "base64"));
  const jpeg = validatePhotoInput({ image_data_url: "data:image/jpeg;base64,/9j/AA==" });
  assert.equal(jpeg.valid, true); // Signature validation only; Telegram decodes the actual image.
  assert.equal(jpeg.photo.mimeType, "image/jpeg");
});
test("rejects invalid/noncanonical base64, unsupported MIME types, and signature mismatches", () => {
  for (const value of ["data:image/png;base64,", "data:image/png;base64,!!!!", "data:image/png;base64,A===",
    "data:image/png;base64,AA", "data:image/png;base64,AB==", "data:image/png;base64,AAAA",
    "data:image/jpeg;base64," + PNG, "data:image/svg+xml;base64,AAAA", "data:text/html;base64,AAAA",
    dataUrl + "\n", "data:image/png;base64," + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")]) {
    assert.equal(validatePhotoInput({ image_data_url: value }).valid, false);
  }
});
test("enforces the 2 MiB decoded upload boundary before sending", () => {
  const bytes = Buffer.alloc(MAX_PHOTO_UPLOAD_BYTES);
  Buffer.from(PNG, "base64").copy(bytes);
  assert.equal(validatePhotoInput({ image_data_url: `data:image/png;base64,${bytes.toString("base64")}` }).valid, true);
  const oversized = Buffer.concat([bytes, Buffer.from([0])]);
  assert.equal(validatePhotoInput({ image_data_url: `data:image/png;base64,${oversized.toString("base64")}` }).valid, false);
});
test("sends URL photos only to Telegram using JSON with literal token colon", async () => {
  const result = await sendTelegramPhoto(options);
  assert.deepEqual(result, { message_id: 42, date: 1234567890, file_id: "large_id" });
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, "https://api.telegram.org/bot123:test-token/sendPhoto");
  assert.equal(init.method, "POST");
  assert.equal(init.cache, "no-store");
  assert.equal(init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), { chat_id: options.channelId, photo: options.photo.value,
    caption: "Caption", disable_notification: false, has_spoiler: false, protect_content: true });
  assert.equal(init.signal.aborted, false);
});
test("uploads real multipart PNG bytes without manually setting the boundary", async () => {
  const photo = validatePhotoInput({ image_data_url: dataUrl }).photo;
  await sendTelegramPhoto({ ...options, photo, silent: true, hasSpoiler: true });
  const init = calls[0][1];
  assert.ok(init.body instanceof FormData);
  assert.equal(init.headers["content-type"], undefined);
  assert.equal(init.body.get("disable_notification"), "true");
  assert.equal(init.body.get("has_spoiler"), "true");
  assert.equal(init.body.get("protect_content"), "true");
  assert.equal(init.body.get("chat_id"), options.channelId);
  const file = init.body.get("photo");
  assert.equal(file.type, "image/png");
  assert.equal(file.name, "photo.png");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(PNG, "base64"));
});
test("preserves Telegram retry_after without leaking its error description", async () => {
  global.fetch = async () => Response.json({ ok: false, error_code: 429,
    description: "secret URL https://example.com/a.png?token=hidden", parameters: { retry_after: 17 } }, { status: 429 });
  await assert.rejects(sendTelegramPhoto(options), (error) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.errorCode, 429);
    assert.equal(error.retryAfterSeconds, 17);
    assert.doesNotMatch(error.message, /secret|hidden|example.com/);
    return true;
  });
});
for (const code of [400, 401, 403, 500]) {
  test(`returns a safe error for Telegram ${code}`, async () => {
    global.fetch = async () => Response.json({ ok: false, error_code: code, description: options.botToken }, { status: code });
    await assert.rejects(sendTelegramPhoto(options), (error) => error.errorCode === code && !error.message.includes(options.botToken));
  });
}
test("rejects malformed Telegram JSON, envelopes, and success results", async () => {
  const responses = [() => new Response("not JSON", { status: 502 }),
    () => Response.json(null), () => Response.json([]), () => Response.json({}),
    () => Response.json({ ok: "true" }), () => Response.json({ ok: true, result: {} }),
    () => Response.json({ ok: true, result: { message_id: "42", date: 0 } })];
  for (const response of responses) {
    global.fetch = async () => response();
    await assert.rejects(sendTelegramPhoto(options), /invalid photo/);
  }
});
test("does not retry network failures or leak raw network errors", async () => {
  global.fetch = async () => { calls.push(1); throw new Error(options.botToken); };
  await assert.rejects(sendTelegramPhoto(options), /delivery is unknown/);
  assert.equal(calls.length, 1);
});
test("times out once and warns that delivery is unknown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  global.fetch = async (_url, init) => {
    calls.push(1);
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  };
  const pending = assert.rejects(sendTelegramPhoto(options), /timed out; delivery is unknown/);
  t.mock.timers.tick(30_000);
  await pending;
  assert.equal(calls.length, 1);
});
test("reports a timeout during response-body parsing as unknown delivery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  global.fetch = async (_url, init) => ({ ok: true, status: 200,
    json: () => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })) });
  const pending = assert.rejects(sendTelegramPhoto(options), /timed out; delivery is unknown/);
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  await pending;
});
test("tool blocks invalid input and missing environment without making a request", async () => {
  assert.equal((await handlePhotoSend({})).isError, true);
  delete process.env.TELEGRAM_BOT_TOKEN;
  assert.equal((await handlePhotoSend({ photo: "id" })).isError, true);
  assert.equal(calls.length, 0);
});
test("tool uses the configured destination, ignores destination overrides, and returns a reusable ID", async () => {
  const result = await handlePhotoSend({ photo: "id", chat_id: "attacker", caption: "**plain text**" });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.file_id, "large_id");
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.chat_id, options.channelId);
  assert.equal(body.caption, "**plain text**");
  assert.equal(body.parse_mode, undefined);
  assert.equal(body.protect_content, true);
});
test("tool honors silent/spoiler and the server's content-protection setting", async () => {
  process.env.TELEGRAM_PROTECT_CONTENT = "false";
  await handlePhotoSend({ photo: "id", silent: true, has_spoiler: true });
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.disable_notification, true);
  assert.equal(body.has_spoiler, true);
  assert.equal(body.protect_content, false);
});
test("tool blocks duplicate photos with normalized defaults and URL normalization", async () => {
  assert.equal((await handlePhotoSend({ photo: "https://EXAMPLE.com:443/a.png" })).structuredContent.ok, true);
  const duplicate = await handlePhotoSend({ photo: "https://example.com/a.png", silent: false, caption: "", has_spoiler: false });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.structuredContent.message, /duplicate/);
  assert.equal(calls.length, 1);
});
test("tool deduplicates uploads using image bytes", async () => {
  assert.equal((await handlePhotoSend({ image_data_url: dataUrl })).structuredContent.ok, true);
  assert.equal((await handlePhotoSend({ image_data_url: dataUrl })).isError, true);
  assert.equal(calls.length, 1);
});
test("photos share the existing rich-text rate budget", async () => {
  process.env.MCP_MAX_MESSAGES_PER_MINUTE = "1";
  recordSuccessfulSend({ now: Date.now(), payloadHash: "existing-rich-message", duplicateWindowSeconds: 120 });
  const result = await handlePhotoSend({ photo: "id" });
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.message, /rate limit/);
  assert.equal(calls.length, 0);
});
test("failed sends are not recorded as successful duplicates and logs contain metadata only", async () => {
  global.fetch = async () => Response.json({ ok: false, error_code: 400, description: "SECRET_CAPTION SECRET_URL" }, { status: 400 });
  const result = await handlePhotoSend({ photo: "id", caption: "SECRET_CAPTION" });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify({ result, logs }), /SECRET_CAPTION|SECRET_URL|123:test-token/);
  global.fetch = async (...args) => { calls.push(args); return success(); };
  assert.equal((await handlePhotoSend({ photo: "id", caption: "SECRET_CAPTION" })).structuredContent.ok, true);
});
test("disabling the duplicate window still works", async () => {
  process.env.MCP_DUPLICATE_WINDOW_SECONDS = "0";
  assert.equal((await handlePhotoSend({ photo: "id" })).structuredContent.ok, true);
  assert.equal((await handlePhotoSend({ photo: "id" })).structuredContent.ok, true);
  assert.equal(calls.length, 2);
});
test("rich markdown validation keeps blocking embedded images and allowing text formatting", () => {
  assert.equal(validateRichMarkdown("# Header\n\n**Bold**\n\n|a|b|\n|-|-|\n|1|2|").valid, true);
  assert.equal(validateRichMarkdown("![image](https://example.com/a.png)").valid, false);
  assert.equal(validateRichMarkdown('<img src="https://example.com/a.png">').valid, false);
  assert.equal(validateRichMarkdown("![emoji](tg://emoji?id=123)").valid, true);
});
test("rich markdown continues to use sendRichMessage with unchanged options", async () => {
  await sendTelegramRichMarkdown({ botToken: options.botToken, channelId: options.channelId,
    markdown: "# Status", silent: true, isRtl: true, protectContent: true, skipEntityDetection: false });
  assert.equal(calls[0][0], "https://api.telegram.org/bot123:test-token/sendRichMessage");
  assert.deepEqual(JSON.parse(calls[0][1].body), { chat_id: options.channelId,
    rich_message: { markdown: "# Status", is_rtl: true, skip_entity_detection: false },
    disable_notification: true, protect_content: true });
});
