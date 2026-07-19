const TELEGRAM_RICH_MARKDOWN_LIMIT = 32_768;
const REQUEST_TIMEOUT_MS = 15_000;

const UNSAFE_SCHEME = /(?:javascript|data|vbscript):/i;
const BLOCKED_MEDIA_HTML =
  /<\s*\/?\s*(?:img|video|audio|source|figure|tg-map|tg-collage|tg-slideshow)\b/i;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/gi;

export type RichMarkdownValidation =
  | { valid: true; characterCount: number }
  | { valid: false; message: string };

export function validateRichMarkdown(markdown: string): RichMarkdownValidation {
  const characterCount = Array.from(markdown).length;

  if (characterCount === 0) {
    return { valid: false, message: "The Rich Markdown message cannot be empty." };
  }

  if (characterCount > TELEGRAM_RICH_MARKDOWN_LIMIT) {
    return {
      valid: false,
      message: `The Rich Markdown message exceeds Telegram's ${TELEGRAM_RICH_MARKDOWN_LIMIT.toLocaleString()} character limit.`
    };
  }

  if (markdown.includes("\u0000")) {
    return { valid: false, message: "The message contains a forbidden null character." };
  }

  if (UNSAFE_SCHEME.test(markdown)) {
    return { valid: false, message: "Unsafe javascript:, data:, or vbscript: links are not allowed." };
  }

  if (BLOCKED_MEDIA_HTML.test(markdown)) {
    return {
      valid: false,
      message:
        "Remote media and rich media blocks are disabled. Text formatting, links, tables, details, quotations, and formulas are supported."
    };
  }

  MARKDOWN_IMAGE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_IMAGE.exec(markdown)) !== null) {
    const target = match[1]?.toLowerCase() ?? "";
    if (!target.startsWith("tg://emoji") && !target.startsWith("tg://time")) {
      return {
        valid: false,
        message:
          "Remote Markdown images are disabled. Telegram custom emoji and date-time entities remain supported."
      };
    }
  }

  return { valid: true, characterCount };
}

type TelegramMessage = {
  message_id: number;
  date: number;
};

type TelegramSuccess<T> = { ok: true; result: T };
type TelegramFailure = {
  ok: false;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

type TelegramResponse<T> = TelegramSuccess<T> | TelegramFailure;

export class TelegramApiError extends Error {
  readonly errorCode?: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, options?: { errorCode?: number; retryAfterSeconds?: number }) {
    super(message);
    this.name = "TelegramApiError";
    this.errorCode = options?.errorCode;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export async function sendTelegramRichMarkdown(options: {
  botToken: string;
  channelId: string;
  markdown: string;
  silent: boolean;
  isRtl: boolean;
  protectContent: boolean;
  skipEntityDetection: boolean;
}): Promise<TelegramMessage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    // Telegram bot tokens contain a required colon. Do not URL-encode the token path segment.
    const response = await fetch(
      `https://api.telegram.org/bot${options.botToken}/sendRichMessage`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "telegram-relay-richmarkdown-mcp/1.0"
        },
        body: JSON.stringify({
          chat_id: options.channelId,
          rich_message: {
            markdown: options.markdown,
            is_rtl: options.isRtl,
            skip_entity_detection: options.skipEntityDetection
          },
          disable_notification: options.silent,
          protect_content: options.protectContent
        }),
        cache: "no-store",
        signal: controller.signal
      }
    );

    let result: TelegramResponse<TelegramMessage>;
    try {
      result = (await response.json()) as TelegramResponse<TelegramMessage>;
    } catch {
      throw new TelegramApiError(`Telegram returned an invalid response (HTTP ${response.status}).`);
    }

    if (!response.ok || !result.ok) {
      const failure = result as TelegramFailure;
      throw new TelegramApiError(
        failure.description ?? `Telegram request failed (HTTP ${response.status}).`,
        {
          errorCode: failure.error_code,
          retryAfterSeconds: failure.parameters?.retry_after
        }
      );
    }

    return result.result;
  } catch (error) {
    if (error instanceof TelegramApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new TelegramApiError("Telegram did not respond before the request timeout.");
    }
    throw new TelegramApiError("The Telegram request could not be completed.");
  } finally {
    clearTimeout(timeout);
  }
}
