// One-way Canvas import from the calendar .ics feed.
// - Assignments (UID "event-assignment-*") are created once per UID and never touched again,
//   so edits and deletions made here stick.
// - Every other event (lectures, office hours, ...) is mirrored as read-only context for the agent.
// Runs for the current user (inside withUser), using their own Canvas calendar feed.
import { config } from "./config.js";
import { canvasIcsUrl, markConnection } from "./connections.js";
import { parseIcs, zonedTimeToUtc, type IcsEvent } from "./ics.js";
import { notifyCanvas } from "./proactive.js";
import * as store from "./store.js";
import { currentUserId } from "./userContext.js";

const MAX_NOTES = 500;

// ---- course matching ----

const TERM = /\b(fall|winter|spring|summer)(\s+(quarter|semester|session))?\s*(\d{4}|\d{2})\b/gi;

/** "Stats 110/201 Fall 2026" -> "Stats 110/201" */
function stripTerm(name: string): string {
  return name.replace(TERM, "").replace(/\s{2,}/g, " ").replace(/[\s\-–—:,]+$/, "").trim() || name.trim();
}

/** "Stats 110/201 Fall 2026" -> "stats 110 201" */
function normalize(name: string): string {
  return stripTerm(name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** "stats 110 201" -> "stats110" (subject letters + first number) */
function courseCode(name: string): string | null {
  const m = normalize(name).match(/([a-z]+(?: [a-z]+)?) ?(\d+[a-z]?)/);
  return m ? `${m[1].replace(/ /g, "")}${m[2]}` : null;
}

function startsWithWords(long: string, short: string): boolean {
  return long === short || long.startsWith(`${short} `);
}

/** Maps a Canvas course name to the board course (creating it once), so every source agrees on the name. */
export function resolveCourse(canvasName: string): string {
  const courses = store.listCourses();
  const mapped = store.getCanvasState().courseMap[canvasName];
  const mappedCourse = mapped ? store.getCourseById(mapped) : undefined;
  if (mappedCourse) return mappedCourse.name;

  const norm = normalize(canvasName);
  const code = courseCode(canvasName);
  const match =
    courses.find((c) => c.name.toLowerCase() === canvasName.toLowerCase()) ??
    courses.find((c) => normalize(c.name) === norm) ??
    courses
      .filter((c) => {
        const n = normalize(c.name);
        return n && (startsWithWords(norm, n) || startsWithWords(n, norm));
      })
      .sort((a, b) => b.name.length - a.name.length)[0] ??
    (code ? courses.find((c) => courseCode(c.name) === code) : undefined);

  const course = match ?? store.addCourse(stripTerm(canvasName));
  store.mapCanvasCourse(canvasName, course.id);
  return course.name;
}

// ---- event mapping ----

/** "HW1 [Stats 110/201 Fall 2026]" -> { title: "HW1", course: "Stats 110/201 Fall 2026" } */
function splitSummary(summary: string): { title: string; course: string | null } {
  const m = summary.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  return m && m[1] ? { title: m[1], course: m[2] } : { title: summary, course: null };
}

function guessType(title: string): store.AssignmentType {
  const t = title.toLowerCase();
  if (/\b(midterm|final|exam)\b/.test(t)) return "exam";
  if (/\bquiz/.test(t)) return "quiz";
  if (/\b(essay|paper)\b/.test(t)) return "paper";
  if (/\bproject\b/.test(t)) return "project";
  if (/\b(reading|read)\b/.test(t)) return "reading";
  return "homework";
}

/** All-day Canvas due dates mean 11:59 PM local that day. */
function dueAt(ev: IcsEvent): string | null {
  if (!ev.start) return null;
  if (!ev.start.allDay) return ev.start.value;
  const [y, m, d] = ev.start.value.split("-").map(Number);
  return zonedTimeToUtc(y, m, d, 23, 59, 0, config.timezone).toISOString();
}

const isAssignment = (ev: IcsEvent) => ev.uid.startsWith("event-assignment-");
const safeUrl = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);

function toCalendarEvent(ev: IcsEvent): store.CalendarEvent | null {
  if (!ev.start) return null;
  const { title, course } = splitSummary(ev.summary);
  return {
    uid: ev.uid,
    title,
    course: course ? stripTerm(course) : null,
    start: ev.start.value,
    end: ev.end?.value ?? null,
    allDay: ev.start.allDay,
    location: ev.location,
    description: ev.description.slice(0, MAX_NOTES),
    url: safeUrl(ev.url),
  };
}

// ---- sync ----

export interface SyncResult {
  imported: store.Assignment[];
  skippedPastDue: number;
  events: number;
}

const running = new Map<string, Promise<SyncResult>>();

/** One sync at a time per user. */
export function syncCanvas(): Promise<SyncResult> {
  const id = currentUserId();
  let p = running.get(id);
  if (!p) {
    p = doSync().finally(() => running.delete(id));
    running.set(id, p);
  }
  return p;
}

async function doSync(): Promise<SyncResult> {
  const feed = canvasIcsUrl();
  if (!feed) return { imported: [], skippedPastDue: 0, events: 0 };
  try {
    const res = await fetch(feed, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`feed returned HTTP ${res.status}`);
    const events = parseIcs(await res.text(), config.timezone);

    const firstSync = store.getCanvasState().lastSyncAt === null;
    const now = Date.now();
    const imported: store.Assignment[] = [];
    const skipped: string[] = [];
    const context: store.CalendarEvent[] = [];

    for (const ev of events) {
      if (!isAssignment(ev)) {
        const ce = toCalendarEvent(ev);
        if (ce) context.push(ce);
        continue;
      }
      if (store.isCanvasUidSeen(ev.uid)) continue;

      const due = dueAt(ev);
      // On the very first sync, don't flood the list with work that's already past due.
      if (firstSync && due && Date.parse(due) < now) {
        skipped.push(ev.uid);
        continue;
      }
      const { title, course } = splitSummary(ev.summary);
      imported.push(
        store.importCanvasAssignment(ev.uid, {
          title,
          course: course ? resolveCourse(course) : undefined,
          type: guessType(title),
          dueAt: due ?? undefined,
          notes: ev.description.slice(0, MAX_NOTES),
          url: safeUrl(ev.url),
        }),
      );
    }

    // A real Canvas exam replaces the tentative one the course scan found in the syllabus.
    for (const a of imported) if (a.type === "exam" || a.type === "quiz") replaceTentative(a);
    store.markCanvasUidsSeen(skipped);
    store.finishCanvasSync(context, null);
    markConnection("canvas_ics", null);
    console.log(
      `[canvas] synced: ${imported.length} new, ${skipped.length} past-due skipped, ${context.length} calendar events`,
    );
    if (imported.length) await notify(imported);
    return { imported, skippedPastDue: skipped.length, events: context.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[canvas] sync failed:", message);
    store.finishCanvasSync(null, message);
    if (/HTTP 40[134]/.test(message)) markConnection("canvas_ics", "feed link stopped working");
    throw err;
  }
}

function replaceTentative(real: store.Assignment) {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const w = words(real.title);
  for (const t of store.listAssignments({ status: "all", course: real.course ?? undefined })) {
    if (!t.tentative) continue;
    const overlap = [...words(t.title)].filter((x) => w.has(x) && !/^(exam|quiz|the|a)$/.test(x)).length;
    const close = !t.dueAt || !real.dueAt || Math.abs(Date.parse(t.dueAt) - Date.parse(real.dueAt)) < 3 * 864e5;
    if (overlap > 0 && close) store.deleteAssignment(t.id);
  }
}

// ---- iMessage summary ----

function formatDue(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function buildSummary(items: store.Assignment[]): string {
  const lines = items.slice(0, 10).map((a) => {
    const due = a.dueAt ? `, ${formatDue(a.dueAt).toLowerCase()}` : "";
    return `📝 ${a.title}${a.course ? ` (${a.course})` : ""}${due}`;
  });
  if (items.length > 10) lines.push(`+${items.length - 10} more`);
  return [`${items.length} new on canvas`, ...lines].join("\n");
}

async function notify(items: store.Assignment[]) {
  await notifyCanvas(buildSummary(items));
}

