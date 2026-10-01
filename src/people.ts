// Non-users Beast meets in its users' group chats. Beast asks "wait who's (555) 555-0123?" once and
// learns their first name, so group messages are labelled by name. They don't get their own Beast
// until they're invited.
import Anthropic from "@anthropic-ai/sdk";
import { config, MODELS } from "./config.js";
import { loadPrompt } from "./prompts.js";
import * as global from "./globalStore.js";
import { recordUsage } from "./metrics.js";

const client = new Anthropic();
/** In a group, messages from others within this window are checked for the pending person's name. */
const GROUP_NAME_WINDOW_MS = 30 * 60_000;

export const askInGroup = (handle: string) => `wait who's ${prettyPhone(handle)}?`;
export const gotItInGroup = (name: string) => `got it, ${name.toLowerCase()} 🤝`;

/** "+15555550123" → "(555) 555-0123" */
export function prettyPhone(handle: string): string {
  const m = handle.replace(/\D/g, "").match(/^1?(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : handle;
}

/** "+15555550123" → "555-555-0123", for lists */
export function plainPhone(handle: string): string {
  const m = handle.replace(/\D/g, "").match(/^1?(\d{3})(\d{3})(\d{4})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : handle;
}

/** A known non-user's name, or undefined. */
export const getPersonName = (handle: string) => global.getPerson(handle)?.name ?? undefined;

/** People named in HANDLE_LABELS start out known by name. */
export function seedPeopleFromConfig() {
  for (const [handle, name] of Object.entries(config.linq.handleLabels)) {
    if (!global.getPerson(handle)?.name) global.upsertPerson(handle, { name });
  }
}

/** People Beast asked about in this group chat recently and is still waiting on a name for. */
export function pendingInGroup(chatId: string, now = new Date()): global.Person[] {
  return global
    .listPeople()
    .filter((p) => !p.name && p.askedIn === chatId && p.askedAt && now.getTime() - Date.parse(p.askedAt) < GROUP_NAME_WINDOW_MS);
}

/** Fast model: first name from a reply to "who's this?", or null. */
export async function extractName(reply: string, about: string): Promise<string | null> {
  try {
    const res = await client.messages.create({
      model: MODELS.fast,
      max_tokens: 16,
      system: loadPrompt("name"),
      messages: [{ role: "user", content: `Beast asked who ${about} is.\nReply: ${reply.slice(0, 500)}` }],
    });
    recordUsage(MODELS.fast, res.usage);
    const text = (res.content.find((b) => b.type === "text")?.text ?? "").trim();
    return /^[A-Za-z][A-Za-z'-]{0,20}$/.test(text) && text.toUpperCase() !== "NONE" ? text[0].toUpperCase() + text.slice(1) : null;
  } catch (err) {
    console.error("[people] name extraction failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
