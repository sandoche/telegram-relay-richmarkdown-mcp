import { isStrongAccessToken } from "@/lib/security";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    {
      ok: true,
      configured: {
        mcpAccessToken: isStrongAccessToken(process.env.MCP_ACCESS_TOKEN),
        telegramBotToken: Boolean(process.env.TELEGRAM_BOT_TOKEN),
        telegramDestination: Boolean(process.env.TELEGRAM_CHANNEL_ID)
      }
    },
    { headers: { "cache-control": "no-store" } }
  );
}
