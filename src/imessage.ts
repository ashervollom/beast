import type { Request, Response } from "express";
import { config } from "./config.js";
import { pickEmoji } from "./emoji.js";
import { runAgent, STUDENT, type Speaker } from "./agent.js";
import * as guests from "./guests.js";
import * as linq from "./linq.js";
import { sendToChat } from "./notify.js";
import { notifyGuestJoined } from "./proactive.js";
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

const normalize = store.normalizeHandle;

function isAllowed(handle: string): boolean {
  if (config.linq.allowedHandles.length === 0) return true;
  return config.linq.allowedHandles.some((h) => normalize(h) === normalize(handle));
}

export interface Sender {
  handle: string;
  log: string;
  isStudent: boolean;
  speaker: Speaker;
  guest?: store.Guest;
}

/** Who's texting: the student (full access) or a guest (read-only; may not exist yet). */
export function whoIs(handle: string): Sender {
  const { studentName, studentHandle } = config.linq;
  if (studentHandle && normalize(studentHandle) === normalize(handle)) {
    return { handle, log: studentName, isStudent: true, speaker: STUDENT };
  }
  const guest = store.getGuest(handle);
  const speaker = guest
    ? guests.guestSpeaker(guest)
    : guests.guestSpeaker({ handle, name: null } as store.Guest);
  return { handle, log: guest?.name ?? handle, isStudent: false, speaker, guest };
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

  handleInbound(msg.chat.id, msg.chat.is_group, msg.id, text, whoIs(msg.sender_handle.handle)).catch((err) =>
    console.error("[imessage] handler failed:", err),
  );
}

/** Saves an exchange Beast handled without the reply model (onboarding), so later replies have the context. */
function record(conversationKey: string, isGroup: boolean, sender: Sender, text: string, reply: string) {
  store.appendTurn(conversationKey, { role: "user", text, ...(isGroup ? { from: sender.log } : {}) });
  store.appendTurn(conversationKey, { role: "assistant", text: reply });
}

async function reply(chatId: string, text: string) {
  console.log(`[imessage] -> ${text}`);
  await linq.sendText(chatId, text);
  await shareCardOnce(chatId);
}

/** After Beast's first message in a chat, shares its contact card there (name + photo) once. */
async function shareCardOnce(chatId: string) {
  const key = `imessage:${chatId}`;
  if (store.cardSharedIn(key)) return;
  try {
    await linq.shareContactCard(chatId);
    store.recordCardShared(key);
    console.log(`[imessage] shared contact card in ${chatId}`);
  } catch (err) {
    // Not fatal (e.g. an SMS chat or no card yet). It's tried again after Beast's next message there.
    console.warn("[imessage] contact card share failed:", err instanceof Error ? err.message : err);
  }
}

async function handleInbound(chatId: string, isGroup: boolean, messageId: string, text: string, sender: Sender) {
  const conversationKey = `imessage:${chatId}`;

  // ---- Asher ----
  if (sender.isStudent) {
    // Notifications only ever go to the student's own 1:1 chat, never a group chat.
    store.updateSettings({ lastStudentMessageAt: new Date().toISOString(), ...(isGroup ? {} : { studentChatId: chatId }) });
    if (!isGroup) {
      const commandReply = guests.handleCommand(text);
      if (commandReply) return reply(chatId, commandReply);
    }
  }

  // ---- guests ----
  let guest = sender.guest;
  if (!sender.isStudent) {
    if (guest?.status === "blocked") return; // silently ignored, not even saved
    if (!guest) {
      // First time Beast has heard from this number: ask who they are, no reply model.
      // Their text is held so it can still be answered once Beast has their name.
      guest = store.createGuest(sender.handle, {
        askedIn: chatId,
        askedAt: new Date().toISOString(),
        askCount: 1,
        pendingAsk: { text, messageId },
      });
      guests.countMessage(guest);
      console.log(`[imessage] <- (new guest ${sender.handle}) ${text}`);
      // In a group, their first text may be naming someone else Beast is waiting on ("thats maya").
      const named = isGroup ? await nameSomeoneElse(chatId, sender, text) : null;
      if (named) store.updateGuest(guest.handle, { pendingAsk: null }); // it was an answer, not a question
      const ask = !isGroup
        ? guests.INTRO_1TO1
        : named
          ? guests.gotItAndAskInGroup(named.name!, sender.handle)
          : guests.askInGroup(sender.handle, guests.pendingInGroup(chatId).some((g) => normalize(g.handle) !== normalize(sender.handle)));
      record(conversationKey, isGroup, sender, text, ask);
      await reply(chatId, ask);
      if (named) await answerPendingAsk(chatId, isGroup, named);
      return;
    }
    const quota = guests.countMessage(guest);
    if (quota !== "ok") {
      if (quota === "limit" && !isGroup) await reply(chatId, guests.TAPPED_OUT);
      return;
    }
    if (guest.status === "new") {
      // Beast asked who they are: this should be the answer.
      const name = await guests.extractName(text, guests.prettyPhone(guest.handle));
      if (name) {
        guest = store.updateGuest(guest.handle, { name, status: "active" });
        sender = { ...sender, log: name, guest, speaker: guests.guestSpeaker(guest) };
        // If their first text asked something, answer it next (and skip the 1:1 "ask me…" tip).
        const asked = guest.pendingAsk && (await guests.isRealAsk(guest.pendingAsk.text));
        if (!asked) store.updateGuest(guest.handle, { pendingAsk: null });
        const done = isGroup ? guests.gotItInGroup(name) : asked ? guests.gotIt1to1(name) : guests.AFTER_NAME_1TO1;
        record(conversationKey, isGroup, sender, text, done);
        await reply(chatId, done);
        if (!isGroup) await announceGuest(guest);
        if (asked) await answerPendingAsk(chatId, isGroup, guest, true);
        return;
      }
      if (!isGroup && guest.askCount < 2) {
        store.updateGuest(guest.handle, { askCount: guest.askCount + 1 });
        record(conversationKey, isGroup, sender, text, guests.ASK_AGAIN_1TO1);
        return reply(chatId, guests.ASK_AGAIN_1TO1);
      }
      // Still no name: stop asking and just talk to them.
      guest = store.updateGuest(guest.handle, { status: "active", pendingAsk: null });
      sender = { ...sender, guest, speaker: guests.guestSpeaker(guest) };
    }
    if (!isGroup && !guest.notified) await announceGuest(guest);
  }

  // ---- someone else answers "wait who's …?" in a group ("thats oli") ----
  if (isGroup) {
    const named = await nameSomeoneElse(chatId, sender, text);
    if (named) {
      const done = guests.gotItInGroup(named.name!);
      record(conversationKey, isGroup, sender, text, done);
      await reply(chatId, done);
      return answerPendingAsk(chatId, isGroup, named);
    }
  }

  await converse(chatId, isGroup, messageId, text, sender, conversationKey);
}

/** Group: if this text names a guest Beast asked about ("thats oli"), saves the name and returns that guest. */
async function nameSomeoneElse(chatId: string, sender: Sender, text: string): Promise<store.Guest | null> {
  const pending = guests.pendingInGroup(chatId).filter((g) => normalize(g.handle) !== normalize(sender.handle));
  const from = sender.guest?.name ?? guests.prettyPhone(sender.handle);
  for (const g of pending) {
    const name = await guests.extractName(text, guests.prettyPhone(g.handle), from);
    if (name) return store.updateGuest(g.handle, { name, status: "active" });
  }
  return null;
}

/** Answers the first text a guest sent before Beast knew who they were, if it asked something. */
async function answerPendingAsk(chatId: string, isGroup: boolean, guest: store.Guest, knownAsk = false) {
  const ask = guest.pendingAsk;
  store.updateGuest(guest.handle, { pendingAsk: null });
  if (!ask || !(knownAsk || (await guests.isRealAsk(ask.text)))) return;
  await converse(chatId, isGroup, ask.messageId, ask.text, whoIs(guest.handle), `imessage:${chatId}`);
}

/** Texts Asher once when a guest starts talking to Beast one-on-one. */
async function announceGuest(guest: store.Guest) {
  store.updateGuest(guest.handle, { notified: true });
  await notifyGuestJoined(`${guest.name ?? "someone"} (${guests.plainPhone(guest.handle)}) just started texting me.`);
}

/** The normal path: tapback (fast model), then the reply model. */
async function converse(chatId: string, isGroup: boolean, messageId: string, text: string, sender: Sender, conversationKey: string) {
  console.log(`[imessage] <- (${sender.log}) ${text}`);
  // In a group Beast often stays quiet, so no typing bubble there (it would show and then nothing comes).
  const typing = isGroup ? { stop() {} } : keepTyping(chatId);
  try {
    // Tapback first, so the reply model knows exactly what reaction went on the message.
    const tapback = await pickEmoji(text);
    console.log(`[imessage] tapback ${tapback ?? "none"}`);
    if (tapback) {
      linq.reactWithEmoji(messageId, tapback).catch((err) => console.error("[imessage] tapback failed:", err.message));
    }

    const answer = await runAgent(conversationKey, "imessage", text, {
      speaker: sender.speaker,
      tapback,
      ...(isGroup ? { group: { senderName: sender.log } } : {}),
    });
    if (answer === null) return void console.log("[imessage] -> (stayed quiet in the group)");
    await reply(chatId, answer);
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
