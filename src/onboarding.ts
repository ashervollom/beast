// Invite-only access and the first few texts with a new user. The copy here is placeholder: edit freely.
import { config } from "./config.js";
import * as global from "./globalStore.js";
import { extractName } from "./people.js";
import { connectUrl, publicBase } from "./links.js";
import { track } from "./metrics.js";
import * as store from "./store.js";
import { withUser } from "./userContext.js";

// ---- copy (placeholder; rewrite in Beast's voice) ----

export const NOT_INVITED = () =>
  `yo, i'm beast. i'm invite only rn${publicBase() ? `, get on the list at ${publicBase()}` : ""}`;
export const INVITE_USED = "that invite's already been used, ask whoever sent it for a fresh one";
export const INTRO = "yooo welcome in. i'm beast, ur school sidekick. what should i call u?";
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

const JOIN = /\bjoin\s+([a-z0-9]{6,12})\b/i;

/**
 * A 1:1 text from a number that isn't a user. Returns the reply to send, or null for silence
 * (uninvited numbers hear back once, then nothing, so they cost nothing).
 */
export function handleStranger(handle: string, chatId: string, text: string): { reply: string; userId?: string } | null {
  const code = text.match(JOIN)?.[1]?.toLowerCase();
  const invite = code ? global.getInvite(code) : undefined;
  if (invite && invite.usedBy) return { reply: INVITE_USED };
  if (invite) {
    const inviter = global.getUser(invite.createdBy);
    const user = global.createUser({ handle, invitedBy: invite.createdBy });
    global.useInvite(invite.code, user.id);
    withUser(user.id, () => store.updateSettings({ chatId, lastMessageAt: new Date().toISOString() }));
    console.log(`[onboarding] new user via ${inviter?.name ?? "an invite"}'s invite`);
    // The owner hears about it in their next brief, not as a standalone text.
    const own = global.owner();
    if (own && own.id !== user.id) {
      withUser(own.id, () => store.holdNotice(`someone new joined beast with ${inviter?.name ?? "an"}'s invite (${handle.slice(-4)})`));
    }
    withUser(user.id, () => track("onboarding_started"));
    return { reply: INTRO, userId: user.id };
  }
  if (global.uninvitedRepliedAt(handle)) return null;
  global.markUninvitedReplied(handle);
  return { reply: NOT_INVITED() };
}

/** Next onboarding step for a user who hasn't finished. Returns the texts to send, in order. */
export async function continueOnboarding(user: global.User, text: string): Promise<string[]> {
  if (user.onboardingStep === "name") {
    const name = await extractName(text, "this new user");
    if (!name) return [ASK_NAME_AGAIN];
    global.updateUser(user.id, { name, onboardingStep: "school" });
    return [ASK_SCHOOL(name)];
  }
  // School: free text. UCI is the only school with a specialized setup for now.
  const school = /\b(uci|uc irvine|irvine)\b/i.test(text) ? "UC Irvine" : text.trim().slice(0, 80);
  global.updateUser(user.id, { school, status: "active", onboardingStep: null, offeredAt: { canvas: new Date().toISOString() } });
  withUser(user.id, () => track("onboarding_finished"));
  return [WHAT_I_DO, canvasOffer(user.id)];
}

export const isDefaultSchool = (u: global.User) => u.school === "UC Irvine";

/** Canvas host to suggest on the connect page. */
export const suggestedCanvasHost = (u: global.User) => (isDefaultSchool(u) ? config.defaultCanvasBaseUrl : "");
