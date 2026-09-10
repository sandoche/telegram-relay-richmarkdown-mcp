import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Local configuration check only; never contact Telegram or touch send guards. */
export function registerStatusTool(server: McpServer) {
  server.registerTool<z.ZodRawShape, {}>(
    "get_telegram_relay_status",
    {
      title: "Check Telegram Relay Connection",
      description:
        "Read-only connection check before creating scheduled tasks. Sends no messages and makes no Telegram or other external requests. Reports MCP reachability and whether local Telegram settings are present; does not validate credentials, destination permissions, or delivery. Exposes no tokens or destination identifiers.",
      inputSchema: {},
      outputSchema: {
        ok: z.literal(true),
        status_version: z.literal(1),
        telegram_configured: z.boolean(),
        telegram_api_checked: z.literal(false),
        message: z.string()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const configured = Boolean(
        process.env.TELEGRAM_BOT_TOKEN?.trim() &&
        process.env.TELEGRAM_CHANNEL_ID?.trim()
      );
      const output = {
        ok: true as const,
        status_version: 1 as const,
        telegram_configured: configured,
        telegram_api_checked: false as const,
        message: configured
          ? "MCP connection is working. Telegram settings are present; credentials, permissions, and delivery have not been checked. No message was sent."
          : "MCP connection is working. Telegram settings are missing or blank; configure the server before scheduling sends. No message was sent."
      };
      return {
        content: [{ type: "text" as const, text: output.message }],
        structuredContent: output
      };
    }
  );
}
