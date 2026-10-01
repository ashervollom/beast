// Per-user data: one JSON file per user (data/users/<id>.json). Every function here works on the
// current user from withUser(); calling one without a user context throws (see userContext.ts).
// Global data (users, invites, chat routing) lives in globalStore.ts.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { JsonDoc } from "./fileStore.js";
import { currentUserId } from "./userContext.js";

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
  source: "manual" | "canvas" | "syllabus";
  canvasUid: string | null;
  url: string | null;
  /** Found in a syllabus or course site, not confirmed by Canvas yet. */
  tentative?: boolean;
  /** Set on items the course scan created ("exam:<section>:<slug>"), so rescans update instead of duplicating. */
  scanKey?: string;
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
  /** Who sent it, for user messages in group chats. */
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
  /** The user's own 1:1 iMessage chat: the only place proactive texts go. */
  chatId: string | null;
  lastMessageAt: string | null;
}

export type ProactiveKind = "brief" | "nudge" | "final_nudge" | "nightly" | "canvas" | "catch_up";

export interface ProactiveState {
  /** Every proactive text sent (kept ~2 weeks): drives the daily cap, "unanswered" rule and no-repeat checks. */
  sent: { kind: ProactiveKind; at: string; assignmentIds?: string[] }[];
  /** Notices held back by quiet hours / the cap, folded into the next morning brief. */
  held: string[];
  /** Last scheduler tick, to detect downtime after a restart. */
  lastTickAt: string | null;
}

export type ConnectionKind = "canvas" | "canvas_ics";

export interface Connection {
  /** Encrypted with secrets.encrypt(). Never logged or shown. */
  secret: string;
  /** Non-secret details, e.g. the Canvas host. */
  meta: Record<string, string>;
  addedAt: string;
  lastOkAt: string | null;
  lastError: string | null;
}

export interface MemoryItem {
  id: string;
  text: string;
  at: string;
}

export interface UsageDay {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  calls: number;
}

export interface UserDB {
  courses: Course[];
  assignments: Assignment[];
  conversations: Record<string, ChatTurn[]>;
  settings: Settings;
  proactive: ProactiveState;
  /** Per-chat switches, keyed like conversations ("imessage:<chatId>"). */
  chatModes: Record<string, { roast: boolean }>;
  /** The dashboard link last sent in each chat, and when. */
  linkSent: Record<string, { url: string; at: string }>;
  canvas: CanvasState;
  connections: Partial<Record<ConnectionKind, Connection>>;
  /** What Beast has learned about the user (the `remember` tool). */
  memory: MemoryItem[];
  /** Model spend per local day (YYYY-MM-DD). */
  usage: Record<string, UsageDay>;
  /** Feature counts per local day: metrics[date][feature] = count. */
  metrics: Record<string, Record<string, number>>;
  /** Deep scan results per Canvas course id (see courseScan.ts). */
  courseProfiles: Record<string, CourseProfile>;
}

export interface CourseMeeting {
  kind: string; // "Lec", "Dis", "Lab"
  section: string; // "A", "A1"
  code: string;
  days: string; // "TuTh"
  start: string; // "12:30"
  end: string;
  location: string;
}

export interface CourseFacts {
  summary: string;
  officeHours: { who: string; when: string; where: string }[];
  zoomLinks: { label: string; url: string }[];
  grading: { item: string; weight: string }[];
  policies: { topic: string; text: string }[];
  textbook: string | null;
  exams: { title: string; type: string; date: string | null; time: string | null; source: string; confidence: string }[];
  keyDates: { title: string; date: string; source: string }[];
  sectionInfo: string | null;
}

export interface CourseProfile {
  canvasCourseId: number;
  /** The board's course name (matches assignments). */
  course: string;
  canvasUrl: string;
  dept: string | null;
  number: string | null;
  title: string | null;
  sectionCode: string | null;
  instructors: string[];
  meetings: CourseMeeting[];
  final: { date: string; start: string; end: string; location: string } | null;
  website: string | null;
  links: { label: string; url: string; kind: string }[];
  facts: CourseFacts | null;
  /** Short excerpts kept for find_course_info (never whole documents). */
  excerpts: { source: string; url: string; text: string }[];
  gaps: string[];
  sources: string[];
  contentHash: string;
  lastScannedAt: string;
  /** Lab/discussion sections that fit; Beast asks once which one is theirs. */
  sectionChoice: { kind: string; options: { code: string; label: string }[]; askedAt: string | null } | null;
  /** Lab/discussion section codes the user picked. */
  chosenSections: string[];
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

export const emptyUserDB = (): UserDB => ({
  courses: [],
  assignments: [],
  conversations: {},
  settings: { chatId: null, lastMessageAt: null },
  proactive: { sent: [], held: [], lastTickAt: null },
  chatModes: {},
  linkSent: {},
  canvas: {
    seenUids: [],
    courseMap: {},
    events: [],
    lastSyncAt: null,
    lastError: null,
    lastPlannerSyncAt: null,
    lastPlannerError: null,
  },
  connections: {},
  memory: [],
  usage: {},
  metrics: {},
  courseProfiles: {},
});

function upgrade(data: UserDB): UserDB {
  const e = emptyUserDB();
  data.canvas = { ...e.canvas, ...data.canvas };
  data.proactive = { ...e.proactive, ...data.proactive };
  data.settings = { ...e.settings, ...data.settings };
  // Fill fields added after an assignment was saved.
  data.assignments = data.assignments.map((a) => ({ ...CANVAS_DEFAULTS, ...a, canvasAssignmentId: a.canvasAssignmentId ?? canvasAssignmentIdFromUid(a.canvasUid) }));
  return data;
}

// ---- files ----

const docs = new Map<string, JsonDoc<UserDB>>();

export const userFile = (userId: string) => path.join(config.dataDir, "users", `${userId}.json`);

function doc(): JsonDoc<UserDB> {
  const id = currentUserId();
  let d = docs.get(id);
  if (!d) {
    d = new JsonDoc(userFile(id), emptyUserDB, upgrade);
    docs.set(id, d);
  }
  return d;
}

const db = () => doc().data;
const save = () => doc().save();

/** Writes a whole user file (migration). */
export function writeUserFile(userId: string, data: UserDB) {
  const d = new JsonDoc(userFile(userId), emptyUserDB, upgrade);
  Object.assign(d.data, data);
  d.save();
  docs.set(userId, d);
}

/** "delete my data": removes the current user's file and forgets the cached copy. */
export function deleteCurrentUserData() {
  const id = currentUserId();
  docs.delete(id);
  fs.rmSync(userFile(id), { force: true });
}

const now = () => new Date().toISOString();

// ---- courses ----

export function listCourses(): Course[] {
  return [...db().courses].sort((a, b) => a.name.localeCompare(b.name));
}

export function findCourse(name: string): Course | undefined {
  const n = name.trim().toLowerCase();
  return db().courses.find((c) => c.name.toLowerCase() === n);
}

export function addCourse(name: string, color?: string): Course {
  const existing = findCourse(name);
  if (existing) return existing;
  const course: Course = {
    id: randomUUID(),
    name: name.trim(),
    color: color ?? PALETTE[db().courses.length % PALETTE.length],
  };
  db().courses.push(course);
  save();
  return course;
}

/** Renames a course everywhere (its assignments too). The id, and so the Canvas mapping, stays the same. */
export function renameCourse(id: string, name: string) {
  const c = getCourseById(id);
  if (!c || c.name === name || findCourse(name)) return;
  for (const a of db().assignments) if (a.course === c.name) a.course = name;
  c.name = name;
  save();
}

export function deleteCourse(id: string): boolean {
  const before = db().courses.length;
  db().courses = db().courses.filter((c) => c.id !== id);
  save();
  return db().courses.length !== before;
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
  return db()
    .assignments.filter((a) => {
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
  return db().assignments.find((a) => a.id === id);
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
    ...(input.tentative ? { tentative: true } : {}),
    ...(input.scanKey ? { scanKey: input.scanKey } : {}),
    canvasAssignmentId: canvasAssignmentIdFromUid(input.canvasUid),
  };
  db().assignments.push(a);
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
  const before = db().assignments.length;
  db().assignments = db().assignments.filter((a) => a.id !== id);
  save();
  return db().assignments.length !== before;
}

// ---- conversations ----

// Trim in chunks (50 -> 30) rather than one at a time, so the agent's 20-29 message history window
// only shifts every 10 messages and the prompt cache keeps hitting.
const TRIM_AT = 50;
const TRIM_TO = 30;

export function getConversation(key: string): ChatTurn[] {
  return db().conversations[key] ?? [];
}

export function appendTurn(key: string, turn: Omit<ChatTurn, "at">) {
  const list = (db().conversations[key] ??= []);
  list.push({ ...turn, at: now() });
  if (list.length > TRIM_AT) list.splice(0, TRIM_AT - TRIM_TO);
  save();
}

export function clearConversation(key: string) {
  delete db().conversations[key];
  save();
}

// ---- settings ----

export function getSettings(): Readonly<Settings> {
  return db().settings;
}

export function updateSettings(patch: Partial<Settings>) {
  Object.assign(db().settings, patch);
  save();
}

// ---- canvas ----

export function getCanvasState(): Readonly<CanvasState> {
  return db().canvas;
}

export function isCanvasUidSeen(uid: string): boolean {
  return db().canvas.seenUids.includes(uid);
}

/** Creates the assignment and records its UID in one save, so a crash can't cause a duplicate import. */
export function importCanvasAssignment(uid: string, input: AssignmentInput & { title: string }): Assignment {
  db().canvas.seenUids.push(uid);
  return addAssignment({ ...input, source: "canvas", canvasUid: uid });
}

export function markCanvasUidsSeen(uids: string[]) {
  for (const uid of uids) if (!db().canvas.seenUids.includes(uid)) db().canvas.seenUids.push(uid);
  save();
}

export function mapCanvasCourse(canvasName: string, courseId: string) {
  db().canvas.courseMap[canvasName] = courseId;
  save();
}

export function getCourseById(id: string): Course | undefined {
  return db().courses.find((c) => c.id === id);
}

/** Updates Canvas-owned fields only; the user's own edits are left alone. Returns true if anything changed. */
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
  if (!error) db().canvas.lastPlannerSyncAt = now();
  db().canvas.lastPlannerError = error;
  save();
}

export function finishCanvasSync(events: CalendarEvent[] | null, error: string | null) {
  if (events) db().canvas.events = events;
  if (!error) db().canvas.lastSyncAt = now();
  db().canvas.lastError = error;
  save();
}

export function listCalendarEvents(): CalendarEvent[] {
  return [...db().canvas.events].sort((a, b) => a.start.localeCompare(b.start));
}

// ---- proactive texts ----

export function getProactive(): Readonly<ProactiveState> {
  return db().proactive;
}

export function recordProactive(kind: ProactiveKind, at: Date, assignmentIds?: string[]) {
  db().proactive.sent.push({ kind, at: at.toISOString(), ...(assignmentIds?.length ? { assignmentIds } : {}) });
  const cutoff = at.getTime() - 14 * 864e5;
  db().proactive.sent = db().proactive.sent.filter((s) => Date.parse(s.at) >= cutoff);
  save();
}

export function holdNotice(text: string) {
  db().proactive.held.push(text);
  save();
}

export function takeHeldNotices(): string[] {
  const held = db().proactive.held;
  db().proactive.held = [];
  save();
  return held;
}

export function setLastTick(at: Date) {
  db().proactive.lastTickAt = at.toISOString();
  save();
}

// ---- per-chat modes ----

/** Roast mode: off by default. Only the user can turn it on, per chat. */
export function isRoastMode(conversationKey: string): boolean {
  return db().chatModes[conversationKey]?.roast ?? false;
}

export function setRoastMode(conversationKey: string, on: boolean) {
  db().chatModes[conversationKey] = { ...db().chatModes[conversationKey], roast: on };
  save();
}

// ---- dashboard link, per chat ----

export function getLinkSent(conversationKey: string): { url: string; at: string } | undefined {
  return db().linkSent[conversationKey];
}

export function recordLinkSent(conversationKey: string, url: string) {
  db().linkSent[conversationKey] = { url, at: now() };
  save();
}

// ---- connections (encrypted; see connections.ts) ----

export function getConnectionRecord(kind: ConnectionKind): Connection | undefined {
  return db().connections[kind];
}

export function setConnectionRecord(kind: ConnectionKind, record: Connection | null) {
  if (record) db().connections[kind] = record;
  else delete db().connections[kind];
  save();
}

export function listConnectionKinds(): ConnectionKind[] {
  return Object.keys(db().connections) as ConnectionKind[];
}

// ---- memory ----

const MEMORY_MAX = 80;
const MEMORY_CHARS = 300;

export function listMemory(): MemoryItem[] {
  return db().memory;
}

export function addMemory(text: string): MemoryItem {
  const item = { id: randomUUID().slice(0, 8), text: text.trim().slice(0, MEMORY_CHARS), at: now() };
  db().memory.push(item);
  if (db().memory.length > MEMORY_MAX) db().memory.splice(0, db().memory.length - MEMORY_MAX);
  save();
  return item;
}

export function removeMemory(ids: string[]): number {
  const before = db().memory.length;
  db().memory = db().memory.filter((m) => !ids.includes(m.id));
  save();
  return before - db().memory.length;
}

// ---- usage and metrics ----

export function recordUsage(date: string, add: Omit<UsageDay, "calls">) {
  const day = (db().usage[date] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, calls: 0 });
  day.inputTokens += add.inputTokens;
  day.outputTokens += add.outputTokens;
  day.cacheReadTokens += add.cacheReadTokens;
  day.cacheWriteTokens += add.cacheWriteTokens;
  day.costUsd += add.costUsd;
  day.calls += 1;
  save();
}

export function getUsage(): Readonly<Record<string, UsageDay>> {
  return db().usage;
}

export function bumpMetric(date: string, feature: string, by = 1) {
  const day = (db().metrics[date] ??= {});
  day[feature] = (day[feature] ?? 0) + by;
  save();
}

export function getMetrics(): Readonly<Record<string, Record<string, number>>> {
  return db().metrics;
}

// ---- course profiles ----

export function getCourseProfiles(): Readonly<Record<string, CourseProfile>> {
  return db().courseProfiles ?? {};
}

export function setCourseProfile(profile: CourseProfile) {
  (db().courseProfiles ??= {})[String(profile.canvasCourseId)] = profile;
  save();
}

export function findByScanKey(key: string): Assignment | undefined {
  return db().assignments.find((a) => a.scanKey === key);
}
