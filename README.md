# Telegram Relay Rich Markdown MCP

A small, private [Model Context Protocol](https://modelcontextprotocol.io/) server that lets ChatGPT or another MCP client send **Telegram Rich Markdown** to one fixed Telegram destination.

The server is intentionally narrow: it exposes one write tool, cannot choose another chat, and does not provide Telegram administration capabilities.

## Features

- Sends Telegram Rich Markdown through `sendRichMessage`.
- Supports headings, lists, task lists, tables, links, quotations, details, spoilers, footnotes, code, and LaTeX formulas.
- Uses one destination configured by `TELEGRAM_CHANNEL_ID`.
- Protects the MCP endpoint with a high-entropy capability URL.
- Blocks remote media embeds and unsafe URL schemes.
- Suppresses accidental duplicate messages.
- Applies a small best-effort per-instance rate limit.
- Avoids logging message text, bot tokens, destination IDs, or token-bearing Telegram URLs.
- Deploys on Vercel.

## Security model

The MCP endpoint is:

```text
https://YOUR-DOMAIN/<MCP_ACCESS_TOKEN>/mcp
```

Treat the complete URL as a password. This capability-URL approach is suitable for a private, single-user deployment. For a public or multi-user integration, replace it with a standards-based OAuth 2.1 authorization flow.

The tool cannot receive a `chat_id`; the destination only comes from the server environment. It also does not implement message editing, deletion, member management, webhooks, invite links, paid broadcasts, or other Telegram administration methods.

Remote media blocks are rejected intentionally. Normal text formatting, links, tables, details, quotations, spoilers, footnotes, code, and formulas remain available.

## Required environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token issued by `@BotFather`. |
| `TELEGRAM_CHANNEL_ID` | Yes | Fixed Telegram destination ID or public channel username. |
| `MCP_ACCESS_TOKEN` | Yes | URL-safe random secret with at least 32 characters. |
| `TELEGRAM_PROTECT_CONTENT` | No | Defaults to `true`. Prevents forwarding/saving where Telegram supports it. |
| `TELEGRAM_SKIP_ENTITY_DETECTION` | No | Defaults to `false`. |
| `MCP_MAX_MESSAGES_PER_MINUTE` | No | Defaults to `5`; accepted range is 1–30. |
| `MCP_DUPLICATE_WINDOW_SECONDS` | No | Defaults to `120`; accepted range is 0–600. |

Generate the MCP access token with:

```bash
openssl rand -hex 32
```

## Telegram destination IDs

Use the ID exactly as returned by Telegram:

| Destination | Example |
| --- | --- |
| Private user chat | `123456789` |
| Basic group | `-123456789` |
| Supergroup or channel | `-1001234567890` |
| Public channel | `@examplechannel` |

For a private bot conversation, first open the bot and send `/start`. Then retrieve the chat ID:

```powershell
$updates = Invoke-RestMethod "https://api.telegram.org/bot$token/getUpdates"

$updates.result | ForEach-Object {
  if ($_.message) {
    $_.message.chat
  }
}
```

Use the returned `message.chat.id` without modifying it.

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
```

The local endpoint is:

```text
http://localhost:3000/<MCP_ACCESS_TOKEN>/mcp
```

A non-secret health endpoint is available at:

```text
http://localhost:3000/health
```

It reports only whether each required setting is present, never its value.

## Deploy to Vercel

1. Import this repository into Vercel.
2. Add the required environment variables for Production and Preview.
3. Deploy.
4. Connect your MCP client using:

```text
https://YOUR-PROJECT.vercel.app/<MCP_ACCESS_TOKEN>/mcp
```

Once the GitHub repository is connected, pushes to `main` create production deployments and pull requests create preview deployments.

## Example Rich Markdown

```md
# Release update

**Version 2.4 is live.**

- Faster imports
- Better error messages
- New analytics table

| Metric | Result |
| --- | ---: |
| Build time | 42 s |
| Tests | 318 passed |

> Deployment completed successfully.

<details>
<summary>Technical notes</summary>

The complexity is $O(n \log n)$.

</details>
```

## Limitations

- The in-memory rate limit and duplicate cache are best-effort because Vercel instances do not share memory.
- Remote images and other remote media embeds are blocked.
- Telegram bots cannot initiate a private conversation until the user has contacted the bot.
- Rich Markdown support depends on the Telegram Bot API version available to the bot.

## License

[MIT](LICENSE)
