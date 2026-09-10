# Telegram Relay Rich Markdown MCP

A small, private [Model Context Protocol](https://modelcontextprotocol.io/) server that lets ChatGPT or another MCP client send **Telegram Rich Markdown and photos** to one fixed Telegram destination.

The server is intentionally narrow: it exposes two write tools, cannot choose another chat, and does not provide Telegram administration capabilities.

## Features

- Sends Telegram Rich Markdown through `sendRichMessage`.
- Sends photos through `sendPhoto`: public HTTPS URLs, existing Telegram `file_id` values, or PNG/JPEG byte uploads.
- Supports headings, lists, task lists, tables, links, quotations, details, spoilers, footnotes, code, and LaTeX formulas.
- Uses one destination configured by `TELEGRAM_CHANNEL_ID`.
- Protects the MCP endpoint with a high-entropy capability URL.
- Keeps remote media embeds blocked in Rich Markdown; images use a separate, validated photo tool.
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

Neither tool accepts a `chat_id`; the destination only comes from the server environment. The server also does not implement message editing, deletion, member management, webhooks, invite links, paid broadcasts, or other Telegram administration methods.

Remote media blocks inside Rich Markdown are rejected intentionally. The photo tool sends only to the same fixed destination and shares the existing rate budget and duplicate guard. Image URLs are passed to Telegram, never fetched or DNS-resolved by this server. HTTPS is required; credentials, IP literals, local hostnames, custom ports, and fragments are rejected. This is input screening, not a guarantee about DNS or redirects: Telegram handles remote retrieval. Image data and upstream error descriptions are not logged or echoed in photo errors.

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

## Photo tool

`send_photo_to_telegram_channel` sends one photo. Call it only after the user explicitly asks to publish that image.

| Argument | Description |
| --- | --- |
| `photo` | Direct public HTTPS image URL, or a photo `file_id` already available to this bot. |
| `image_data_url` | Upload PNG/JPEG bytes as `data:image/png;base64,...` or `data:image/jpeg;base64,...`. Maximum decoded size: **2 MiB**. |
| `caption` | Optional **plain text**, at most 1024 Unicode characters. No Markdown/HTML parsing. |
| `silent` | Optional; defaults to `false`. |
| `has_spoiler` | Optional; defaults to `false`. |

Provide **exactly one** of `photo` and `image_data_url`. The result contains `message_id`, `date`, and a reusable `file_id` when returned by Telegram. `TELEGRAM_PROTECT_CONTENT` applies to photos too. No new environment variables are required.

Example tool arguments for an image URL (replace the example URL with a real image):

```json
{
  "photo": "https://example.com/chart.png",
  "caption": "Weekly job-search progress",
  "silent": true
}
```

For a local PNG, an MCP client with file-system access can construct the arguments without publishing the image on a public host:

```js
import { readFile } from "node:fs/promises";

const bytes = await readFile("chart.png");
if (bytes.length > 2 * 1024 * 1024) throw new Error("Image exceeds 2 MiB");
const args = {
  image_data_url: `data:image/png;base64,${bytes.toString("base64")}`,
  caption: "Weekly job-search progress"
};
// Pass args to your MCP client's callTool for send_photo_to_telegram_channel.
```

Use `image/jpeg` for JPEG files. The server validates canonical base64, the decoded size, and the PNG/JPEG file signature, then uploads using multipart/form-data. Telegram performs actual image decoding and dimension checks; a valid signature alone does not prove an image is decodable.

The 2 MiB upload cap leaves room for base64 and JSON overhead below transport/hosting limits, including [Vercel's 4.5 MB function payload limit](https://vercel.com/docs/functions/limitations#request-body-size). Clients can have smaller argument limits; prefer a URL or `file_id` for large images. Telegram currently documents a **5 MB photo limit for URL retrieval**, a **10 MB photo upload limit**, width + height at most 10000 pixels, and an aspect ratio at most 20; see [sendPhoto](https://core.telegram.org/bots/api#sendphoto) and [Sending files](https://core.telegram.org/bots/api#sending-files). The relay's own byte-upload cap is stricter.

**Local filenames and ChatGPT `sandbox:` links are not remotely accessible.** This tool does not automatically transfer chat attachments. The client must supply accessible image bytes or an HTTPS URL. Do not expose confidential images on a public host merely to obtain a URL; use byte upload where supported. URL mode shares the full URL with Telegram, so avoid secret-bearing links.

Photos and Rich Markdown remain separate Telegram messages. For a long formatted report plus a chart, explicitly send the report using the existing tool and the chart using the photo tool. Albums, videos, arbitrary documents, and inline images within a rich message are not added by this feature.

On a timeout/network error, delivery can be unknown. The tool deliberately does **not** retry automatically; check Telegram before retrying to avoid duplicate posts. Successful sends share the existing best-effort duplicate/rate controls; these do not guarantee exactly-once delivery under concurrency or across server instances.

### Upgrade an existing deployment

Merge the photo-support PR and redeploy the existing MCP server. Keep the same bot, destination, access token, and MCP URL. Refresh/reconnect your MCP client so `tools/list` exposes both `send_rich_markdown_to_telegram_channel` and `send_photo_to_telegram_channel`, and approve the new write tool as required by the client. An already-open chat may retain the old tool list.

### Tests

```bash
npm install
npm test
npm run check
npm run build
```

The tests compile the server-side helpers and use Node's test runner with mocked Telegram responses. They exercise validation, JSON and multipart requests, safe errors/timeouts, duplicate/rate guards, and existing Rich Markdown behavior. **They never publish a real Telegram message.** A live smoke test is a separate, explicitly authorized action after deployment.

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
- Embedded images in Rich Markdown remain blocked; use the photo tool. The photo tool supports one image per call and plain-text captions only.
- Telegram bots cannot initiate a private conversation until the user has contacted the bot.
- Rich Markdown support depends on the Telegram Bot API version available to the bot.

## License

[MIT](LICENSE)
