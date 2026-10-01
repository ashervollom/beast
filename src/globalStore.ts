// Data that isn't any one user's: who the users are, invites, the waitlist, which user owns which chat,
// names of non-users seen in group chats, feedback, webhook dedupe and one-time link tokens.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config, MODELS } from "./config.js";
import { JsonDoc } from "./fileStore.js";
import { randomToken } from "./secrets.js";

export type UserStatus = "onboarding" | "active" | "paused";
export type OnboardingStep = "name" | "school";

export interface User {
  id: string;
  handle: string;
  name: string | null;
  role: "owner" | "user";
  status: UserStatus;
  onboardingStep: OnboardingStep | null;
  school: string | null;
  timezone: string;
  model: string;
  invitesLeft: number;
  invitedBy: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  /** Long random slugs, rotatable: /v/<dashboardSlug>, /cal/<calendarSlug>.ics */
  dashboardSlug: string;
  calendarSlug: string;
  /** Messages today, for the daily cap. */
  daily: { date: string; count: number };
  /** "delete my data" waiting for the confirmation, and when it was asked. */
  pendingDeleteAt: string | null;
  /** When Beast last offered each optional connection, so it offers again at most once a week. */
  offeredAt: Record<string, string>;
  /** When the model-outage line was last sent in each chat (at most once an hour). */
  outageNoticeAt: Record<string, string>;
}

export interface Invite {
  code: string;
  createdBy: string; // user id
  createdAt: string;
  note: string;
  /** The number it was made for (added as a Linq contact), if any. */
  phone: string | null;
  usedBy: string | null;
  usedAt: string | null;
}

export interface WaitlistEntry {
  email: string;
  createdAt: string;
  status: "waiting" | "invited" | "joined";
  inviteCode: string | null;
}

/** Non-users Beast has met in group chats. */
export interface Person {
  handle: string;
  name: string | null;
  askedIn: string | null;
  askedAt: string | null;
}

export interface Feedback {
  userId: string;
  text: string;
  at: string;
  source: "command" | "week1";
}

export type ConnectKind = "canvas";

export interface ConnectToken {
  userId: string;
  kind: ConnectKind;
  expiresAt: string;
}

interface GlobalDB {
  users: Record<string, User>;
  /** normalized handle -> user id */
  handles: Record<string, string>;
  invites: Record<string, Invite>;
  waitlist: WaitlistEntry[];
  /** group chat id -> the user that chat belongs to */
  groupOwners: Record<string, string>;
  people: Record<string, Person>;
  feedback: Feedback[];
  processedEvents: string[];
  /** Uninvited numbers already told "invite only", so they get one reply and then silence. */
  uninvitedReplied: Record<string, string>;
  connectTokens: Record<string, ConnectToken>;
}

const empty = (): GlobalDB => ({
  users: {},
  handles: {},
  invites: {},
  waitlist: [],
  groupOwners: {},
  people: {},
  feedback: [],
  processedEvents: [],
  uninvitedReplied: {},
  connectTokens: {},
});

export const globalFile = () => path.join(config.dataDir, "global.json");

let doc: JsonDoc<GlobalDB> | null = null;
const g = () => (doc ??= new JsonDoc(globalFile(), empty)).data;
const save = () => doc!.save();

/** Re-read from disk (tests, restores). */
export function reloadGlobal() {
  doc = null;
}

const now = () => new Date().toISOString();
export const normalizeHandle = (h: string) => h.replace(/[\s()-]/g, "").toLowerCase();

// ---- users ----

export function getUser(id: string): User | undefined {
  return g().users[id];
}

export function getUserByHandle(handle: string): User | undefined {
  const id = g().handles[normalizeHandle(handle)];
  return id ? g().users[id] : undefined;
}

export function getUserBySlug(kind: "dashboard" | "calendar", slug: string): User | undefined {
  if (!slug || slug.length < 20) return undefined;
  return Object.values(g().users).find((u) => (kind === "dashboard" ? u.dashboardSlug : u.calendarSlug) === slug);
}

export function listUsers(): User[] {
  return Object.values(g().users).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function owner(): User | undefined {
  return listUsers().find((u) => u.role === "owner");
}

export function createUser(init: Partial<User> & { handle: string }): User {
  const user: User = {
    id: randomUUID(),
    name: null,
    role: "user",
    status: "onboarding",
    onboardingStep: "name",
    school: null,
    timezone: config.timezone,
    model: MODELS.reply,
    invitesLeft: config.limits.invitesPerUser,
    invitedBy: null,
    createdAt: now(),
    lastActiveAt: null,
    dashboardSlug: randomToken(24),
    calendarSlug: randomToken(24),
    daily: { date: "", count: 0 },
    pendingDeleteAt: null,
    offeredAt: {},
    outageNoticeAt: {},
    ...init,
  };
  g().users[user.id] = user;
  g().handles[normalizeHandle(user.handle)] = user.id;
  save();
  return user;
}

export function updateUser(id: string, patch: Partial<User>): User {
  const user = g().users[id];
  if (!user) throw new Error("no such user");
  Object.assign(user, patch);
  save();
  return user;
}

/** Removes the user and everything global that points at them (handle, chats, unused invites, tokens). */
export function removeUser(id: string) {
  const db = g();
  const user = db.users[id];
  if (!user) return;
  delete db.handles[normalizeHandle(user.handle)];
  delete db.users[id];
  for (const [chat, uid] of Object.entries(db.groupOwners)) if (uid === id) delete db.groupOwners[chat];
  for (const [code, inv] of Object.entries(db.invites)) if (inv.createdBy === id && !inv.usedBy) delete db.invites[code];
  for (const [t, tok] of Object.entries(db.connectTokens)) if (tok.userId === id) delete db.connectTokens[t];
  db.feedback = db.feedback.filter((f) => f.userId !== id);
  save();
}

// ---- invites ----

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i, easy to read and type

export function createInvite(createdBy: string, note = "", phone: string | null = null): Invite {
  let code = "";
  do {
    code = Array.from({ length: 8 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  } while (g().invites[code]);
  const invite: Invite = { code, createdBy, createdAt: now(), note, phone, usedBy: null, usedAt: null };
  g().invites[code] = invite;
  save();
  return invite;
}

export function getInvite(code: string): Invite | undefined {
  return g().invites[code.toLowerCase()];
}

export function useInvite(code: string, userId: string) {
  const invite = g().invites[code.toLowerCase()];
  if (!invite || invite.usedBy) throw new Error("invite already used");
  invite.usedBy = userId;
  invite.usedAt = now();
  const entry = g().waitlist.find((w) => w.inviteCode === invite.code);
  if (entry) entry.status = "joined";
  save();
}

export function listInvites(): Invite[] {
  return Object.values(g().invites).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---- waitlist ----

export function joinWaitlist(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (g().waitlist.some((w) => w.email === e)) return false;
  g().waitlist.push({ email: e, createdAt: now(), status: "waiting", inviteCode: null });
  save();
  return true;
}

export function listWaitlist(): WaitlistEntry[] {
  return [...g().waitlist];
}

export function markWaitlistInvited(email: string, code: string) {
  const entry = g().waitlist.find((w) => w.email === email.trim().toLowerCase());
  if (!entry) return;
  entry.status = "invited";
  entry.inviteCode = code;
  save();
}

// ---- chat routing ----

export function groupOwner(chatId: string): string | undefined {
  return g().groupOwners[chatId];
}

export function setGroupOwner(chatId: string, userId: string) {
  g().groupOwners[chatId] = userId;
  save();
}

// ---- people met in group chats ----

export function getPerson(handle: string): Person | undefined {
  return g().people[normalizeHandle(handle)];
}

export function upsertPerson(handle: string, patch: Partial<Person>): Person {
  const key = normalizeHandle(handle);
  const person = (g().people[key] ??= { handle, name: null, askedIn: null, askedAt: null });
  Object.assign(person, patch);
  save();
  return person;
}

export function listPeople(): Person[] {
  return Object.values(g().people);
}

// ---- feedback ----

export function addFeedback(userId: string, text: string, source: Feedback["source"]) {
  g().feedback.push({ userId, text: text.trim().slice(0, 1000), at: now(), source });
  save();
}

export function listFeedback(): Feedback[] {
  return [...g().feedback].reverse();
}

// ---- webhook dedupe ----

/** Returns true the first time an event id is seen. */
export function markEventProcessed(eventId: string): boolean {
  const db = g();
  if (db.processedEvents.includes(eventId)) return false;
  db.processedEvents.push(eventId);
  if (db.processedEvents.length > 1000) db.processedEvents.splice(0, db.processedEvents.length - 1000);
  save();
  return true;
}

// ---- uninvited numbers ----

export function uninvitedRepliedAt(handle: string): string | undefined {
  return g().uninvitedReplied[normalizeHandle(handle)];
}

export function markUninvitedReplied(handle: string) {
  g().uninvitedReplied[normalizeHandle(handle)] = now();
  save();
}

// ---- one-time connect links ----

const CONNECT_TTL_MS = 30 * 60_000;

export function createConnectToken(userId: string, kind: ConnectKind): string {
  const db = g();
  // Drop expired tokens while we're here.
  for (const [t, tok] of Object.entries(db.connectTokens)) if (Date.parse(tok.expiresAt) < Date.now()) delete db.connectTokens[t];
  const token = randomToken(32);
  db.connectTokens[token] = { userId, kind, expiresAt: new Date(Date.now() + CONNECT_TTL_MS).toISOString() };
  save();
  return token;
}

export function peekConnectToken(token: string): ConnectToken | undefined {
  const tok = g().connectTokens[token];
  return tok && Date.parse(tok.expiresAt) > Date.now() ? tok : undefined;
}

export function consumeConnectToken(token: string) {
  delete g().connectTokens[token];
  save();
}

/** Migration only: writes the whole global document. */
export function writeGlobal(data: Partial<GlobalDB>) {
  doc = new JsonDoc(globalFile(), empty);
  Object.assign(doc.data, data);
  doc.save();
}
