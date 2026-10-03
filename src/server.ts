import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { config } from "./config.js";
import { endSession, hasSession, startSession, tokenMatches } from "./adminSession.js";
import { mountAdminRoutes } from "./adminRoutes.js";
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
import { joinWithInvite, suggestedCanvasHost } from "./onboarding.js";
import { toE164 } from "./linqContacts.js";
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

/** Per-IP limit per minute for public form endpoints (in memory; enough for one server). */
function limited(perMinute: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.path}|${req.ip}`;
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) return void res.status(429).json({ error: "Slow down a sec and try again." });
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear(); // crude cap so it can't grow without bound
    next();
  };
}

/** /api/admin/*: a Bearer ADMIN_TOKEN, or (locally only) a request from this computer. */
function adminOnly(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ") && tokenMatches(header.slice(7))) return next();
  // The /admin page signs in once and then uses an httpOnly session cookie.
  if (hasSession(req)) {
    // POSTs must be JSON: with a SameSite=Strict cookie that rules out cross-site form posts. (DELETE can't be
    // sent cross-site without a CORS preflight, which Beast never grants, so it needs no body.)
    if (req.method === "POST" && !req.is("application/json")) return void res.status(415).json({ error: "JSON only" });
    return next();
  }
  // Locally, requests from this computer are trusted. In the cloud only the token or a session counts.
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

  // Landing page: "beast" + join the waitlist.
  app.get("/", (_req, res) => res.sendFile(page("landing.html")));
  app.post(
    "/api/waitlist",
    express.json({ limit: "2kb" }),
    limited(10),
    (req, res) => {
      const contact = String(req.body?.contact ?? "").trim();
      const phone = toE164(contact);
      const email = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(contact) ? contact.toLowerCase() : null;
      if (!phone && !email) return void res.status(400).json({ error: "Enter an email or a US phone number." });
      // Same answer whether or not they were already on the list.
      global.joinWaitlist(phone ?? email!, phone ? "phone" : "email");
      res.json({ ok: true });
    },
  );

  // Dashboard: /dashboard/<slug> serves the page; the page reads /api/viz/<slug>.
  app.get("/dashboard/:slug", (req, res) => {
    const user = global.getUserBySlug("dashboard", String(req.params.slug));
    if (!user) return void res.status(404).send("This link doesn't work anymore. Text Beast for a new one.");
    withUser(user.id, () => track("dashboard_open"));
    res.sendFile(page("dashboard.html"));
  });
  // Links sent before the rename keep working.
  app.get("/v/:slug", (req, res) => res.redirect(301, `/dashboard/${encodeURIComponent(String(req.params.slug))}`));
  app.get("/i/:code", (req, res) => res.redirect(301, `/join/${encodeURIComponent(String(req.params.code))}`));
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

  // Invite-only signup: /join/<code>. Signing up adds the number as a Linq contact and burns the code.
  app.get("/join/:code", (_req, res) => res.sendFile(page("join.html")));
  app.get("/api/join/:code", limited(30), (req, res) => {
    const code = String(req.params.code);
    const state = global.inviteState(code);
    const inviter = state === "ok" ? global.getUser(global.getInvite(code)!.createdBy) : undefined;
    res.json({ state, invitedBy: inviter?.role === "owner" ? null : (inviter?.name ?? null) });
  });
  app.post(
    "/api/join/:code",
    express.json({ limit: "2kb" }),
    limited(5),
    wrap(async (req, res) => {
      if (!req.body?.agree) return void res.status(400).json({ error: "Please agree to the privacy terms." });
      const name = String(req.body?.name ?? "").trim();
      if (!name) return void res.status(400).json({ error: "What should Beast call you?" });
      const result = await joinWithInvite(String(req.params.code), String(req.body?.phone ?? ""), name);
      if (!result.ok) {
        const errors: Record<string, [number, string]> = {
          used: [410, "This invite was already used. Ask whoever sent it for a new one."],
          expired: [410, "This invite expired. Ask whoever sent it for a new one."],
          missing: [404, "This invite link doesn't exist."],
          bad_phone: [400, "Enter a US phone number."],
          already_user: [409, "That number is already on Beast. Just text it!"],
          full: [503, "Beast is full right now. Try again soon."],
          error: [502, "Something went wrong on our end. Try again in a minute."],
        };
        const [status, message] = errors[result.reason];
        return void res.status(status).json({ error: message, beastNumber: result.reason === "already_user" ? config.beastNumber : undefined });
      }
      res.json({ ok: true, beastNumber: config.beastNumber, smsBody: "hey beast" });
    }),
  );

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
// Railway sits behind one proxy hop; this makes req.ip the visitor's address for rate limiting.
if (config.cloud) app.set("trust proxy", 1);
app.post("/webhooks/linq", express.raw({ type: "*/*", limit: "2mb" }), linqWebhook);
publicRoutes(app);
app.use(express.static("public", { index: false }));

// Owner sign-in for /admin: token in, httpOnly session cookie out.
app.get("/admin", (_req, res) => res.sendFile(path.resolve("public", "admin.html")));
app.post("/api/admin/session", express.json({ limit: "2kb" }), limited(5), (req, res) => {
  if (!tokenMatches(String(req.body?.token ?? ""))) return void res.status(401).json({ error: "That token isn't right." });
  startSession(res);
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

const admin = express.Router();
admin.use(adminOnly, express.json());
mountAdminRoutes(admin);
// Manual backup download (gzipped JSON bundle). Treat the file like a password: it has everyone's data.
admin.get("/backup", (_req, res) => {
  res.set({ "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="beast-${new Date().toISOString().slice(0, 10)}.json.gz"` });
  res.send(packBundle(snapshotBundle()));
});
admin.post("/backup", wrap(async (_req, res) => res.json({ key: await runBackup() })));
admin.get("/stats", (_req, res) => res.type("text/plain").send(statsText()));
admin.get("/feedback", (_req, res) =>
  res.json(global.listFeedback().map((f) => ({ ...f, name: global.getUser(f.userId)?.name ?? "deleted user" }))),
);
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
  viewer.use(express.static("public", { index: false }));
  viewer.listen(config.viewerPort, "127.0.0.1", () => {
    console.log(`Public pages at http://localhost:${config.viewerPort}`);
    startTunnel();
  });
}
