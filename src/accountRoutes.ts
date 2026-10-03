// User accounts on the website: sign in with a 6-digit code Beast iMessages you, then the /app pages read
// and change your own data through /api/me/*. Every handler runs inside withUser(the signed-in user).
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { purgeUserFromBackups } from "./backups.js";
import { config } from "./config.js";
import { isConnected, removeConnection } from "./connections.js";
import * as global from "./globalStore.js";
import { calendarUrl, connectUrl, dashboardUrl, inviteUrl } from "./links.js";
import { toE164 } from "./linqContacts.js";
import * as linq from "./linq.js";
import { track } from "./metrics.js";
import { normalizeSchool } from "./onboarding.js";
import { allow, limited } from "./rateLimit.js";
import { learnSchool } from "./schoolLearning.js";
import * as store from "./store.js";
import { withUser } from "./userContext.js";

const COOKIE = "beast_session";
const CODE_TTL_MS = 10 * 60_000;
const MAX_TRIES = 5;
const RESEND_MS = 30_000;

// ---- one-time codes (memory only: a code that dies with a deploy is fine) ----

const codes = new Map<string, { hash: string; expiresAt: number; tries: number; sentAt: number }>();
const perNumber = new Map<string, number[]>();
const hashCode = (handle: string, code: string) => createHash("sha256").update(`${handle}:${code}`).digest("hex");

function cookieValue(req: Request): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

function setCookie(res: Response, value: string, maxAgeSec: number) {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
  if (config.cloud) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

const pretty = (e164: string) => e164.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3");

/** Signed-in user or 401; then runs the rest of the request as that user. POSTs/PATCHes must be JSON. */
function requireUser(req: Request, res: Response, next: NextFunction) {
  const id = cookieValue(req);
  const user = id ? global.sessionUser(id) : undefined;
  if (!user) return void res.status(401).json({ error: "signed out" });
  if (["POST", "PATCH"].includes(req.method) && !req.is("application/json")) return void res.status(415).json({ error: "JSON only" });
  res.locals.user = user;
  withUser(user.id, () => next());
}

const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function mountAccountRoutes(app: express.Express) {
  // ---- sign in ----
  app.post(
    "/api/auth/start",
    express.json({ limit: "2kb" }),
    limited(5),
    wrap(async (req, res) => {
      const handle = toE164(String(req.body?.phone ?? ""));
      if (!handle) return void res.status(400).json({ error: "Enter a US phone number." });
      const sameAnswer = () => res.json({ ok: true, phone: pretty(handle), resendInSec: RESEND_MS / 1000 });
      // Same answer whether or not the number is on Beast, so this can't be used to check who's a user.
      if (!allow(perNumber, handle, 5, 3600_000)) return void sameAnswer();
      const prev = codes.get(handle);
      if (prev && Date.now() - prev.sentAt < RESEND_MS) return void sameAnswer();
      const user = global.getUserByHandle(handle);
      const chatId = user ? withUser(user.id, () => store.getSettings().chatId) : null;
      if (user && chatId && user.status !== "paused") {
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        codes.set(handle, { hash: hashCode(handle, code), expiresAt: Date.now() + CODE_TTL_MS, tries: 0, sentAt: Date.now() });
        // Sent straight through Linq, never saved in the chat history, so the reply model never sees it.
        await linq
          .sendText(chatId, `your beast sign-in code is ${code}. it expires in 10 min. if u didnt ask for this, ignore it`)
          .catch((err) => console.error("[auth] code send failed:", err instanceof Error ? err.message : err));
      }
      sameAnswer();
    }),
  );

  app.post("/api/auth/verify", express.json({ limit: "2kb" }), limited(10), (req, res) => {
    const handle = toE164(String(req.body?.phone ?? ""));
    const code = String(req.body?.code ?? "").replace(/\D/g, "");
    const entry = handle ? codes.get(handle) : undefined;
    const bad = () => res.status(400).json({ error: "That code didn't work. Check it or send a new one." });
    if (!handle || !entry || code.length !== 6) return void bad();
    if (entry.expiresAt < Date.now() || entry.tries >= MAX_TRIES) {
      codes.delete(handle);
      return void res.status(400).json({ error: "That code expired. Send a new one." });
    }
    entry.tries++;
    const a = Buffer.from(entry.hash);
    const b = Buffer.from(hashCode(handle, code));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return void bad();
    codes.delete(handle);
    const user = global.getUserByHandle(handle);
    if (!user) return void bad();
    setCookie(res, global.createSession(user.id), 30 * 86400);
    withUser(user.id, () => track("web_sign_in"));
    res.json({ ok: true });
  });

  app.post("/api/auth/logout", (req, res) => {
    const id = cookieValue(req);
    if (id) global.endSession(id);
    setCookie(res, "", 0);
    res.json({ ok: true });
  });

  // ---- the signed-in user's own data ----
  const me = express.Router();
  me.use(express.json({ limit: "8kb" }), requireUser);

  me.get("/", (_req, res) => {
    const u: global.User = res.locals.user;
    const { invite, joined } = global.personalInvite(u.id);
    const canvas = store.getConnectionRecord("canvas");
    const cal = calendarUrl(u);
    res.json({
      name: u.name,
      school: u.school,
      phone: pretty(u.handle),
      role: u.role,
      beastNumber: config.beastNumber ? pretty(config.beastNumber) : null,
      beastNumberRaw: config.beastNumber || null,
      dashboardUrl: dashboardUrl(u),
      calendarUrl: cal ? cal.replace(/^https?:/, "webcal:") : null,
      calendarSubscribed: Boolean(u.offeredAt.calendar_fetch),
      connections: {
        canvas: canvas ? { connected: true, since: canvas.addedAt, problem: canvas.lastError } : { connected: false },
      },
      invite: {
        link: inviteUrl(invite.code),
        name: invite.code,
        joined,
        left: u.role === "owner" ? null : u.invitesLeft,
      },
      prefs: {
        briefTime: config.proactive.briefTime,
        quietStart: config.proactive.quietStart,
        quietEnd: config.proactive.quietEnd,
        nudges: true,
        nightly: true,
        ...(u.prefs ?? {}),
      },
    });
  });

  me.patch("/profile", (req, res) => {
    const u: global.User = res.locals.user;
    const patch: Partial<global.User> = {};
    if (typeof req.body?.name === "string") {
      const name = req.body.name.trim().slice(0, 40);
      if (!name) return void res.status(400).json({ error: "Name can't be empty." });
      patch.name = name;
    }
    if (typeof req.body?.school === "string") {
      const school = normalizeSchool(req.body.school);
      if (!school) return void res.status(400).json({ error: "School can't be empty." });
      patch.school = school;
      void learnSchool(school);
    }
    global.updateUser(u.id, patch);
    res.json({ ok: true });
  });

  me.patch("/preferences", (req, res) => {
    const u: global.User = res.locals.user;
    const b = req.body ?? {};
    const prefs: Partial<global.Prefs> = { ...(u.prefs ?? {}) };
    for (const k of ["briefTime", "quietStart", "quietEnd"] as const) {
      if (b[k] === undefined) continue;
      if (!HHMM.test(String(b[k]))) return void res.status(400).json({ error: "Times look like 06:30." });
      prefs[k] = String(b[k]);
    }
    for (const k of ["nudges", "nightly"] as const) if (typeof b[k] === "boolean") prefs[k] = b[k];
    global.updateUser(u.id, { prefs });
    track("prefs_changed");
    res.json({ ok: true });
  });

  me.get("/memory", (_req, res) => res.json(store.listMemory().map((m) => ({ id: m.id, text: m.text, at: m.at }))));
  me.delete("/memory/:id", (req, res) => {
    const removed = store.removeMemory([String(req.params.id)]);
    track("memory_forget_web");
    res.json({ ok: removed > 0 });
  });

  // Classes: abstracted for the page (no raw excerpts).
  me.get("/classes", (_req, res) =>
    res.json(
      Object.values(store.getCourseProfiles()).map((p) => ({
        id: p.canvasCourseId,
        course: p.course,
        code: p.dept && p.number ? `${p.dept} ${p.number}` : null,
        title: p.title,
        instructors: p.instructors,
        // Schools without a schedule adapter get meetings and the final from the syllabus/site instead.
        meetings: p.meetings.length ? p.meetings : (p.facts?.meetings ?? []),
        final: p.final ?? p.facts?.finalExam ?? null,
        website: p.website,
        links: p.links.filter((l) => ["ed", "gradescope", "zoom", "recordings", "website", "piazza"].includes(l.kind)).slice(0, 8),
        officeHours: p.facts?.officeHours ?? [],
        grading: p.facts?.grading ?? [],
        canvasUrl: p.canvasUrl,
        lastScannedAt: p.lastScannedAt,
      })),
    ),
  );

  me.get("/board", (_req, res) =>
    res.json({ assignments: store.listAssignments({ status: "all" }), courses: store.listCourses() }),
  );

  me.post("/invite", (req, res) => {
    const u: global.User = res.locals.user;
    const r = global.personalInvite(u.id, typeof req.body?.name === "string" && req.body.name ? req.body.name : undefined);
    if (r.error) return void res.status(400).json({ error: r.error });
    res.json({ link: inviteUrl(r.invite.code), name: r.invite.code, joined: r.joined });
  });

  me.post("/connect/canvas", (_req, res) => {
    const u: global.User = res.locals.user;
    const url = connectUrl(global.createConnectToken(u.id, "canvas"));
    if (!url) return void res.status(503).json({ error: "Beast's site isn't reachable right now." });
    res.json({ url });
  });
  me.delete("/connect/canvas", (_req, res) => {
    removeConnection("canvas");
    removeConnection("canvas_ics");
    track("disconnect_canvas_web");
    res.json({ ok: true, connected: isConnected("canvas") });
  });

  // Everything Beast has on you, minus encrypted secrets.
  me.get("/export", (_req, res) => {
    const u: global.User = res.locals.user;
    const data = {
      profile: { name: u.name, school: u.school, phone: u.handle, createdAt: u.createdAt, prefs: u.prefs ?? {} },
      courses: store.listCourses(),
      assignments: store.listAssignments({ status: "all" }),
      memory: store.listMemory(),
      classes: store.getCourseProfiles(),
      connections: store.listConnectionKinds(),
      exportedAt: new Date().toISOString(),
    };
    res.set({ "Content-Type": "application/json", "Content-Disposition": `attachment; filename="beast-my-data.json"` }).send(JSON.stringify(data, null, 2));
  });

  me.delete("/", (req, res) => {
    const u: global.User = res.locals.user;
    if (req.body?.confirm !== "DELETE") return void res.status(400).json({ error: 'Type DELETE to confirm.' });
    if (u.role === "owner") return void res.status(400).json({ error: "The owner account can't be deleted here." });
    store.deleteCurrentUserData();
    global.endUserSessions(u.id);
    global.removeUser(u.id);
    void purgeUserFromBackups(u.id).catch((err) => console.error("[backups] purge failed:", err instanceof Error ? err.message : err));
    setCookie(res, "", 0);
    console.log("[account] a user deleted their account");
    res.json({ ok: true });
  });

  app.use("/api/me", me);
}
