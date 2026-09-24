import type { Request, Response } from "express";
import { config } from "./config.js";
import { pickEmoji } from "./emoji.js";
import { runAgent, STUDENT, type Speaker } from "./agent.js";
import * as linq from "./linq.js";
import { sendToChat } from "./notify.js";
import * as store from "./store.js";

interface Handle {
  handle: string;
  is_me: boolean;
}

interface MessageReceivedEvent {
  event_type: string;
  event_id: string;
  data: {
    id: string;
    direction: "inbound" | "outbound";
    chat: { id: string; is_group: boolean };
    sender_handle: Handle;
    parts: Array<{ type: string; value?: string }>;
  };
}

const normalize = (h: string) => h.replace(/[\s()-]/g, "").toLowerCase();

function isAllowed(handle: string): boolean {
  if (config.linq.allowedHandles.length === 0) return true;
  return config.linq.allowedHandles.some((h) => normalize(h) === normalize(handle));
}

/** Who's texting: the student (can edit), someone named in HANDLE_LABELS, or an unknown number (viewers). */
export function whoIs(handle: string): { log: string; isStudent: boolean; speaker: Speaker } {
  const { studentName, studentHandle, handleLabels } = config.linq;
  if (studentHandle && normalize(studentHandle) === normalize(handle)) {
    return { log: studentName, isStudent: true, speaker: STUDENT };
  }
  const name = Object.entries(handleLabels).find(([h]) => normalize(h) === normalize(handle))?.[1];
  const talkingWith = name
    ? `Talking with: ${name} (a viewer, not the student).`
    : `Talking with: an unknown number (${handle}), a viewer, not the student.`;
  return { log: name ?? handle, isStudent: false, speaker: { talkingWith, canEdit: false, pronoun: "their" } };
}

/** POST /webhooks/linq — expects express.raw() so the signature can be checked against the exact bytes. */
export function linqWebhook(req: Request, res: Response) {
  const raw = req.body as Buffer;
  if (!linq.verifyWebhook(req.headers, raw)) {
    res.status(401).send("bad signature");
    return;
  }

  let event: MessageReceivedEvent;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(400).send("bad json");
    return;
  }

  // Ack immediately: Linq times out after 10s, and Opus replies can take longer.
  res.sendStatus(200);

  if (event.event_type !== "message.received") return;
  const msg = event.data;
  if (msg.direction !== "inbound" || msg.sender_handle?.is_me) return;
  // Dedupe on the message id, not event_id: each webhook subscription delivers the same message
  // with its own event_id, so two subscriptions would otherwise mean two replies.
  if (!store.markEventProcessed(`message:${msg.id}`)) return;
  if (!isAllowed(msg.sender_handle.handle)) {
    console.warn(`[imessage] ignoring message from non-allowed handle ${msg.sender_handle.handle}`);
    return;
  }

  const text = msg.parts
    .filter((p) => p.type === "text" && p.value)
    .map((p) => p.value)
    .join("\n")
    .trim();
  if (!text) return;

  handleInbound(msg.chat.id, msg.chat.is_group, msg.id, text, whoIs(msg.sender_handle.handle)).catch((err) => console.error("[imessage] handler failed:", err));
}

async function handleInbound(chatId: string, isGroup: boolean, messageId: string, text: string, sender: ReturnType<typeof whoIs>) {
  const conversationKey = `imessage:${chatId}`;
  // Notifications only ever go to the student's own 1:1 chat, never a group chat.
  if (sender.isStudent) {
    store.updateSettings({ lastStudentMessageAt: new Date().toISOString(), ...(isGroup ? {} : { studentChatId: chatId }) });
  }
  console.log(`[imessage] <- (${sender.log}) ${text}`);

  // In a group Beast often stays quiet, so no typing bubble there (it would show and then nothing comes).
  const typing = isGroup ? { stop() {} } : keepTyping(chatId);
  try {
    // Tapback first (fast model), so the reply model knows exactly what reaction went on the message.
    const tapback = await pickEmoji(text);
    console.log(`[imessage] tapback ${tapback ?? "none"}`);
    if (tapback) {
      linq.reactWithEmoji(messageId, tapback).catch((err) => console.error("[imessage] tapback failed:", err.message));
    }

    const reply = await runAgent(conversationKey, "imessage", text, {
      speaker: sender.speaker,
      tapback,
      ...(isGroup ? { group: { senderName: sender.log } } : {}),
    });
    if (reply === null) return void console.log("[imessage] -> (stayed quiet in the group)");
    console.log(`[imessage] -> ${reply}`);
    await linq.sendText(chatId, reply);
  } catch (err) {
    console.error("[imessage] reply failed:", err);
    // Don't drop an error message into a group chat.
    if (!isGroup) await sendToChat(chatId, "something broke on my end, try again in a sec").catch(() => {});
  } finally {
    typing.stop();
  }
}

/** Shows the typing bubble and refreshes it every 60s (it expires after ~90s). */
function keepTyping(chatId: string) {
  const ping = () => linq.startTyping(chatId).catch((e) => console.warn("[imessage] typing:", e.message));
  ping();
  const timer = setInterval(ping, 60_000);
  return { stop: () => clearInterval(timer) };
}
