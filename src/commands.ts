// Text commands, handled without the reply model. Only in a user's own 1:1 chat.
// Everyone: invite, feedback <text>, delete my data, new dashboard link, connect canvas, disconnect canvas.
// Owner: /invite [note], /users, /pause <name>, /unpause <name>, /spend, /stats, /model <name> <sonnet|opus>, /feedback.
import { purgeUserFromBackups } from "./backups.js";
import { MODELS } from "./config.js";
import { removeConnection } from "./connections.js";
import * as global from "./globalStore.js";
import { calendarUrl, dashboardUrl, inviteUrl } from "./links.js";
import { summarize, track } from "./metrics.js";
import { canvasOffer } from "./onboarding.js";
import { plainPhone } from "./people.js";
import { randomToken } from "./secrets.js";
import * as store from "./store.js";
import { withUser } from "./userContext.js";

const CONFIRM_WINDOW_MS = 10 * 60_000;

/** Returns the reply, or null if the text isn't a command. Runs inside withUser(user.id). */
export async function handleCommand(user: global.User, text: string): Promise<string | null> {
  const t = text.trim();

  // ---- delete my data (two steps) ----
  if (/^delete my data[.!]?$/i.test(t)) {
    global.updateUser(user.id, { pendingDeleteAt: new Date().toISOString() });
    return 'this wipes everything i have on u: assignments, chats, what i remember, ur connections. cant undo it. reply DELETE to confirm';
  }
  if (t === "DELETE" && user.pendingDeleteAt && Date.now() - Date.parse(user.pendingDeleteAt) < CONFIRM_WINDOW_MS) {
    if (user.role === "owner") return "ur the owner, i cant delete u. do it on the server if u really mean it";
    store.deleteCurrentUserData();
    global.removeUser(user.id);
    void purgeUserFromBackups(user.id).catch((err) => console.error("[backups] purge failed:", err instanceof Error ? err.message : err));
    console.log("[commands] a user deleted their data");
    return "done. everything's gone. if u ever want back in, u'll need a new invite 🫡";
  }
  if (user.pendingDeleteAt) global.updateUser(user.id, { pendingDeleteAt: null });

  // ---- feedback ----
  const fb = t.match(/^feedback[:\s]+([\s\S]+)/i);
  if (fb) {
    global.addFeedback(user.id, fb[1], "command");
    track("feedback");
    return "got it, passing that straight to the guy who built me 🙏";
  }

  // ---- invites: the user's own reusable link (a friend enters their number on the page) ----
  if (/^(invite|send (an |me an )?invite|invite link|get an invite)( link)?[.!?]?$/i.test(t)) {
    if (user.role !== "owner" && user.invitesLeft <= 0) return "ur out of invites for now";
    const { invite, joined } = global.personalInvite(user.id);
    track("invite");
    const link = inviteUrl(invite.code);
    const left = user.role === "owner" ? "" : ` (${user.invitesLeft} left)`;
    return link ? `here's ur invite link${left}, send it to whoever: ${link}` + (joined ? `\n${joined} joined so far` : "") : `they text me "join ${invite.code}"`;
  }

  // ---- links and connections ----
  if (/^new (dashboard|board) link[.!]?$/i.test(t)) {
    const updated = global.updateUser(user.id, { dashboardSlug: randomToken(24) });
    track("dashboard_rotated");
    const link = dashboardUrl(updated);
    return link ? `new link, the old one's dead now: ${link}` : "new link's set, but the site's down rn. ask me in a bit";
  }
  if (/^new (calendar|cal) (link|feed)[.!]?$/i.test(t)) {
    const updated = global.updateUser(user.id, { calendarSlug: randomToken(24), offeredAt: { ...user.offeredAt, calendar_fetch: "" } });
    track("calendar_rotated");
    const link = calendarUrl(updated);
    return link
      ? `new calendar link, the old one stopped working. tap to subscribe again: ${link.replace(/^https?:/, "webcal:")}`
      : "new link's set, but the site's down rn. ask me in a bit";
  }
  if (/^(connect|link|hook up|reconnect) canvas[.!]?$/i.test(t)) {
    track("connect_canvas_requested");
    return canvasOffer(user.id);
  }
  if (/^disconnect canvas[.!]?$/i.test(t)) {
    removeConnection("canvas");
    removeConnection("canvas_ics");
    track("disconnect_canvas");
    return "canvas disconnected and ur token's deleted on my end. u can also revoke it in canvas under account > settings";
  }

  if (user.role === "owner" && t.startsWith("/")) return ownerCommand(t);
  return null;
}

/**
 * Makes a one-use signup link. The friend enters their name and number on the page, which adds them as a
 * Linq contact and burns the link; it expires in 14 days (a user's unused invite is refunded then).
 */
function createInviteLink(user: global.User, note = ""): string {
  const invite = global.createInvite(user.id, note);
  if (user.role !== "owner") global.updateUser(user.id, { invitesLeft: user.invitesLeft - 1 });
  track("invite");
  const link = inviteUrl(invite.code);
  return link
    ? `here's ur invite, send it to them. it works once and lasts 2 weeks: ${link}`
    : `here's ur invite code, it works once: they text me "join ${invite.code}"`;
}

function findUser(query: string): global.User[] {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  return global
    .listUsers()
    .filter((u) => (u.name && u.name.toLowerCase() === q) || (digits.length >= 4 && u.handle.replace(/\D/g, "").endsWith(digits)));
}

function one(query: string): global.User | string {
  const matches = findUser(query);
  if (!matches.length) return `no user called ${query.trim()}. /users shows everyone`;
  if (matches.length > 1) return `a few match, use the number:\n${matches.map((u) => `${u.name ?? "?"} ${plainPhone(u.handle)}`).join("\n")}`;
  return matches[0];
}

async function ownerCommand(t: string): Promise<string> {
  const m = t.match(/^\/(\w+)\s*(.*)$/s);
  if (!m) return "commands: /invite [note], /users, /pause <name>, /unpause <name>, /spend, /stats, /model <name> <sonnet|opus>, /feedback";
  const [, cmd, arg] = m;

  if (cmd === "invite") return createInviteLink(global.owner()!, arg.trim());
  if (cmd === "users") {
    return (
      global
        .listUsers()
        .map((u) => {
          const s = withUser(u.id, () => summarize(7));
          const conn = withUser(u.id, () => store.listConnectionKinds().join("+") || "none");
          return `${u.name ?? "?"} ${plainPhone(u.handle)}, ${u.status}, canvas: ${conn}, $${s.cost.toFixed(2)}/7d, invites left ${u.invitesLeft}`;
        })
        .join("\n") || "no users yet"
    );
  }
  if (cmd === "pause" || cmd === "unpause") {
    const u = one(arg);
    if (typeof u === "string") return u;
    if (u.role === "owner") return "cant pause the owner";
    global.updateUser(u.id, { status: cmd === "pause" ? "paused" : "active" });
    return `${u.name ?? plainPhone(u.handle)} ${cmd === "pause" ? "paused, i'll ignore them" : "unpaused"}`;
  }
  if (cmd === "spend") {
    let total = 0;
    const lines = global.listUsers().map((u) => {
      const s = withUser(u.id, () => summarize(7));
      const today = withUser(u.id, () => summarize(1));
      total += s.cost;
      return `${u.name ?? "?"}: $${today.cost.toFixed(2)} today, $${s.cost.toFixed(2)} 7d (${s.calls} calls)`;
    });
    return [...lines, `total 7d: $${total.toFixed(2)}`].join("\n");
  }
  if (cmd === "stats") return statsText();
  if (cmd === "model") {
    const [who, which] = [arg.replace(/\s+\S+$/, ""), arg.trim().split(/\s+/).pop()?.toLowerCase()];
    if (!who || !which || !["sonnet", "opus"].includes(which)) return "usage: /model <name> <sonnet|opus>";
    const u = one(who);
    if (typeof u === "string") return u;
    global.updateUser(u.id, { model: which === "opus" ? MODELS.replyStrong : MODELS.reply });
    return `${u.name ?? "?"} is on ${which} now`;
  }
  if (cmd === "feedback") {
    const items = global.listFeedback().slice(0, 15);
    return items.length
      ? items.map((f) => `${global.getUser(f.userId)?.name ?? "?"} (${f.at.slice(5, 10)}): ${f.text}`).join("\n")
      : "no feedback yet";
  }
  return "commands: /invite [note], /users, /pause <name>, /unpause <name>, /spend, /stats, /model <name> <sonnet|opus>, /feedback";
}

/** Which features got used in the last 7 days, by how many users, and what nobody touched. */
export function statsText(): string {
  const users = global.listUsers();
  const byFeature: Record<string, { uses: number; users: number }> = {};
  for (const u of users) {
    const { features } = withUser(u.id, () => summarize(7));
    for (const [k, v] of Object.entries(features)) {
      const f = (byFeature[k] ??= { uses: 0, users: 0 });
      f.uses += v;
      f.users += 1;
    }
  }
  const KNOWN = ["message", "tool:add_assignment", "tool:list_assignments", "tool:update_assignment", "tool:remember", "dashboard_open", "dashboard_link_sent", "connect_canvas_done", "invite", "feedback", "brief_reply"];
  const used = Object.entries(byFeature)
    .sort((a, b) => b[1].uses - a[1].uses)
    .map(([k, v]) => `${k}: ${v.uses} (${v.users} users)`);
  const unused = KNOWN.filter((k) => !byFeature[k]);
  const fb = global.listFeedback().slice(0, 3).map((f) => `"${f.text.slice(0, 80)}"`);
  return [
    `last 7 days, ${users.length} users`,
    ...used.slice(0, 20),
    unused.length ? `nobody used: ${unused.join(", ")}` : "",
    fb.length ? `latest feedback: ${fb.join(" / ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
