import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { cleanText } from "./sanitize.js";

// Thin client for the Linq Partner API v3 (https://docs.linqapp.com).

async function linq(method: string, path: string, body?: unknown): Promise<any> {
  if (config.linq.dryRun) {
    const msg = body as { message?: { parts?: { value: string }[] }; custom_emoji?: string } | undefined;
    const what = msg?.message?.parts?.map((p) => p.value).join("") ?? msg?.custom_emoji ?? "";
    if (what) console.log(`[dry-run] ${method} ${path} :: ${what.replace(/\n/g, " ⏎ ")}`);
    return null;
  }
  if (!config.linq.apiKey) throw new Error("LINQ_API_KEY is not set");
  const res = await fetch(`${config.linq.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.linq.apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Linq ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const MAX_PART = 10_000;

export async function sendText(chatId: string, rawText: string, replyToMessageId?: string) {
  const text = cleanText(rawText); // no dashes, no markdown, ever
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX_PART) chunks.push(text.slice(i, i + MAX_PART));
  return linq("POST", `/chats/${chatId}/messages`, {
    message: {
      parts: chunks.map((value) => ({ type: "text", value })),
      ...(replyToMessageId ? { reply_to: { message_id: replyToMessageId } } : {}),
    },
  });
}

/** Adds a custom-emoji tapback to a message. */
export async function reactWithEmoji(messageId: string, emoji: string) {
  return linq("POST", `/messages/${messageId}/reactions`, {
    operation: "add",
    type: "custom",
    custom_emoji: emoji,
  });
}

export async function startTyping(chatId: string) {
  return linq("POST", `/chats/${chatId}/typing`);
}

export async function stopTyping(chatId: string) {
  return linq("DELETE", `/chats/${chatId}/typing`);
}

export async function createWebhookSubscription(targetUrl: string, events: string[]) {
  return linq("POST", `/webhook-subscriptions`, {
    target_url: targetUrl,
    subscribed_events: events,
  });
}

export async function listWebhookSubscriptions() {
  return linq("GET", `/webhook-subscriptions`);
}

/** Standard Webhooks verification: HMAC-SHA256 over "{id}.{timestamp}.{rawBody}". */
export function verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): boolean {
  const secret = config.linq.webhookSecret;
  if (!secret) return !config.cloud; // unsigned webhooks only allowed in local dev

  const id = String(headers["webhook-id"] ?? "");
  const timestamp = String(headers["webhook-timestamp"] ?? "");
  const signatures = String(headers["webhook-signature"] ?? "");
  if (!id || !timestamp || !signatures) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 5 * 60) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(rawBody).digest();

  // Header may carry several space-separated "v1,<base64>" signatures (key rotation).
  return signatures.split(" ").some((entry) => {
    const [version, sig] = entry.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
