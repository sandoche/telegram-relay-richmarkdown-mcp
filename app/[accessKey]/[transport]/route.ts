import type { NextRequest } from "next/server";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

import { checkSendGuard, recordSuccessfulSend } from "@/lib/rate-limit";
import {
  constantTimeEqual,
  isStrongAccessToken,
  readBooleanEnv,
  readIntegerEnv,
  sha256
} from "@/lib/security";
import {
  sendTelegramRichMarkdown,
  TelegramApiError,
  validateRichMarkdown
} from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RouteContext = {
  params: Promise<{ accessKey: string; transport: string }>;
};

function toolError(message: string, details?: Record<string, unknown>) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    structuredContent: { ok: false, message, ...details }
  };
}

async function route(request: NextRequest, context: RouteContext): Promise<Response> {
  const { accessKey, transport } = await context.params;
  const expectedAccessToken = process.env.MCP_ACCESS_TOKEN;

  if (!isStrongAccessToken(expectedAccessToken)) {
    return Response.json(
      { error: "server_not_configured" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }

  if (!constantTimeEqual(accessKey, expectedAccessToken) || transport !== "mcp") {
    return new Response("Not found", { status: 404 });
  }

  const handler = createMcpHandler(
    (server) => {
      server.registerTool(
        "send_rich_markdown_to_telegram_channel",
        {
          title: "Send Rich Markdown to Telegram",
          description:
            "Use this only when the user explicitly asks to publish a message to the single Telegram destination configured by this server. The tool creates an external Telegram post using Telegram Rich Markdown; it cannot choose another destination or administer Telegram.",
          inputSchema: {
            markdown: z
              .string()
              .min(1)
              .max(32_768)
              .describe(
                "Telegram Rich Markdown. Supports headings, lists, task lists, tables, links, quotes, details, spoilers, footnotes, code, and LaTeX formulas. Remote media embeds are intentionally blocked."
              ),
            silent: z
              .boolean()
              .optional()
              .describe("Send without a notification sound. Defaults to false."),
            is_rtl: z
              .boolean()
              .optional()
              .describe("Render the rich message right-to-left. Defaults to false.")
          },
          outputSchema: {
            ok: z.boolean(),
            message: z.string(),
            message_id: z.number().int().optional(),
            date: z.number().int().optional(),
            retry_after_seconds: z.number().int().optional()
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false
          }
        },
        async ({ markdown, silent, is_rtl }) => {
          const botToken = process.env.TELEGRAM_BOT_TOKEN;
          const channelId = process.env.TELEGRAM_CHANNEL_ID;

          if (!botToken || !channelId) {
            return toolError(
              "Telegram is not configured. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID, then redeploy."
            );
          }

          const validation = validateRichMarkdown(markdown);
          if (!validation.valid) return toolError(validation.message);

          const duplicateWindowSeconds = readIntegerEnv(
            "MCP_DUPLICATE_WINDOW_SECONDS",
            120,
            0,
            600
          );
          const payloadHash = sha256(
            JSON.stringify({ markdown, silent: silent ?? false, isRtl: is_rtl ?? false })
          );
          const now = Date.now();
          const guard = checkSendGuard({
            now,
            payloadHash,
            maxPerMinute: readIntegerEnv("MCP_MAX_MESSAGES_PER_MINUTE", 5, 1, 30),
            duplicateWindowSeconds
          });

          if (!guard.allowed) {
            const message =
              guard.reason === "duplicate"
                ? "An identical message was sent recently, so this duplicate was blocked."
                : "The local safety rate limit was reached.";
            return toolError(message, { retry_after_seconds: guard.retryAfterSeconds });
          }

          try {
            const telegramMessage = await sendTelegramRichMarkdown({
              botToken,
              channelId,
              markdown,
              silent: silent ?? false,
              isRtl: is_rtl ?? false,
              protectContent: readBooleanEnv("TELEGRAM_PROTECT_CONTENT", true),
              skipEntityDetection: readBooleanEnv("TELEGRAM_SKIP_ENTITY_DETECTION", false)
            });

            recordSuccessfulSend({ now, payloadHash, duplicateWindowSeconds });

            const output = {
              ok: true,
              message: "Rich Markdown message sent to the configured Telegram destination.",
              message_id: telegramMessage.message_id,
              date: telegramMessage.date
            };

            return {
              content: [{ type: "text" as const, text: output.message }],
              structuredContent: output
            };
          } catch (error) {
            const apiError = error instanceof TelegramApiError ? error : undefined;
            const safeMessage = apiError?.message ?? "Telegram could not send the message.";

            // Never log message content, the bot token, the destination ID, or the full Telegram URL.
            console.error("Telegram Rich MCP send failed", {
              errorCode: apiError?.errorCode,
              retryAfterSeconds: apiError?.retryAfterSeconds
            });

            return toolError(safeMessage, {
              retry_after_seconds: apiError?.retryAfterSeconds
            });
          }
        }
      );
    },
    {},
    {
      basePath: `/${accessKey}`,
      maxDuration: 60,
      verboseLogs: false
    }
  );

  return handler(request);
}

export { route as GET, route as POST, route as DELETE };
