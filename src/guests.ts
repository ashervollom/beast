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
export const askInGroup = (handle: string) => `wait who's ${prettyPhone(handle)}?`;
export const gotItInGroup = (name: string) => `got it, ${name.toLowerCase()} 🤝`;

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

/** Fast model: first name from a reply to "who's this?", or null. */
export async function extractName(reply: string, about: string): Promise<string | null> {
  try {
    const res = await client.messages.create({
      model: config.emojiModel,
      max_tokens: 16,
      system: loadPrompt("name"),
      messages: [{ role: "user", content: `Beast asked who ${about} is.\nReply: ${reply.slice(0, 500)}` }],
    });
    const text = (res.content.find((b) => b.type === "text")?.text ?? "").trim();
    return /^[A-Za-z][A-Za-z'-]{0,20}$/.test(text) && text.toUpperCase() !== "NONE" ? text[0].toUpperCase() + text.slice(1) : null;
  } catch (err) {
    console.error("[guests] name extraction failed:", err instanceof Error ? err.message : err);
    return null;
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

/** Handles /guests, /remove <name|number>, /unblock <name|number>. Returns the reply, or null if it isn't a command. */
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

  return "commands: /guests, /remove <name or number>, /unblock <name or number>";
}
