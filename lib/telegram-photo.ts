import { isIP } from "node:net";

import { TelegramApiError } from "./telegram";

export const MAX_PHOTO_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_PHOTO_DATA_URL_LENGTH = 4 * Math.ceil(MAX_PHOTO_UPLOAD_BYTES / 3) + 32;
const MAX_PHOTO_REFERENCE_LENGTH = 4096;
const PHOTO_REQUEST_TIMEOUT_MS = 30_000;

export type PhotoInput = {
  photo?: string;
  image_data_url?: string;
  caption?: string;
  silent?: boolean;
  has_spoiler?: boolean;
};

export type PreparedPhoto =
  | { kind: "reference"; value: string }
  | { kind: "upload"; bytes: Uint8Array; mimeType: "image/png" | "image/jpeg"; filename: string };

export type PhotoValidation =
  | { valid: true; photo: PreparedPhoto }
  | { valid: false; message: string };

function invalid(message: string): PhotoValidation {
  return { valid: false, message };
}

export function validatePhotoInput(input: PhotoInput): PhotoValidation {
  if ((input.photo !== undefined) === (input.image_data_url !== undefined)) {
    return invalid("Provide exactly one of photo (HTTPS URL or Telegram file_id) and image_data_url (PNG/JPEG upload).");
  }
  if (input.caption !== undefined &&
      (typeof input.caption !== "string" || Array.from(input.caption).length > 1024 || input.caption.includes("\u0000"))) {
    return invalid("The plain-text caption must contain at most 1024 characters and no null characters.");
  }

  if (input.image_data_url !== undefined) {
    const value = input.image_data_url;
    if (typeof value !== "string" || value.length > MAX_PHOTO_DATA_URL_LENGTH) {
      return invalid("The PNG/JPEG upload exceeds the 2 MiB decoded-size limit.");
    }
    const prefix = /^data:image\/(png|jpeg);base64,/.exec(value);
    if (!prefix) return invalid("image_data_url must be data:image/png;base64,... or data:image/jpeg;base64,... .");
    const encoded = value.slice(prefix[0].length);
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      return invalid("The image contains invalid base64 data.");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > MAX_PHOTO_UPLOAD_BYTES) return invalid("The PNG/JPEG upload exceeds the 2 MiB decoded-size limit.");
    if (bytes.toString("base64") !== encoded) return invalid("The image contains non-canonical base64 data.");
    const isPng = prefix[1] === "png";
    const signature = isPng ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) : Buffer.from([255, 216, 255]);
    if (bytes.length <= signature.length || !bytes.subarray(0, signature.length).equals(signature)) {
      return invalid("The image bytes do not match the declared PNG/JPEG format.");
    }
    return {
      valid: true,
      photo: { kind: "upload", bytes, mimeType: isPng ? "image/png" : "image/jpeg", filename: isPng ? "photo.png" : "photo.jpg" }
    };
  }

  const value = input.photo;
  if (typeof value !== "string" || !value || value.length > MAX_PHOTO_REFERENCE_LENGTH ||
      /[\s\u0000-\u001f\u007f\\]/.test(value)) {
    return invalid("photo must be an HTTPS image URL or Telegram file_id, not a local path.");
  }
  if (/^[A-Za-z0-9_-]{1,1024}$/.test(value)) {
    return { valid: true, photo: { kind: "reference", value } };
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        (url.port && url.port !== "443") || !host.includes(".") ||
        isIP(host.replace(/^\[|\]$/g, "")) ||
        /(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(host)) {
      return invalid("Use a public HTTPS image URL without credentials, fragments, IP literals, local hosts, or custom ports.");
    }
    // Do not resolve or fetch this URL here. Telegram alone retrieves remote images.
    return { valid: true, photo: { kind: "reference", value: url.href } };
  } catch {
    return invalid("photo must be an HTTPS image URL or Telegram file_id. Local paths, sandbox: links, and attach:// references are not supported.");
  }
}

export type TelegramPhotoMessage = {
  message_id: number;
  date: number;
  file_id?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function photoFailureMessage(code: number): string {
  switch (code) {
    case 400: return "Telegram rejected the photo. Check the image URL or file_id, image format, size, and dimensions.";
    case 401: return "Telegram authentication failed. Check TELEGRAM_BOT_TOKEN.";
    case 403: return "Telegram denied the photo send. Check the bot's permissions for the configured destination.";
    case 429: return "Telegram's rate limit was reached. Wait before retrying.";
    default: return `Telegram could not send the photo (HTTP/API ${code}).`;
  }
}

export async function sendTelegramPhoto(options: {
  botToken: string;
  channelId: string;
  photo: PreparedPhoto;
  caption: string;
  silent: boolean;
  hasSpoiler: boolean;
  protectContent: boolean;
}): Promise<TelegramPhotoMessage> {
  const fields = {
    chat_id: options.channelId,
    caption: options.caption,
    disable_notification: options.silent,
    has_spoiler: options.hasSpoiler,
    protect_content: options.protectContent
  };
  let body: string | FormData;
  const headers: Record<string, string> = { "user-agent": "telegram-relay-richmarkdown-mcp/1.0" };
  if (options.photo.kind === "upload") {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
    form.set("photo", new Blob([new Uint8Array(options.photo.bytes)], { type: options.photo.mimeType }), options.photo.filename);
    body = form; // fetch must generate the multipart Content-Type boundary.
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify({ ...fields, photo: options.photo.value });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PHOTO_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.telegram.org/bot${options.botToken}/sendPhoto`, {
      method: "POST", headers, body, cache: "no-store", signal: controller.signal
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (controller.signal.aborted) throw new Error("aborted");
      throw new TelegramApiError(`Telegram returned an invalid photo response (HTTP ${response.status}).`);
    }
    if (!isRecord(payload) || typeof payload.ok !== "boolean") {
      throw new TelegramApiError("Telegram returned an invalid photo response.");
    }
    if (!response.ok || !payload.ok) {
      const code = Number.isInteger(payload.error_code) ? payload.error_code as number : response.status;
      const parameters = isRecord(payload.parameters) ? payload.parameters : undefined;
      const retryAfter = parameters?.retry_after;
      // Telegram descriptions may echo source URLs, captions, or tokens. Do not forward them.
      throw new TelegramApiError(photoFailureMessage(code), {
        errorCode: code,
        retryAfterSeconds: typeof retryAfter === "number" && Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter : undefined
      });
    }
    const message = payload.result;
    if (!isRecord(message) || !Number.isInteger(message.message_id) || !Number.isInteger(message.date)) {
      throw new TelegramApiError("Telegram returned an invalid photo message.");
    }
    const sizes = Array.isArray(message.photo) ? message.photo.filter(isRecord) : [];
    const largest = sizes
      .filter((size) => typeof size.file_id === "string" && typeof size.width === "number" && typeof size.height === "number")
      .sort((a, b) => (b.width as number) * (b.height as number) - (a.width as number) * (a.height as number))[0];
    return {
      message_id: message.message_id as number,
      date: message.date as number,
      ...(largest ? { file_id: largest.file_id as string } : {})
    };
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new TelegramApiError("The photo request timed out; delivery is unknown. Check Telegram before retrying to avoid a duplicate.");
    }
    if (error instanceof TelegramApiError) throw error;
    throw new TelegramApiError("The photo request could not be completed; delivery is unknown. Check Telegram before retrying.");
  } finally {
    clearTimeout(timeout);
  }
}
