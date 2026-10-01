import type { Request, Response } from "express";
import { config } from "./config.js";
import { pickEmoji } from "./emoji.js";
import { otherSpeaker, runAgent, userSpeaker, type Speaker } from "./agent.js";
import { handleCommand } from "./commands.js";
import * as global from "./globalStore.js";
import * as linq from "./linq.js";
import { track } from "./metrics.js";
import { continueOnboarding, handleStranger } from "./onboarding.js";
import * as people from "./people.js";
import { localDay } from "./snapshot.js";
import * as store from "./store.js";
import { withUser } from "./userContext.js";

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

const normalize = global.normalizeHandle;
const OUTAGE_LINE = "my brain's buffering rn, try me again in a few";
const TAPPED_OUT = "im tapped out for today, catch u tmrw";
const FEEDBACK_ANSWER_WINDOW_MS = 24 * 3600_000;

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

  // Ack immediately: Linq times out after 10s, and replies can take longer.
  res.sendStatus(200);
  lastWebhookAt = new Date().toISOString();

  if (event.event_type !== "message.received") return;
  const msg = event.data;
  if (msg.direction !== "inbound" || msg.sender_handle?.is_me) return;
  // Dedupe on the message id, not event_id: each webhook subscription delivers the same message
  // with its own event_id, so two subscriptions (or a retry) would otherwise mean two replies.
  if (!global.markEventProcessed(`message:${msg.id}`)) return;

  const text = msg.parts
    .filter((p) => p.type === "text" && p.value)
    .map((p) => p.value)
    .join("\n")
    .trim()
    .slice(0, config.limits.maxMessageChars);
  if (!text) return;

  const handler = msg.chat.is_group ? handleGroup : handleDirect;
  handler(msg.chat.id, msg.id, text, msg.sender_handle.handle).catch((err) => console.error("[imessage] handler failed:", err));
}

/** For /healthz: when Linq last delivered anything. */
export let lastWebhookAt: string | null = null;

async function reply(chatId: string, text: string) {
  console.log(`[imessage] -> ${text.split("\n")[0].slice(0, 120)}`);
  await linq.sendText(chatId, text);
}

/** Saves an exchange Beast handled without the reply model (onboarding, commands), so later replies have the context. */
function record(conversationKey: string, text: string, answer: string, from?: string) {
  store.appendTurn(conversationKey, { role: "user", text, ...(from ? { from } : {}) });
  store.appendTurn(conversationKey, { role: "assistant", text: answer });
}

/** Counts a message toward the user's daily cap. "limit" is the first one over it (tell them once), "over" every one after. */
function countMessage(user: global.User): "ok" | "limit" | "over" {
  if (user.role === "owner") return "ok";
  const date = localDay(new Date());
  const count = user.daily.date === date ? user.daily.count + 1 : 1;
  global.updateUser(user.id, { daily: { date, count } });
  return count <= config.limits.dailyMessages ? "ok" : count === config.limits.dailyMessages + 1 ? "limit" : "over";
}

// ---- 1:1 chats ----

async function handleDirect(chatId: string, messageId: string, text: string, handle: string) {
  const key = `imessage:${chatId}`;
  let user = global.getUserByHandle(handle);

  if (!user) {
    const result = handleStranger(handle, chatId, text);
    if (!result) return; // uninvited and already told: silence
    console.log(`[imessage] <- (stranger ${handle.slice(-4)}) ${text.slice(0, 80)}`);
    if (result.userId) withUser(result.userId, () => record(key, text, result.reply));
    return reply(chatId, result.reply);
  }
  if (user.status === "paused") return;

  await withUser(user.id, async () => {
    store.updateSettings({ chatId, lastMessageAt: new Date().toISOString() });
    user = global.updateUser(user!.id, { lastActiveAt: new Date().toISOString() });
    console.log(`[imessage] <- (${user.name ?? handle.slice(-4)}) ${text.slice(0, 120)}`);

    if (user.status === "onboarding") {
      const answers = await continueOnboarding(user, text);
      record(key, text, answers.join("\n\n"));
      for (const a of answers) await reply(chatId, a);
      return;
    }

    const commandReply = await handleCommand(user, text);
    if (commandReply) {
      // A deleted user has no file left to record into.
      if (global.getUser(user.id)) record(key, text, commandReply);
      return reply(chatId, commandReply);
    }

    const quota = countMessage(user);
    if (quota !== "ok") {
      if (quota === "limit") await reply(chatId, TAPPED_OUT);
      return;
    }

    // The week-one question ("what's the one thing you wish i did?"): their next reply is feedback.
    const asked = user.offeredAt.feedback_q;
    if (asked && !user.offeredAt.feedback_a && Date.now() - Date.parse(asked) < FEEDBACK_ANSWER_WINDOW_MS) {
      global.addFeedback(user.id, text, "week1");
      global.updateUser(user.id, { offeredAt: { ...user.offeredAt, feedback_a: new Date().toISOString() } });
    }

    track("message");
    await converse(chatId, false, messageId, text, key, user, userSpeaker(user));
  });
}

// ---- group chats ----

async function handleGroup(chatId: string, messageId: string, text: string, handle: string) {
  const key = `imessage:${chatId}`;
  const sender = global.getUserByHandle(handle);
  let ownerId = global.groupOwner(chatId);
  if (!ownerId) {
    // A group belongs to the first active user who talks in it with Beast there.
    if (!sender || sender.status !== "active") return;
    global.setGroupOwner(chatId, sender.id);
    ownerId = sender.id;
  }
  const owner = global.getUser(ownerId);
  if (!owner || owner.status !== "active") return;

  await withUser(owner.id, async () => {
    const isOwner = sender?.id === owner.id;
    let name = isOwner ? (owner.name ?? "them") : (sender?.name ?? people.getPersonName(handle));

    if (!isOwner && !sender) {
      const person = global.getPerson(handle);
      if (!person) {
        // First time Beast sees this number: ask who they are, no reply model.
        global.upsertPerson(handle, { askedIn: chatId, askedAt: new Date().toISOString() });
        console.log(`[imessage] <- (new person ${handle.slice(-4)} in group) ${text.slice(0, 80)}`);
        const ask = people.askInGroup(handle);
        record(key, text, ask, people.prettyPhone(handle));
        return reply(chatId, ask);
      }
      if (!person.name && person.askedIn === chatId && person.askedAt && Date.now() - Date.parse(person.askedAt) < 30 * 60_000) {
        // Beast asked who they are: this might be the answer.
        const found = await people.extractName(text, people.prettyPhone(handle));
        if (found) {
          global.upsertPerson(handle, { name: found });
          const done = people.gotItInGroup(found);
          record(key, text, done, found);
          return reply(chatId, done);
        }
      }
    }

    // Someone else answers "wait who's …?" ("thats oli").
    for (const p of people.pendingInGroup(chatId).filter((p) => normalize(p.handle) !== normalize(handle))) {
      const found = await people.extractName(text, people.prettyPhone(p.handle));
      if (!found) continue;
      global.upsertPerson(p.handle, { name: found });
      const done = people.gotItInGroup(found);
      record(key, text, done, name ?? people.prettyPhone(handle));
      return reply(chatId, done);
    }

    // Group chats cost the owner's daily messages too.
    const quota = countMessage(owner);
    if (quota !== "ok") return;

    name ??= people.prettyPhone(handle);
    track(isOwner ? "group_message_own" : "group_message_other");
    const speaker = isOwner ? userSpeaker(owner) : otherSpeaker(name, owner);
    await converse(chatId, true, messageId, text, key, owner, speaker, name);
  });
}

// ---- the normal path: tapback (fast model), then the reply model ----

async function converse(
  chatId: string,
  isGroup: boolean,
  messageId: string,
  text: string,
  key: string,
  user: global.User,
  speaker: Speaker,
  senderName?: string,
) {
  // In a group Beast often stays quiet, so no typing bubble there (it would show and then nothing comes).
  const typing = isGroup ? { stop() {} } : keepTyping(chatId);
  try {
    // Tapback first, so the reply model knows exactly what reaction went on the message.
    const tapback = await pickEmoji(text);
    if (tapback) {
      track("tapback");
      linq.reactWithEmoji(messageId, tapback).catch((err) => console.error("[imessage] tapback failed:", err.message));
    }

    const answer = await runAgent(key, "imessage", text, {
      speaker,
      tapback,
      ...(isGroup ? { group: { senderName: senderName ?? "someone" } } : {}),
    });
    if (answer === null) return void console.log("[imessage] -> (stayed quiet in the group)");
    await reply(chatId, answer);
  } catch (err) {
    console.error("[imessage] reply failed:", err instanceof Error ? err.message : err);
    // Never drop an error into a group chat. In a 1:1, say so at most once an hour instead of going silent.
    if (isGroup) return;
    const last = global.getUser(user.id)?.outageNoticeAt[chatId];
    if (last && Date.now() - Date.parse(last) < 3600_000) return;
    global.updateUser(user.id, { outageNoticeAt: { ...user.outageNoticeAt, [chatId]: new Date().toISOString() } });
    await linq.sendText(chatId, OUTAGE_LINE).catch(() => {});
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
