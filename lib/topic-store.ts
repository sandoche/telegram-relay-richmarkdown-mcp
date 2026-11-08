import { z } from "zod";

import { sha256 } from "./security";

export const threadId = z.number().int().positive().safe();
export const topicSchema = z.object({
  message_thread_id: threadId,
  name: z.string().nullable()
});
export const topicMessageSchema = z.object({
  message_id: z.number().int().nonnegative().safe(),
  date: z.number().int().nonnegative(),
  edited_at: z.number().int().nonnegative().optional(),
  kind: z.enum(["text", "photo", "rich_markdown", "other"]),
  sender: z.string().optional(),
  text: z.string().optional(),
  truncated: z.literal(true).optional()
});

type Topic = z.infer<typeof topicSchema>;
type TopicMessage = z.infer<typeof topicMessageSchema>;
type TopicStore = { url: string; token: string; chatId: string; key: string };
type Observation = {
  threadId: number;
  title?: { name: string; eventId: number };
  message?: TopicMessage;
  updateId?: number;
};

const MAX_STORED_MESSAGES = 100;
const MAX_TEXT_LENGTH = 8_000;

// Telegram retries webhooks and can deliver them out of order. Update the topic
// title and the bounded, message-ID-indexed history atomically across instances.
const RECORD_OBSERVATION = `
local topic = redis.call('HGET', KEYS[1], ARGV[1])
local title = ARGV[2]
if title ~= '' then
  if not topic or cjson.decode(topic).eventId < tonumber(ARGV[3]) then
    redis.call('HSET', KEYS[1], ARGV[1], cjson.encode({name = title, eventId = tonumber(ARGV[3])}))
  end
elseif not topic then
  redis.call('HSET', KEYS[1], ARGV[1], '{"eventId":0}')
end

if ARGV[4] ~= '' then
  local id = ARGV[5]
  local existing = redis.call('ZRANGEBYSCORE', KEYS[2], id, id)[1]
  if existing then
    local message = cjson.decode(existing)
    local savedDate = message.edited_at or message.date
    local incomingDate = tonumber(ARGV[6])
    if savedDate > incomingDate or
      (savedDate == incomingDate and (message.update_id or 0) >= tonumber(ARGV[7])) then
      return 1
    end
    redis.call('ZREMRANGEBYSCORE', KEYS[2], id, id)
  end
  redis.call('ZADD', KEYS[2], id, ARGV[4])
  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -tonumber(ARGV[8]) - 1)
end
return 1
`;

export function getTopicStore(): TopicStore | undefined {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID;
  const botId = process.env.TELEGRAM_BOT_TOKEN?.split(":", 1)[0];
  if (!url || !token || !botId || !chatId || !/^-?[1-9]\d*$/.test(chatId)) return;
  // A stable bot ID keeps token rotation from changing the archive namespace.
  return { url, token, chatId, key: `telegram-topics:v1:{${sha256(`${botId}:${chatId}`)}}` };
}

async function redis(store: TopicStore, command: (string | number)[]): Promise<unknown> {
  const response = await fetch(store.url, {
    method: "POST",
    headers: { authorization: `Bearer ${store.token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error("Topic storage is unavailable.");
  const body = await response.json();
  if (body?.error || !Object.hasOwn(body ?? {}, "result")) throw new Error("Topic storage is unavailable.");
  return body.result;
}

const savedTopic = z.object({ name: z.string().optional() });
function parseTopic(id: string, value: string): Topic {
  return { message_thread_id: threadId.parse(Number(id)), name: savedTopic.parse(JSON.parse(value)).name ?? null };
}

export async function listTopics(store: TopicStore): Promise<Topic[]> {
  const fields = z.array(z.string()).parse(await redis(store, ["HGETALL", store.key]));
  const topics: Topic[] = [];
  for (let i = 0; i < fields.length; i += 2) topics.push(parseTopic(fields[i], fields[i + 1]));
  return topics.sort((left, right) => right.message_thread_id - left.message_thread_id);
}

export async function readTopic(store: TopicStore, id: number, limit: number, before?: number) {
  const value = await redis(store, ["HGET", store.key, id]);
  if (value === null) return;
  const topic = parseTopic(String(id), z.string().parse(value));
  const entries = z.array(z.string()).parse(await redis(store, [
    "ZREVRANGEBYSCORE", `${store.key}:${id}`, before === undefined ? "+inf" : `(${before}`, "-inf",
    "LIMIT", 0, limit + 1
  ]));
  const messages = entries.slice(0, limit).map((entry) => topicMessageSchema.parse(JSON.parse(entry)));
  return {
    topic,
    messages,
    ...(entries.length > limit ? { next_before_message_id: messages[messages.length - 1].message_id } : {})
  };
}

export async function recordTopic(store: TopicStore, observation: Observation) {
  const { threadId: id, title, message, updateId } = observation;
  // Telegram can temporarily return message ID 0 for a scheduled send.
  const entry = message && message.message_id > 0 ? message : undefined;
  const text = entry?.text === undefined ? [] : Array.from(entry.text);
  const bounded = entry && text.length > MAX_TEXT_LENGTH
    ? { ...entry, text: text.slice(0, MAX_TEXT_LENGTH).join(""), truncated: true }
    : entry;

  await redis(store, [
    "EVAL", RECORD_OBSERVATION, 2, store.key, `${store.key}:${id}`, id,
    title?.name ?? "", title?.eventId ?? 0, bounded ? JSON.stringify({ ...bounded, update_id: updateId }) : "",
    entry?.message_id ?? 0, entry?.edited_at ?? entry?.date ?? 0, updateId ?? 0, MAX_STORED_MESSAGES
  ]);
}

// A successful Telegram write stays successful if the optional archive is unavailable.
export async function recordRelayTopic(observation: Observation): Promise<boolean> {
  const store = getTopicStore();
  if (!store) return false;
  try {
    await recordTopic(store, observation);
    return !observation.message || observation.message.message_id > 0;
  } catch {
    console.error("Telegram topic archive write failed");
    return false;
  }
}
