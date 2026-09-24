import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

export type AssignmentType = "homework" | "exam" | "quiz" | "project" | "reading" | "paper" | "other";
export type Priority = "low" | "medium" | "high";
export type Status = "todo" | "in_progress" | "done";

export interface Assignment {
  id: string;
  title: string;
  course: string | null;
  type: AssignmentType;
  dueAt: string | null; // ISO 8601
  priority: Priority;
  status: Status;
  notes: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  source: "manual" | "canvas";
  canvasUid: string | null;
  url: string | null;
  // Canvas-owned fields, refreshed from the Canvas API. Never user-editable.
  canvasAssignmentId: number | null;
  canvasHtmlUrl: string | null;
  pointsPossible: number | null;
  canvasMissing: boolean;
  canvasSubmitted: boolean;
}

export interface Course {
  id: string;
  name: string;
  color: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
  emoji?: string;
  /** Who sent it, for user messages in group chats ("Asher", "Royce", a number). */
  from?: string;
}

/** A non-assignment Canvas calendar event (lecture, office hours, ...). Read-only context for the agent. */
export interface CalendarEvent {
  uid: string;
  title: string;
  course: string | null;
  start: string; // ISO 8601, or YYYY-MM-DD when allDay
  end: string | null;
  allDay: boolean;
  location: string;
  description: string;
  url: string | null;
}

export interface CanvasState {
  seenUids: string[]; // every assignment UID ever processed, imported or not
  courseMap: Record<string, string>; // Canvas course name -> course id
  events: CalendarEvent[]; // mirrored from the feed on every sync
  lastSyncAt: string | null;
  lastError: string | null;
  lastPlannerSyncAt: string | null;
  lastPlannerError: string | null;
}

export interface Settings {
  /** The student's own iMessage chat: the only place notifications go. */
  studentChatId: string | null;
  lastStudentMessageAt: string | null;
  /** The dashboard link Beast last texted Asher, and when. */
  dashboardLinkSent?: { url: string; at: string } | null;
}

export type ProactiveKind = "brief" | "nudge" | "final_nudge" | "nightly" | "canvas" | "catch_up";

export interface ProactiveState {
  /** Every proactive text sent (kept ~2 weeks): drives the daily cap, "unanswered" rule and no-repeat checks. */
  sent: { kind: ProactiveKind; at: string; assignmentIds?: string[] }[];
  /** Canvas notices held back by quiet hours / the cap, folded into the next morning brief. */
  held: string[];
  /** Last scheduler tick, to detect downtime after a restart. */
  lastTickAt: string | null;
}

interface DB {
  courses: Course[];
  assignments: Assignment[];
  conversations: Record<string, ChatTurn[]>;
  settings: Settings;
  proactive: ProactiveState;
  /** Per-chat switches, keyed like conversations ("imessage:<chatId>"). */
  chatModes: Record<string, { roast: boolean }>;
  processedEvents: string[];
  canvas: CanvasState;
}

const CANVAS_DEFAULTS = {
  source: "manual" as const,
  canvasUid: null,
  url: null,
  canvasAssignmentId: null,
  canvasHtmlUrl: null,
  pointsPossible: null,
  canvasMissing: false,
  canvasSubmitted: false,
};

/** Canvas .ics assignment UIDs look like "event-assignment-1924923", where the number is the assignment id. */
export function canvasAssignmentIdFromUid(uid: string | null | undefined): number | null {
  const m = uid?.match(/^event-assignment-(\d+)$/);
  return m ? Number(m[1]) : null;
}

const PALETTE = ["#4f7cff", "#e2567a", "#2fb380", "#f0a020", "#9b6cf0", "#1fb5c9", "#e26d3d", "#6b8a3a"];

const empty = (): DB => ({
  courses: [],
  assignments: [],
  conversations: {},
  settings: { studentChatId: null, lastStudentMessageAt: null },
  proactive: { sent: [], held: [], lastTickAt: null },
  chatModes: {},
  processedEvents: [],
  canvas: {
    seenUids: [],
    courseMap: {},
    events: [],
    lastSyncAt: null,
    lastError: null,
    lastPlannerSyncAt: null,
    lastPlannerError: null,
  },
});

let db: DB = load();

function load(): DB {
  try {
    const data: DB = { ...empty(), ...JSON.parse(fs.readFileSync(config.dataFile, "utf8")) };
    data.canvas = { ...empty().canvas, ...data.canvas };
    data.proactive = { ...empty().proactive, ...data.proactive };
    // digestChatId was "whoever texted last"; notifications now only go to the student's chat.
    const { digestChatId: _old, lastDigestDate: _old2, ...settings } = data.settings as Settings & Record<string, unknown>;
    data.settings = { ...empty().settings, ...settings };
    // Fill fields added after an assignment was saved.
    data.assignments = data.assignments.map((a) => ({ ...CANVAS_DEFAULTS, ...a, canvasAssignmentId: a.canvasAssignmentId ?? canvasAssignmentIdFromUid(a.canvasUid) }));
    return data;
  } catch {
    return empty();
  }
}

function save() {
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  const tmp = `${config.dataFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, config.dataFile);
}

const now = () => new Date().toISOString();

// ---- courses ----

export function listCourses(): Course[] {
  return [...db.courses].sort((a, b) => a.name.localeCompare(b.name));
}

export function findCourse(name: string): Course | undefined {
  const n = name.trim().toLowerCase();
  return db.courses.find((c) => c.name.toLowerCase() === n);
}

export function addCourse(name: string, color?: string): Course {
  const existing = findCourse(name);
  if (existing) return existing;
  const course: Course = {
    id: randomUUID(),
    name: name.trim(),
    color: color ?? PALETTE[db.courses.length % PALETTE.length],
  };
  db.courses.push(course);
  save();
  return course;
}

export function deleteCourse(id: string): boolean {
  const before = db.courses.length;
  db.courses = db.courses.filter((c) => c.id !== id);
  save();
  return db.courses.length !== before;
}

// ---- assignments ----

export interface AssignmentFilter {
  status?: Status | "open" | "all";
  course?: string;
  dueBefore?: string;
  dueAfter?: string;
}

export function listAssignments(filter: AssignmentFilter = {}): Assignment[] {
  const status = filter.status ?? "open";
  return db.assignments
    .filter((a) => {
      if (status === "open" && a.status === "done") return false;
      if (status !== "open" && status !== "all" && a.status !== status) return false;
      if (filter.course && a.course?.toLowerCase() !== filter.course.toLowerCase()) return false;
      if (filter.dueBefore && (!a.dueAt || a.dueAt > filter.dueBefore)) return false;
      if (filter.dueAfter && (!a.dueAt || a.dueAt < filter.dueAfter)) return false;
      return true;
    })
    .sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
}

export function getAssignment(id: string): Assignment | undefined {
  return db.assignments.find((a) => a.id === id);
}

type CanvasOwned = "canvasAssignmentId" | "canvasHtmlUrl" | "pointsPossible" | "canvasMissing" | "canvasSubmitted";
export type AssignmentInput = Partial<Omit<Assignment, "id" | "createdAt" | "updatedAt" | "completedAt" | CanvasOwned>>;
/** What the REST API and the agent may change; provenance fields stay fixed. */
export type AssignmentPatch = Omit<AssignmentInput, "source" | "canvasUid" | "url">;
export type CanvasInfo = Partial<Pick<Assignment, CanvasOwned>>;

export function addAssignment(input: AssignmentInput & { title: string }): Assignment {
  if (input.course) addCourse(input.course);
  const a: Assignment = {
    id: randomUUID(),
    title: input.title,
    course: input.course ? (findCourse(input.course)?.name ?? input.course) : null,
    type: input.type ?? "homework",
    dueAt: input.dueAt ?? null,
    priority: input.priority ?? "medium",
    status: input.status ?? "todo",
    notes: input.notes ?? "",
    createdAt: now(),
    updatedAt: now(),
    completedAt: input.status === "done" ? now() : null,
    ...CANVAS_DEFAULTS,
    source: input.source ?? "manual",
    canvasUid: input.canvasUid ?? null,
    url: input.url ?? null,
    canvasAssignmentId: canvasAssignmentIdFromUid(input.canvasUid),
  };
  db.assignments.push(a);
  save();
  return a;
}

export function updateAssignment(id: string, input: AssignmentPatch): Assignment | undefined {
  const a = getAssignment(id);
  if (!a) return undefined;
  const {
    source: _s,
    canvasUid: _u,
    url: _l,
    canvasAssignmentId: _a,
    canvasHtmlUrl: _h,
    pointsPossible: _p,
    canvasMissing: _m,
    canvasSubmitted: _c,
    ...patch
  } = input as AssignmentInput & CanvasInfo;
  if (patch.course) addCourse(patch.course);
  const wasDone = a.status === "done";
  Object.assign(a, patch, { updatedAt: now() });
  if (patch.course) a.course = findCourse(patch.course)?.name ?? patch.course;
  if (a.status === "done" && !wasDone) a.completedAt = now();
  if (a.status !== "done") a.completedAt = null;
  save();
  return a;
}

export function deleteAssignment(id: string): boolean {
  const before = db.assignments.length;
  db.assignments = db.assignments.filter((a) => a.id !== id);
  save();
  return db.assignments.length !== before;
}

// ---- conversations ----

// Trim in chunks (50 -> 30) rather than one at a time, so the agent's 20-29 message history window
// only shifts every 10 messages and the prompt cache keeps hitting.
const TRIM_AT = 50;
const TRIM_TO = 30;

export function getConversation(key: string): ChatTurn[] {
  return db.conversations[key] ?? [];
}

export function appendTurn(key: string, turn: Omit<ChatTurn, "at">) {
  const list = (db.conversations[key] ??= []);
  list.push({ ...turn, at: now() });
  if (list.length > TRIM_AT) list.splice(0, TRIM_AT - TRIM_TO);
  save();
}

export function clearConversation(key: string) {
  delete db.conversations[key];
  save();
}

// ---- settings / webhook dedupe ----

export function getSettings(): Readonly<Settings> {
  return db.settings;
}

export function updateSettings(patch: Partial<Settings>) {
  Object.assign(db.settings, patch);
  save();
}

/** Returns true the first time an event id is seen. */
export function markEventProcessed(eventId: string): boolean {
  if (db.processedEvents.includes(eventId)) return false;
  db.processedEvents.push(eventId);
  if (db.processedEvents.length > 500) db.processedEvents.splice(0, db.processedEvents.length - 500);
  save();
  return true;
}

// ---- canvas ----

export function getCanvasState(): Readonly<CanvasState> {
  return db.canvas;
}

export function isCanvasUidSeen(uid: string): boolean {
  return db.canvas.seenUids.includes(uid);
}

/** Creates the assignment and records its UID in one save, so a crash can't cause a duplicate import. */
export function importCanvasAssignment(uid: string, input: AssignmentInput & { title: string }): Assignment {
  db.canvas.seenUids.push(uid);
  return addAssignment({ ...input, source: "canvas", canvasUid: uid });
}

export function markCanvasUidsSeen(uids: string[]) {
  for (const uid of uids) if (!db.canvas.seenUids.includes(uid)) db.canvas.seenUids.push(uid);
  save();
}

export function mapCanvasCourse(canvasName: string, courseId: string) {
  db.canvas.courseMap[canvasName] = courseId;
  save();
}

export function getCourseById(id: string): Course | undefined {
  return db.courses.find((c) => c.id === id);
}

/** Updates Canvas-owned fields only; the student's own edits are left alone. Returns true if anything changed. */
export function applyCanvasInfo(id: string, info: CanvasInfo, opts: { markDone?: boolean } = {}): boolean {
  const a = getAssignment(id);
  if (!a) return false;
  let changed = false;
  for (const [k, v] of Object.entries(info) as [keyof CanvasInfo, never][]) {
    if (a[k] !== v) {
      a[k] = v;
      changed = true;
    }
  }
  if (opts.markDone && a.status !== "done") {
    a.status = "done";
    a.completedAt = now();
    a.updatedAt = now();
    changed = true;
  }
  if (changed) save();
  return changed;
}

export function finishPlannerSync(error: string | null) {
  if (!error) db.canvas.lastPlannerSyncAt = now();
  db.canvas.lastPlannerError = error;
  save();
}

export function finishCanvasSync(events: CalendarEvent[] | null, error: string | null) {
  if (events) db.canvas.events = events;
  if (!error) db.canvas.lastSyncAt = now();
  db.canvas.lastError = error;
  save();
}

export function listCalendarEvents(): CalendarEvent[] {
  return [...db.canvas.events].sort((a, b) => a.start.localeCompare(b.start));
}

// ---- proactive texts ----

export function getProactive(): Readonly<ProactiveState> {
  return db.proactive;
}

export function recordProactive(kind: ProactiveKind, at: Date, assignmentIds?: string[]) {
  db.proactive.sent.push({ kind, at: at.toISOString(), ...(assignmentIds?.length ? { assignmentIds } : {}) });
  const cutoff = at.getTime() - 14 * 864e5;
  db.proactive.sent = db.proactive.sent.filter((s) => Date.parse(s.at) >= cutoff);
  save();
}

export function holdNotice(text: string) {
  db.proactive.held.push(text);
  save();
}

export function takeHeldNotices(): string[] {
  const held = db.proactive.held;
  db.proactive.held = [];
  save();
  return held;
}

export function setLastTick(at: Date) {
  db.proactive.lastTickAt = at.toISOString();
  save();
}

// ---- per-chat modes ----

/** Roast mode: off by default. Only the student can turn it on, per chat. */
export function isRoastMode(conversationKey: string): boolean {
  return db.chatModes[conversationKey]?.roast ?? false;
}

export function setRoastMode(conversationKey: string, on: boolean) {
  db.chatModes[conversationKey] = { ...db.chatModes[conversationKey], roast: on };
  save();
}
