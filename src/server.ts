import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { linqWebhook, lastWebhookAt } from "./imessage.js";
import { buildCalendar } from "./calendarFeed.js";
import { syncCanvas } from "./canvas.js";
import { syncPlanner } from "./canvasPlanner.js";
import { canvasGet, normalizeCanvasBaseUrl } from "./canvasApi.js";
import { saveConnection } from "./connections.js";
import * as global from "./globalStore.js";
import { JOBS, lastOk, startJobs, syncUserNow, type JobName } from "./jobs.js";
import { packBundle, runBackup, snapshotBundle } from "./backups.js";
import { inviteUrl } from "./links.js";
import { summarize, track } from "./metrics.js";
import { migrateIfNeeded } from "./migrate.js";
import { suggestedCanvasHost } from "./onboarding.js";
import { seedPeopleFromConfig } from "./people.js";
import { tick } from "./proactive.js";
import { statsText } from "./commands.js";
import * as store from "./store.js";
import { startTunnel } from "./tunnel.js";
import { withUser } from "./userContext.js";

const wrap =
  (fn: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** /api/admin/*: a Bearer ADMIN_TOKEN, or (locally only) a request from this computer. */
function adminOnly(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(config.adminToken);
  if (want.length && given.length === want.length && timingSafeEqual(given, want)) return next();
  // Locally, requests from this computer are trusted. In the cloud only the token counts.
  if (!config.cloud && LOOPBACK.has(req.socket.remoteAddress ?? "")) return next();
  res.status(401).json({ error: "admin only" });
}

/** Runs the handler as the user named in :userId. */
const asUser = (fn: (req: Request, res: Response) => unknown) =>
  wrap((req, res) => {
    const id = String(req.params.userId);
    if (!global.getUser(id)) return void res.status(404).json({ error: "no such user" });
    return withUser(id, () => fn(req, res));
  });

const EDITABLE = ["title", "course", "type", "dueAt", "priority", "status", "notes"] as const;
const pickEditable = (body: Record<string, unknown> = {}) =>
  Object.fromEntries(EDITABLE.filter((k) => k in body).map((k) => [k, body[k]])) as store.AssignmentPatch;

// ---- read-only dashboard data ----
const dashboardData = () => ({
  assignments: store.listAssignments({ status: "all" }),
  courses: store.listCourses(),
  canvas: {
    connected: store.listConnectionKinds().length > 0,
    lastSyncAt: store.getCanvasState().lastSyncAt,
    lastPlannerSyncAt: store.getCanvasState().lastPlannerSyncAt,
  },
});

/** Public pages: dashboards, invite and connect pages, health. Mounted on both apps. */
function publicRoutes(app: express.Express) {
  const page = (file: string) => path.resolve("public", file);
  app.get("/healthz", (_req, res) => {
    const stale = (Object.keys(JOBS) as JobName[]).filter((j) => {
      const at = lastOk[j];
      return !at || Date.now() - Date.parse(at) > 2 * JOBS[j].everyMs + 60_000;
    });
    // Silence from Linq for a day while people are using Beast means the webhook broke.
    const activeRecently = global.listUsers().some((u) => u.lastActiveAt && Date.now() - Date.parse(u.lastActiveAt) < 3 * 864e5);
    // (lastWebhookAt lives in memory, so this only applies once the server has been up a full day.)
    const linqQuiet =
      activeRecently && process.uptime() > 86_400 && (!lastWebhookAt || Date.now() - Date.parse(lastWebhookAt) > 864e5);
    // Give jobs time after a restart before calling them stale (the first backup runs at 5 min).
    const warmingUp = process.uptime() < 10 * 60;
    const ok = (warmingUp || stale.length === 0) && !linqQuiet;
    res.status(ok ? 200 : 503).json({ ok, staleJobs: warmingUp ? [] : stale, linqQuiet, uptimeSec: Math.round(process.uptime()) });
  });

  // Dashboard: /v/<slug> serves the page; the page reads /api/viz/<slug>.
  app.get("/v/:slug", (req, res) => {
    const user = global.getUserBySlug("dashboard", String(req.params.slug));
    if (!user) return void res.status(404).send("This link doesn't work anymore. Text Beast for a new one.");
    withUser(user.id, () => track("dashboard_open"));
    res.sendFile(page("index.html"));
  });
  app.get("/api/viz/:slug", (req, res) => {
    const user = global.getUserBySlug("dashboard", String(req.params.slug));
    if (!user) return void res.status(404).json({ error: "not found" });
    res.set("Cache-Control", "no-store").json({ name: user.name, ...withUser(user.id, dashboardData) });
  });

  app.get("/privacy", (_req, res) => res.sendFile(page("privacy.html")));

  // Private calendar feed: /cal/<slug>.ics (calendar apps poll it every few hours).
  app.get("/cal/:file", (req, res) => {
    const user = global.getUserBySlug("calendar", String(req.params.file).replace(/\.ics$/i, ""));
    if (!user) return void res.status(404).send("Not found");
    if (!user.offeredAt.calendar_fetch) global.updateUser(user.id, { offeredAt: { ...user.offeredAt, calendar_fetch: new Date().toISOString() } });
    withUser(user.id, () => track("calendar_fetch"));
    res.set({ "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" }).send(withUser(user.id, () => buildCalendar(user.name)));
  });

  // Invite page.
  app.get("/i/:code", (_req, res) => res.sendFile(page("invite.html")));
  app.get("/api/invite/:code", (req, res) => {
    const invite = global.getInvite(String(req.params.code));
    const valid = Boolean(invite && !invite.usedBy);
    res.json({ valid, beastNumber: valid ? config.beastNumber : null, smsBody: valid ? `join ${invite!.code}` : null });
  });

  // Connect pages: one-time links Beast texts. The secret never goes through iMessage.
  app.get("/connect/:token", (_req, res) => res.sendFile(page("connect.html")));
  app.get("/api/connect/:token", (req, res) => {
    const tok = global.peekConnectToken(String(req.params.token));
    if (!tok) return void res.status(404).json({ valid: false });
    const user = global.getUser(tok.userId);
    res.json({ valid: true, kind: tok.kind, name: user?.name ?? null, canvasHost: user ? suggestedCanvasHost(user) : "", expiresAt: tok.expiresAt });
  });
  app.post(
    "/api/connect/:token",
    express.json({ limit: "8kb" }),
    wrap(async (req, res) => {
      const token = String(req.params.token);
      const tok = global.peekConnectToken(token);
      if (!tok) return void res.status(404).json({ error: 'This link expired. Text Beast "connect canvas" for a new one.' });
      const host = normalizeCanvasBaseUrl(String(req.body?.canvasHost ?? ""));
      const canvasToken = String(req.body?.canvasToken ?? "").trim();
      if (!host || canvasToken.length < 20) return void res.status(400).json({ error: "Check the Canvas address and token and try again." });

      // One read-only call proves the token works; the profile also has the user's calendar feed link.
      let feed: string | null = null;
      try {
        const profile = await canvasGet<{ calendar?: { ics?: string } }>("/api/v1/users/self/profile", { baseUrl: host, token: canvasToken });
        feed = profile.calendar?.ics ?? null;
      } catch {
        return void res.status(400).json({ error: "Canvas didn't accept that token. Make sure you copied the whole thing." });
      }
      global.consumeConnectToken(token);
      withUser(tok.userId, () => {
        saveConnection("canvas", canvasToken, { baseUrl: host });
        if (feed) saveConnection("canvas_ics", feed);
        track("connect_canvas_done");
      });
      console.log("[connect] a user connected Canvas");
      void syncUserNow(tok.userId).catch((err) => console.error("[connect] first sync failed:", err instanceof Error ? err.message : err));
      res.json({ ok: true });
    }),
  );
}

// ---- owner app: webhook, admin API ----
const app = express();
app.post("/webhooks/linq", express.raw({ type: "*/*", limit: "2mb" }), linqWebhook);
publicRoutes(app);
app.use(express.static("public"));

const admin = express.Router();
admin.use(adminOnly, express.json());
admin.get("/users", (_req, res) =>
  res.json(
    global.listUsers().map((u) => ({
      id: u.id,
      name: u.name,
      handleLast4: u.handle.slice(-4),
      role: u.role,
      status: u.status,
      school: u.school,
      model: u.model,
      invitesLeft: u.invitesLeft,
      createdAt: u.createdAt,
      lastActiveAt: u.lastActiveAt,
      connections: withUser(u.id, () => store.listConnectionKinds()),
      last7d: withUser(u.id, () => summarize(7)),
    })),
  ),
);
// Manual backup download (gzipped JSON bundle). Treat the file like a password: it has everyone's data.
admin.get("/backup", (_req, res) => {
  res.set({ "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="beast-${new Date().toISOString().slice(0, 10)}.json.gz"` });
  res.send(packBundle(snapshotBundle()));
});
admin.post("/backup", wrap(async (_req, res) => res.json({ key: await runBackup() })));
admin.get("/stats", (_req, res) => res.type("text/plain").send(statsText()));
admin.get("/feedback", (_req, res) => res.json(global.listFeedback()));
admin.get("/waitlist", (_req, res) => res.json(global.listWaitlist()));
admin.post("/invites", (req, res) => {
  const own = global.owner();
  if (!own) return void res.status(409).json({ error: "no owner yet" });
  const invite = global.createInvite(own.id, String(req.body?.note ?? ""));
  if (req.body?.email) global.markWaitlistInvited(String(req.body.email), invite.code);
  res.status(201).json({ code: invite.code, url: inviteUrl(invite.code) });
});
admin.get("/users/:userId/assignments", asUser((_req, res) => res.json(store.listAssignments({ status: "all" }))));
admin.post(
  "/users/:userId/assignments",
  asUser((req, res) => {
    const input = pickEditable(req.body);
    if (typeof input.title !== "string" || !input.title.trim()) return void res.status(400).json({ error: "title is required" });
    res.status(201).json(store.addAssignment({ ...input, title: input.title.trim() }));
  }),
);
admin.patch(
  "/users/:userId/assignments/:id",
  asUser((req, res) => {
    const updated = store.updateAssignment(String(req.params.id), pickEditable(req.body));
    updated ? res.json(updated) : res.status(404).json({ error: "not found" });
  }),
);
admin.delete(
  "/users/:userId/assignments/:id",
  asUser((req, res) => {
    store.deleteAssignment(String(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: "not found" });
  }),
);
// Manual Canvas sync for one user: body {"what": "ics" | "planner" | "all"} (default all).
admin.post(
  "/users/:userId/canvas/sync",
  asUser(async (req, res) => {
    const what = String(req.body?.what ?? "all");
    const result: Record<string, unknown> = {};
    if (what !== "planner") {
      result.ics = await syncCanvas().then(
        (r) => ({ imported: r.imported.map((a) => a.title), events: r.events }),
        (e: Error) => ({ error: e.message }),
      );
    }
    if (what !== "ics") result.planner = await syncPlanner();
    res.json(result);
  }),
);
admin.post(
  "/users/:userId/proactive/tick",
  asUser(async (_req, res) => {
    await tick();
    res.json({ ok: true });
  }),
);
app.use("/api/admin", admin);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

migrateIfNeeded();
seedPeopleFromConfig();

app.listen(config.port, () => {
  console.log(`Beast running at http://localhost:${config.port}`);
  if (!config.linq.webhookSecret) console.warn("! LINQ_WEBHOOK_SECRET not set: webhook signatures are NOT verified");
  if (!config.masterKey) console.warn("! MASTER_KEY not set: connections can't be saved");
  if (!config.adminToken) console.warn("! ADMIN_TOKEN not set: /api/admin only works from this computer");
  startJobs();
});

// ---- public app (shared through the tunnel or the host): no webhook, no admin ----
if (config.viewerPort) {
  const viewer = express();
  publicRoutes(viewer);
  viewer.use(express.static("public"));
  viewer.listen(config.viewerPort, "127.0.0.1", () => {
    console.log(`Public pages at http://localhost:${config.viewerPort}`);
    startTunnel();
  });
}
