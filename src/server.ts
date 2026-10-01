import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { linqWebhook } from "./imessage.js";
import { startProactiveScheduler, tick } from "./proactive.js";
import { startCanvasSync, syncCanvas } from "./canvas.js";
import { startTunnel } from "./tunnel.js";
import { seedGuestsFromConfig } from "./guests.js";
import { syncPlanner } from "./canvasPlanner.js";
import { canvasApiConfigured } from "./canvasApi.js";
import * as store from "./store.js";

const app = express();
const WEB_KEY = "web";

// Webhook first, with the raw body, and outside dashboard auth.
app.post("/webhooks/linq", express.raw({ type: "*/*", limit: "2mb" }), linqWebhook);
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Optional password on the dashboard + its API (any username, password = DASHBOARD_PASSWORD).
function dashboardAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.dashboardPassword) return next();
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Basic ") ? header.slice(6) : "", "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(given);
  const b = Buffer.from(config.dashboardPassword);
  if (a.length === b.length && timingSafeEqual(a, b)) return next();
  res.set("WWW-Authenticate", 'Basic realm="School Assistant"').status(401).send("Authentication required");
}
app.use(dashboardAuth);
app.use(express.json());
app.use(express.static("public"));

const wrap =
  (fn: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

// ---- read-only handlers, shared with the viewer app ----
const getAssignments = (req: Request, res: Response) =>
  void res.json(store.listAssignments({ status: (req.query.status as store.AssignmentFilter["status"]) ?? "all" }));
const getCourses = (_req: Request, res: Response) => void res.json(store.listCourses());
const getCanvasStatus = (_req: Request, res: Response) => {
  const s = store.getCanvasState();
  res.json({
    enabled: Boolean(config.canvasIcsUrl),
    lastSyncAt: s.lastSyncAt,
    lastError: s.lastError,
    calendarEvents: s.events.length,
    api: {
      enabled: canvasApiConfigured(),
      lastSyncAt: s.lastPlannerSyncAt,
      lastError: s.lastPlannerError,
    },
  });
};


// Edits and test triggers only from this computer: the owner app listens on every interface (and is public on Railway).
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function localOnly(req: Request, res: Response, next: NextFunction) {
  if (LOOPBACK.has(req.socket.remoteAddress ?? "")) return next();
  res.status(403).json({ error: "edits are only allowed from this computer" });
}

const EDITABLE = ["title", "course", "type", "dueAt", "priority", "status", "notes"] as const;
const pickEditable = (body: Record<string, unknown> = {}) =>
  Object.fromEntries(EDITABLE.filter((k) => k in body).map((k) => [k, body[k]])) as store.AssignmentPatch;

// ---- assignments ----
app.get("/api/assignments", getAssignments);
app.post("/api/assignments", localOnly, (req, res) => {
  const input = pickEditable(req.body);
  if (typeof input.title !== "string" || !input.title.trim()) return void res.status(400).json({ error: "title is required" });
  res.status(201).json(store.addAssignment({ ...input, title: input.title.trim() }));
});
app.patch("/api/assignments/:id", localOnly, (req, res) => {
  const updated = store.updateAssignment(String(req.params.id), pickEditable(req.body));
  updated ? res.json(updated) : res.status(404).json({ error: "not found" });
});
app.delete("/api/assignments/:id", localOnly, (req, res) => {
  store.deleteAssignment(String(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: "not found" });
});
// ---- courses ----
app.get("/api/courses", getCourses);
// ---- canvas ----
app.get("/api/canvas/status", getCanvasStatus);
// Manual trigger for testing: body {"what": "ics" | "planner" | "all"} (default all).
app.post(
  "/api/canvas/sync",
  localOnly,
  wrap(async (req, res) => {
    const what = String(req.body?.what ?? "all");
    if (!["ics", "planner", "all"].includes(what)) return void res.status(400).json({ error: "what must be ics, planner or all" });
    const result: Record<string, unknown> = {};
    if (what !== "planner") {
      result.ics = config.canvasIcsUrl
        ? await syncCanvas().then(
            (r) => ({ imported: r.imported.map((a) => a.title), skippedPastDue: r.skippedPastDue, calendarEvents: r.events }),
            (e: Error) => ({ error: e.message }),
          )
        : { skipped: "CANVAS_ICS_URL not set" };
    }
    if (what !== "ics") result.planner = await syncPlanner();
    res.json(result);
  }),
);

// Preview what a proactive text would say, without sending it (for testing prompts).
app.post(
  "/api/proactive/preview",
  localOnly,
  wrap(async (req, res) => {
    const { writeProactive } = await import("./agent.js");
    const key = store.getSettings().studentChatId ? `imessage:${store.getSettings().studentChatId}` : WEB_KEY;
    const kind = String(req.body?.kind ?? "brief");
    const instruction =
      kind === "brief"
        ? "Proactive text: the 6:30 morning brief. It goes out every morning like clockwork, so keep it brief. What's due today and tomorrow, anything missing, and one suggestion. If nothing is due, keep it short and chill."
        : String(req.body?.instruction ?? "");
    if (!instruction) return void res.status(400).json({ error: "instruction is required for non-brief previews" });
    res.json({ kind, text: await writeProactive(key, instruction, { allowSkip: kind !== "brief" }) });
  }),
);
// Run the scheduler once now (it also runs every minute).
app.post("/api/proactive/tick", localOnly, wrap(async (_req, res) => { await tick(); res.json({ ok: true, state: store.getProactive() }); }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
});

seedGuestsFromConfig();

app.listen(config.port, () => {
  console.log(`School assistant running at http://localhost:${config.port}`);
  console.log(`Linq webhook endpoint: ${config.publicUrl || "<PUBLIC_URL>"}/webhooks/linq`);
  if (!config.linq.webhookSecret) console.warn("! LINQ_WEBHOOK_SECRET not set: webhook signatures are NOT verified");
  if (!config.linq.allowedHandles.length) console.warn("! ALLOWED_HANDLES not set: anyone who texts your Linq number can use the assistant");
  startProactiveScheduler();
  startCanvasSync();
});

// ---- read-only viewer (share this one, e.g. through a tunnel) ----
// Only the dashboard and GET endpoints exist here: no webhook, chat, edits or syncs, and no model calls.
if (config.viewerPort) {
  const viewer = express();
  viewer.use(express.static("public"));
  viewer.get("/api/assignments", getAssignments);
  viewer.get("/api/courses", getCourses);
  viewer.get("/api/canvas/status", getCanvasStatus);
  viewer.listen(config.viewerPort, "127.0.0.1", () => {
    console.log(`Read-only dashboard at http://localhost:${config.viewerPort} (share this one)`);
    startTunnel();
  });
}
