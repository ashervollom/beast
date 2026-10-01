// Guests: anyone other than Asher who texts Beast. They get a quick "who's this?" onboarding, then talk to
// Beast about Asher's (read-only) schoolwork. No per-guest data beyond a name and a daily message count.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { loadPrompt } from "./prompts.js";
import { localDay } from "./snapshot.js";
import * as store from "./store.js";
import type { Speaker } from "./agent.js";

const client = new Anthropic();
export const DAILY_LIMIT = 50;
/** In a group, messages from others within this window are checked for the pending guest's name. */
const GROUP_NAME_WINDOW_MS = 30 * 60_000;

export const INTRO_1TO1 = "yo, i'm beast, asher's school assistant. who's this?";
export const AFTER_NAME_1TO1 = "sweet, ask me what asher's got due this week.";
export const ASK_AGAIN_1TO1 = "didnt catch ur name, what should i call u?";
export const TAPPED_OUT = "im tapped out for today, catch u tmrw";

// Varied onboarding lines live in prompts/onboarding.md ("## Heading" sections of "- " lines).
// One is picked at random each time; the defaults here cover a missing or emptied section.
function line(section: string, fallback: string, vars: { name?: string; handle?: string }): string {
  const md = loadPrompt("onboarding", { optional: true });
  const start = md.indexOf(`## ${section}`);
  const body = start < 0 ? "" : md.slice(start).split("\n").slice(1).join("\n").split(/^## /m)[0];
  const options = body.split("\n").map((l) => l.match(/^\s*-\s+(.+)$/)?.[1]?.trim()).filter((l): l is string => Boolean(l));
  const pick = options.length ? options[Math.floor(Math.random() * options.length)] : fallback;
  return pick.replaceAll("{name}", vars.name?.toLowerCase() ?? "").replaceAll("{number}", vars.handle ? prettyPhone(vars.handle) : "");
}

/** Group: one new number ("wait who's (555) …?"), or "who's everyone?" when others are still unnamed too. */
export const askInGroup = (handle: string, others = false) =>
  others
    ? line("Who's everyone (group, more than one new number)", "who's everyone?", { handle })
    : line("Who's this (group, one new number)", "wait who's {number}?", { handle });
export const gotItInGroup = (name: string) => line("Got it (group)", "got it, {name} 🤝", { name });
/** 1:1, when they'd already asked something: skip the "ask me…" tip and just answer it next. */
export const gotIt1to1 = (name: string) => line("Got it (1:1, they already asked something)", "bet, {name} 🤝", { name });
/** A new number's first text in a group named someone else Beast was waiting on. */
export const gotItAndAskInGroup = (name: string, handle: string) =>
  line("Got it, and who's the new number (group, someone named a friend in their first text)", "got it, {name} 🤝 and who's {number}?", { name, handle });

/** "+15555550123" → "(555) 555-0123" */
export function prettyPhone(handle: string): string {
  const m = handle.replace(/\D/g, "").match(/^1?(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : handle;
}

/** "+15555550123" → "555-555-0123", for lists and notices */
export function plainPhone(handle: string): string {
  const m = handle.replace(/\D/g, "").match(/^1?(\d{3})(\d{3})(\d{4})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : handle;
}

/** People named in HANDLE_LABELS (e.g. Royce) start out as named, active guests, with no onboarding. */
export function seedGuestsFromConfig() {
  for (const [handle, name] of Object.entries(config.linq.handleLabels)) {
    if (!store.getGuest(handle)) store.createGuest(handle, { name, status: "active", notified: true });
  }
}

export function guestSpeaker(guest: store.Guest): Speaker {
  const who = guest.name ?? `an unnamed guest at ${prettyPhone(guest.handle)}`;
  return {
    talkingWith:
      `Talking with: ${who}, a guest. You're talking to ${guest.name ?? "them"}, a friend of Asher's, not Asher. ` +
      `Refer to "asher's" assignments. Be friendly and in your normal voice, but don't hype them like they're Asher.`,
    canEdit: false,
    pronoun: "their",
  };
}

export const displayName = (g: store.Guest) => g.name ?? prettyPhone(g.handle);

/** Counts a guest message. Returns "ok", "limit" (the first one over today's limit) or "over" (every one after). */
export function countMessage(guest: store.Guest, now = new Date()): "ok" | "limit" | "over" {
  const date = localDay(now);
  const count = guest.daily.date === date ? guest.daily.count + 1 : 1;
  store.updateGuest(guest.handle, { daily: { date, count } });
  return count <= DAILY_LIMIT ? "ok" : count === DAILY_LIMIT + 1 ? "limit" : "over";
}

/** Guests Beast asked about in this group chat recently and is still waiting on a name for. */
export function pendingInGroup(chatId: string, now = new Date()): store.Guest[] {
  return store
    .listGuests()
    .filter((g) => g.status === "new" && g.askedIn === chatId && g.askedAt && now.getTime() - Date.parse(g.askedAt) < GROUP_NAME_WINDOW_MS);
}

/**
 * Fast model: first name from a reply to "who's this?", or null. `from` is set when the reply comes from
 * someone other than the person asked about (a group answering for them).
 */
export async function extractName(reply: string, about: string, from?: string): Promise<string | null> {
  const asker = from
    ? `\nThis reply is from someone else, ${from}. If they're only introducing themselves ("im jake"), answer NONE.`
    : "";
  try {
    const res = await client.messages.create({
      model: config.emojiModel,
      max_tokens: 16,
      system: loadPrompt("name"),
      messages: [{ role: "user", content: `Beast asked who ${about} is.${asker}\nReply: ${reply.slice(0, 500)}` }],
    });
    const text = (res.content.find((b) => b.type === "text")?.text ?? "").trim();
    return /^[A-Za-z][A-Za-z'-]{0,20}$/.test(text) && text.toUpperCase() !== "NONE" ? text[0].toUpperCase() + text.slice(1) : null;
  } catch (err) {
    console.error("[guests] name extraction failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Fast model: is a new person's first text something Beast should still answer once it has their name? */
export async function isRealAsk(text: string): Promise<boolean> {
  try {
    const res = await client.messages.create({
      model: config.emojiModel,
      max_tokens: 4,
      system: loadPrompt("ask"),
      messages: [{ role: "user", content: text.slice(0, 500) }],
    });
    return /^yes/i.test((res.content.find((b) => b.type === "text")?.text ?? "").trim());
  } catch (err) {
    console.error("[guests] ask check failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

// ---- Asher's commands (1:1 chat only) ----

function findGuests(query: string): store.Guest[] {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  return store
    .listGuests()
    .filter((g) => (g.name && g.name.toLowerCase() === q) || (digits.length >= 4 && g.handle.replace(/\D/g, "").endsWith(digits)));
}

/** Handles /guests, /remove, /unblock and /forget. Returns the reply, or null if it isn't a command. */
export function handleCommand(text: string, now = new Date()): string | null {
  const m = text.trim().match(/^\/(\w+)\s*(.*)$/s);
  if (!m) return null;
  const [, cmd, arg] = m;
  const today = localDay(now);

  if (cmd === "guests") {
    const guests = store.listGuests();
    if (!guests.length) return "no guests yet";
    return guests
      .map((g) => {
        const state = g.status === "blocked" ? "blocked" : g.status === "new" ? "no name yet" : "active";
        const msgs = g.daily.date === today ? g.daily.count : 0;
        return `${g.name ?? "?"} ${plainPhone(g.handle)}, ${state}, ${msgs} msgs today`;
      })
      .join("\n");
  }

  if (cmd === "remove" || cmd === "unblock") {
    if (!arg.trim()) return `usage: /${cmd} <name or number>`;
    const matches = findGuests(arg);
    if (!matches.length) return `no guest called ${arg.trim()}. /guests shows everyone`;
    if (matches.length > 1) return `a few match, use the number:\n${matches.map((g) => `${g.name ?? "?"} ${plainPhone(g.handle)}`).join("\n")}`;
    const g = matches[0];
    if (cmd === "remove") {
      store.updateGuest(g.handle, { status: "blocked" });
      return `blocked ${displayName(g)} (${plainPhone(g.handle)}). they wont hear from me`;
    }
    store.updateGuest(g.handle, { status: g.name ? "active" : "new" });
    return `unblocked ${displayName(g)}`;
  }

  // Wipes every guest and every chat but Asher's own 1:1 (assignments stay). Asks first: it can't be undone.
  if (cmd === "forget") {
    const keepKey = `imessage:${store.getSettings().studentChatId}`;
    if (arg.trim().toLowerCase() !== "everyone") {
      const { guests, chats } = store.forgetPreview(keepKey);
      return `that forgets ${guests} people and ${chats} other chats (names and history), only our chat stays. cant undo it. text /forget everyone to do it`;
    }
    const { guests, chats } = store.forgetEveryoneExcept(keepKey);
    return `done, forgot ${guests} people and ${chats} chats. its just us now`;
  }

  return "commands: /guests, /remove <name or number>, /unblock <name or number>, /forget";
}
