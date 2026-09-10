import { createHash } from "node:crypto";

import { checkSendGuard, recordSuccessfulSend } from "./rate-limit";
import { readBooleanEnv, readIntegerEnv, sha256 } from "./security";
import { TelegramApiError } from "./telegram";
import { type PhotoInput, sendTelegramPhoto, validatePhotoInput } from "./telegram-photo";

function toolError(message: string, retryAfterSeconds?: number) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    structuredContent: { ok: false, message, retry_after_seconds: retryAfterSeconds }
  };
}

export async function handlePhotoSend(input: PhotoInput) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!botToken || !channelId) {
    return toolError("Telegram is not configured. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID, then redeploy.");
  }
  const validation = validatePhotoInput(input);
  if (!validation.valid) return toolError(validation.message);
  const { photo } = validation;
  const caption = input.caption ?? "";
  const silent = input.silent ?? false;
  const hasSpoiler = input.has_spoiler ?? false;
  const duplicateWindowSeconds = readIntegerEnv("MCP_DUPLICATE_WINDOW_SECONDS", 120, 0, 600);
  const source = photo.kind === "reference"
    ? photo.value
    : createHash("sha256").update(photo.bytes).digest("hex");
  const payloadHash = sha256(JSON.stringify({ method: "sendPhoto", kind: photo.kind, source, caption, silent, hasSpoiler }));
  const now = Date.now();
  const guard = checkSendGuard({
    now, payloadHash, duplicateWindowSeconds,
    maxPerMinute: readIntegerEnv("MCP_MAX_MESSAGES_PER_MINUTE", 5, 1, 30)
  });
  if (!guard.allowed) {
    return toolError(
      guard.reason === "duplicate"
        ? "An identical photo message was sent recently, so this duplicate was blocked."
        : "The local safety rate limit was reached.",
      guard.retryAfterSeconds
    );
  }
  try {
    const message = await sendTelegramPhoto({
      botToken, channelId, photo, caption, silent, hasSpoiler,
      protectContent: readBooleanEnv("TELEGRAM_PROTECT_CONTENT", true)
    });
    recordSuccessfulSend({ now: Date.now(), payloadHash, duplicateWindowSeconds });
    const output = { ok: true, message: "Photo sent to the configured Telegram destination.", ...message };
    return {
      content: [{ type: "text" as const, text: output.message }],
      structuredContent: output
    };
  } catch (error) {
    const apiError = error instanceof TelegramApiError ? error : undefined;
    // Log metadata only: never image bytes, source URLs, captions, tokens, or destination IDs.
    console.error("Telegram Photo MCP send failed", {
      errorCode: apiError?.errorCode, retryAfterSeconds: apiError?.retryAfterSeconds
    });
    return toolError(apiError?.message ?? "Telegram could not send the photo.", apiError?.retryAfterSeconds);
  }
}
