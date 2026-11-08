import { z } from "zod";

import { constantTimeEqual, isStrongAccessToken } from "@/lib/security";
import { getTopicStore, recordTopic, threadId } from "@/lib/topic-store";

export const runtime = "nodejs";

const telegramMessage = z.object({
  chat: z.object({ id: z.number().int().safe(), type: z.enum(["private", "supergroup"]) }),
  message_id: threadId,
  date: z.number().int().nonnegative(),
  edit_date: z.number().int().nonnegative().optional(),
  message_thread_id: threadId.optional(),
  is_topic_message: z.literal(true).optional(),
  forum_topic_created: z.object({ name: z.string().min(1).max(256) }).optional(),
  forum_topic_edited: z.object({ name: z.string().min(1).max(256).optional() }).optional(),
  from: z.object({ first_name: z.string(), last_name: z.string().optional() }).optional(),
  sender_chat: z.object({ title: z.string().optional() }).optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  photo: z.array(z.unknown()).optional()
});

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const provided = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!isStrongAccessToken(secret) || secret.length > 256 || !constantTimeEqual(secret, provided)) {
    return new Response("Not found", { status: 404 });
  }

  const store = getTopicStore();
  if (!store) return new Response(null, { status: 503 });

  let update: { update_id?: unknown; message?: unknown; edited_message?: unknown } | null;
  try {
    update = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }

  const updateId = threadId.safeParse(update?.update_id);
  const parsed = telegramMessage.safeParse(update?.message ?? update?.edited_message);
  if (!parsed.success || String(parsed.data.chat.id) !== store.chatId) return new Response(null, { status: 204 });

  const message = parsed.data;
  const created = message.forum_topic_created;
  const edited = message.forum_topic_edited;
  const id = message.message_thread_id ?? (created ? message.message_id : undefined);
  if (!id || (!message.is_topic_message && !created && !edited) ||
      (message.chat.type === "supergroup" && id === 1)) {
    return new Response(null, { status: 204 });
  }

  const name = created?.name ?? edited?.name;
  const text = message.text ?? message.caption;
  const sender = message.sender_chat?.title ??
    (message.from && [message.from.first_name, message.from.last_name].filter(Boolean).join(" "));
  try {
    await recordTopic(store, {
      threadId: id,
      updateId: updateId.success ? updateId.data : undefined,
      title: name ? { name, eventId: message.message_id } : undefined,
      message: created || edited ? undefined : {
        message_id: message.message_id,
        date: message.date,
        edited_at: message.edit_date,
        kind: message.photo ? "photo" : text === undefined ? "other" : "text",
        sender,
        text
      }
    });
    return new Response(null, { status: 204 });
  } catch {
    // A retryable status lets Telegram redeliver without logging chat content.
    return new Response(null, { status: 503 });
  }
}
