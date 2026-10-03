// Invite-only access and the first few texts with a new user. The copy here is placeholder: edit freely.
import { config } from "./config.js";
import { getSchool } from "./schoolDiscovery.js";
import { learnSchool } from "./schoolLearning.js";
import * as global from "./globalStore.js";
import { extractName } from "./people.js";
import { connectUrl, publicBase } from "./links.js";
import { ensureContact, toE164 } from "./linqContacts.js";
import { track } from "./metrics.js";
import * as store from "./store.js";
import { withUser } from "./userContext.js";

// ---- copy (placeholder; rewrite in Beast's voice) ----

export const NOT_INVITED = () =>
  `yo, i'm beast. i'm invite only rn${publicBase() ? `, get on the list at ${publicBase()}` : ""}`;
export const INVITE_USED = "that invite's already been used, ask whoever sent it for a fresh one";
export const INVITE_EXPIRED = "that invite expired, ask whoever sent it for a fresh one";
export const INTRO = "yooo welcome in. i'm beast, ur school sidekick. what should i call u?";
export const WELCOME = (name: string) => `yooo ${name.toLowerCase()}, welcome in. i'm beast, ur school sidekick. what school u at?`;
export const ASK_NAME_AGAIN = "didnt catch ur name, what should i call u?";
export const ASK_SCHOOL = (name: string) => `${name.toLowerCase()}, bet. what school u at?`;
export const WHAT_I_DO = [
  "here's the deal:",
  "📝 text me anything due and i'll track it, remind u, and plan around ur life",
  "🔎 connect canvas and i'll pull every assignment and keep tabs on it",
  "📊 u get ur own board too, just ask for it",
].join("\n");

/** The Canvas offer, with a one-time connect link. */
export function canvasOffer(userId: string): string {
  const link = connectUrl(global.createConnectToken(userId, "canvas"));
  return link
    ? `wanna hook up canvas? takes 2 min: ${link}\n(or say skip, u can do it whenever)`
    : `wanna hook up canvas? text "connect canvas" whenever and i'll send a link`;
}

// ---- joining ----

export type JoinResult =
  | { ok: true; user: global.User }
  | { ok: false; reason: "used" | "expired" | "missing" | "bad_phone" | "already_user" | "full" | "error" };

/**
 * Turns an invite into a user, in order: invite still valid → number is a real US number and not already a
 * user → number added as a Linq contact (texts from non-contacts never reach Beast) → user created → invite
 * burned. Used by the /join/<code> page and by the "join <code>" text fallback.
 */
export async function joinWithInvite(code: string, phoneInput: string, name: string | null, opts: { skipContact?: boolean } = {}): Promise<JoinResult> {
  const state = global.inviteState(code);
  if (state !== "ok") return { ok: false, reason: state };
  const handle = toE164(phoneInput);
  if (!handle) return { ok: false, reason: "bad_phone" };
  if (global.getUserByHandle(handle)) return { ok: false, reason: "already_user" };

  if (!opts.skipContact) {
    try {
      if ((await ensureContact(handle)) === "full") return { ok: false, reason: "full" };
    } catch (err) {
      console.error("[onboarding] adding contact failed:", err instanceof Error ? err.message : err);
      return { ok: false, reason: "error" };
    }
  }

  const invite = global.getInvite(code)!;
  const cleanName = name?.trim().slice(0, 40) || null;
  const user = global.createUser({ handle, name: cleanName, invitedBy: invite.createdBy, onboardingStep: cleanName ? "welcome" : "name" });
  if (!global.redeemInvite(code, user.id)) {
    // Someone else got there in the same instant: undo.
    global.removeUser(user.id);
    return { ok: false, reason: "used" };
  }

  const inviter = global.getUser(invite.createdBy);
  console.log(`[onboarding] new user via ${inviter?.name ?? "an invite"}'s invite`);
  const own = global.owner();
  if (own && own.id !== user.id) {
    // The owner hears about it in their next brief, not as a standalone text.
    withUser(own.id, () => store.holdNotice(`${cleanName ?? "someone new"} joined beast with ${inviter?.name ?? "an"}'s invite`));
  }
  withUser(user.id, () => track("onboarding_started"));
  return { ok: true, user };
}

const JOIN = /\bjoin\s+([a-z0-9]{6,16})\b/i;

/**
 * A 1:1 text from a number that isn't a user. Returns the reply to send, or null for silence
 * (uninvited numbers hear back once, then nothing, so they cost nothing).
 */
export async function handleStranger(handle: string, chatId: string, text: string): Promise<{ reply: string; userId?: string } | null> {
  const code = text.match(JOIN)?.[1];
  if (code) {
    // They're texting, so they're already a Linq contact.
    const result = await joinWithInvite(code, handle, null, { skipContact: true });
    if (result.ok) {
      withUser(result.user.id, () => store.updateSettings({ chatId, lastMessageAt: new Date().toISOString() }));
      return { reply: INTRO, userId: result.user.id };
    }
    if (result.reason === "used") return { reply: INVITE_USED };
    if (result.reason === "expired") return { reply: INVITE_EXPIRED };
  }
  if (global.uninvitedRepliedAt(handle)) return null;
  global.markUninvitedReplied(handle);
  return { reply: NOT_INVITED() };
}

/** Next onboarding step for a user who hasn't finished. Returns the texts to send, in order. */
export async function continueOnboarding(user: global.User, text: string): Promise<string[]> {
  if (user.onboardingStep === "welcome") {
    // Signed up on the website with their name; this is their first text.
    global.updateUser(user.id, { onboardingStep: "school" });
    return [WELCOME(user.name ?? "")];
  }
  if (user.onboardingStep === "name") {
    const name = await extractName(text, "this new user");
    if (!name) return [ASK_NAME_AGAIN];
    global.updateUser(user.id, { name, onboardingStep: "school" });
    return [ASK_SCHOOL(name)];
  }
  const school = normalizeSchool(text);
  global.updateUser(user.id, { school, status: "active", onboardingStep: null, offeredAt: { ...user.offeredAt, canvas: new Date().toISOString() } });
  withUser(user.id, () => track("onboarding_finished"));
  // A school Beast hasn't seen: research it in the background while onboarding finishes.
  void learnSchool(school);
  return [WHAT_I_DO, canvasOffer(user.id)];
}

/** "uci" / "UC Irvine" -> "UC Irvine"; anything else kept as typed (school discovery learns it). */
export function normalizeSchool(text: string): string {
  if (/\b(uci|uc irvine|irvine)\b/i.test(text)) return "UC Irvine";
  return text.trim().replace(/^(i go to|i'm at|im at|at)\s+/i, "").slice(0, 80);
}

export const isDefaultSchool = (u: global.User) => u.school === "UC Irvine";

/** Canvas host to suggest on the connect page. */
export const suggestedCanvasHost = (u: global.User) =>
  getSchool(u.school)?.canvasHost ?? (isDefaultSchool(u) ? config.defaultCanvasBaseUrl : "");
