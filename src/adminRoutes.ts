// The data and actions behind the /admin page. Mounted under /api/admin, behind adminOnly.
import fs from "node:fs";
import path from "node:path";
import type { Request, Response, Router } from "express";
import { purgeUserFromBackups } from "./backups.js";
import { config, MODELS } from "./config.js";
import * as global from "./globalStore.js";
import { inviteUrl } from "./links.js";
import { CONTACT_LIMIT, listContacts } from "./linqContacts.js";
import { summarize } from "./metrics.js";
import { getSchool, type SchoolProfile } from "./schoolDiscovery.js";
import { localDay } from "./snapshot.js";
import * as store from "./store.js";
import { withUser } from "./userContext.js";

const KNOWN_FEATURES = [
  "message",
  "tapback",
  "tool:add_assignment",
  "tool:list_assignments",
  "tool:update_assignment",
  "tool:course_info",
  "tool:find_course_info",
  "tool:remember",
  "dashboard_open",
  "dashboard_link_sent",
  "calendar_fetch",
  "connect_canvas_done",
  "invite",
  "feedback",
  "group_message_own",
];

const messagesIn = (f: Record<string, number>) => (f.message ?? 0) + (f.group_message_own ?? 0) + (f.group_message_other ?? 0);

function userRow(u: global.User) {
  return withUser(u.id, () => {
    const week = summarize(7);
    const today = summarize(1);
    return {
      id: u.id,
      name: u.name,
      handleLast4: u.handle.slice(-4),
      role: u.role,
      status: u.status,
      school: u.school,
      model: u.model === MODELS.replyStrong ? "opus" : "sonnet",
      invitesLeft: u.invitesLeft,
      invitedBy: u.invitedBy ? (global.getUser(u.invitedBy)?.name ?? "someone") : null,
      createdAt: u.createdAt,
      lastActiveAt: u.lastActiveAt,
      connections: store.listConnectionKinds(),
      courses: Object.keys(store.getCourseProfiles()).length,
      messages7d: messagesIn(week.features),
      cost7d: week.cost,
      costToday: today.cost,
    };
  });
}

function inviteRow(i: global.Invite) {
  const state = global.inviteState(i.code);
  return {
    code: i.code,
    url: inviteUrl(i.code),
    note: i.note,
    createdBy: global.getUser(i.createdBy)?.name ?? "deleted user",
    createdAt: i.createdAt,
    expiresAt: i.expiresAt ?? null,
    status: state === "used" ? "used" : state === "expired" ? (i.refunded ? "refunded" : "expired") : "open",
    usedBy: i.usedBy ? (global.getUser(i.usedBy)?.name ?? "deleted user") : null,
  };
}

/** Ready-to-send text for an invite (email or text message). */
const inviteMessage = (url: string) =>
  `you're in. beast is a school sidekick that lives in iMessage: it tracks what's due, digs through your classes, and has your back before things sneak up.\n\nsign up here (the link works once): ${url}`;

function listSchools(): SchoolProfile[] {
  const dir = path.join(config.dataDir, "schools");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  const learned = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as SchoolProfile);
  const builtin = getSchool("UC Irvine");
  return [...(builtin ? [builtin] : []), ...learned];
}

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  // Leading = + - @ would run as a formula when opened in a spreadsheet (phone numbers like +1310... are fine).
  const safe = /^[=+\-@]/.test(s) && !/^\+\d{10,15}$/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function mountAdminRoutes(admin: Router) {
  admin.get("/overview", async (_req, res) => {
    const users = global.listUsers();
    let today = 0;
    let week = 0;
    let month = 0;
    let messages = 0;
    for (const u of users) {
      withUser(u.id, () => {
        today += summarize(1).cost;
        const w = summarize(7);
        week += w.cost;
        messages += messagesIn(w.features);
        month += summarize(30).cost;
      });
    }
    const active = users.filter((u) => u.lastActiveAt && Date.now() - Date.parse(u.lastActiveAt) < 7 * 864e5).length;
    // In dry run there's no real Linq lookup, so the count is unknown rather than zero.
    const contacts = config.linq.dryRun ? null : await listContacts().then((c) => c.length, () => null);
    const invites = global.listInvites();
    res.json({
      users: users.length,
      active7d: active,
      spend: { today, week, month },
      messages7d: messages,
      costPerMessage: messages ? week / messages : null,
      costPerUser7d: users.length ? week / users.length : null,
      waitlist: global.listWaitlist().filter((w) => w.status === "waiting").length,
      contacts: { used: contacts, limit: CONTACT_LIMIT },
      invitesOpen: invites.filter((i) => global.inviteState(i.code) === "ok").length,
      dryRun: config.linq.dryRun,
    });
  });

  admin.get("/users", (_req, res) => res.json(global.listUsers().map(userRow)));

  const target = (req: Request, res: Response): global.User | null => {
    const u = global.getUser(String(req.params.id));
    if (!u) {
      res.status(404).json({ error: "no such user" });
      return null;
    }
    return u;
  };

  admin.post("/users/:id/pause", (req, res) => {
    const u = target(req, res);
    if (!u) return;
    if (u.role === "owner") return void res.status(400).json({ error: "can't pause the owner" });
    res.json(userRow(global.updateUser(u.id, { status: "paused" })));
  });
  admin.post("/users/:id/unpause", (req, res) => {
    const u = target(req, res);
    if (!u) return;
    res.json(userRow(global.updateUser(u.id, { status: u.onboardingStep ? "onboarding" : "active" })));
  });
  admin.post("/users/:id/model", (req, res) => {
    const u = target(req, res);
    if (!u) return;
    const which = String(req.body?.model);
    if (!["sonnet", "opus"].includes(which)) return void res.status(400).json({ error: "model must be sonnet or opus" });
    res.json(userRow(global.updateUser(u.id, { model: which === "opus" ? MODELS.replyStrong : MODELS.reply })));
  });
  admin.post("/users/:id/grant-invite", (req, res) => {
    const u = target(req, res);
    if (!u) return;
    res.json(userRow(global.updateUser(u.id, { invitesLeft: u.invitesLeft + 1 })));
  });
  admin.delete("/users/:id", (req, res) => {
    const u = target(req, res);
    if (!u) return;
    if (u.role === "owner") return void res.status(400).json({ error: "can't delete the owner" });
    withUser(u.id, () => store.deleteCurrentUserData());
    global.removeUser(u.id);
    void purgeUserFromBackups(u.id).catch((err) => console.error("[backups] purge failed:", err instanceof Error ? err.message : err));
    console.log("[admin] deleted a user");
    res.json({ ok: true });
  });

  admin.get("/invites", (_req, res) => res.json(global.listInvites().map(inviteRow)));
  admin.post("/invites", (req, res) => {
    const own = global.owner();
    if (!own) return void res.status(409).json({ error: "no owner yet" });
    const invite = global.createInvite(own.id, String(req.body?.note ?? "").slice(0, 80));
    const row = inviteRow(invite);
    res.status(201).json({ ...row, message: row.url ? inviteMessage(row.url) : null });
  });
  admin.post("/invites/:code/revoke", (req, res) => {
    const ok = global.revokeInvite(String(req.params.code));
    if (!ok) return void res.status(400).json({ error: "already used or doesn't exist" });
    res.json(inviteRow(global.getInvite(String(req.params.code))!));
  });

  admin.get("/waitlist", (_req, res) => res.json(global.listWaitlist().map((w) => ({ contact: w.email, kind: w.kind ?? (w.email.includes("@") ? "email" : "phone"), createdAt: w.createdAt, status: w.status, inviteCode: w.inviteCode }))));
  admin.post("/waitlist/invite", (req, res) => {
    const own = global.owner();
    const contact = String(req.body?.contact ?? "");
    const entry = global.listWaitlist().find((w) => w.email === contact);
    if (!own || !entry) return void res.status(404).json({ error: "not on the waitlist" });
    if (entry.status === "joined") return void res.status(400).json({ error: "already joined" });
    const invite = global.createInvite(own.id, `waitlist: ${contact}`);
    global.markWaitlistInvited(contact, invite.code);
    const row = inviteRow(invite);
    res.status(201).json({ ...row, message: row.url ? inviteMessage(row.url) : null });
  });
  admin.get("/waitlist.csv", (_req, res) => {
    const rows = [["contact", "kind", "joined_waitlist", "status", "invite_code"], ...global.listWaitlist().map((w) => [w.email, w.kind ?? "", w.createdAt, w.status, w.inviteCode ?? ""])];
    res
      .set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="beast-waitlist-${localDay(new Date())}.csv"` })
      .send(rows.map((r) => r.map(csvCell).join(",")).join("\n"));
  });

  admin.get("/schools", (_req, res) =>
    res.json(
      listSchools().map((s) => ({
        name: s.name,
        origin: s.origin,
        termSystem: s.termSystem,
        term: s.currentTerm?.name ?? null,
        canvasHost: s.canvasHost,
        scheduleLookup: Boolean(s.scheduleOfClasses),
        learnedAt: s.learnedAt || null,
        users: global.listUsers().filter((u) => u.school === s.name).length,
      })),
    ),
  );

  admin.get("/usage", (_req, res) => {
    const users = global.listUsers();
    const features: Record<string, { uses: number; users: number }> = {};
    const daily: Record<string, number> = {};
    const since = Date.now() - 14 * 864e5;
    for (const u of users) {
      withUser(u.id, () => {
        for (const [k, v] of Object.entries(summarize(7).features)) {
          const f = (features[k] ??= { uses: 0, users: 0 });
          f.uses += v;
          f.users += 1;
        }
        for (const [date, day] of Object.entries(store.getUsage())) if (Date.parse(date) >= since) daily[date] = (daily[date] ?? 0) + day.costUsd;
      });
    }
    res.json({
      features: Object.entries(features)
        .sort((a, b) => b[1].uses - a[1].uses)
        .map(([name, f]) => ({ name, ...f })),
      unused: KNOWN_FEATURES.filter((k) => !features[k]),
      daily: Object.entries(daily)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, cost]) => ({ date, cost })),
    });
  });
}
