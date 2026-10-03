// Data that isn't any one user's: who the users are, invites, the waitlist, which user owns which chat,
// names of non-users seen in group chats, feedback, webhook dedupe and one-time link tokens.
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config, MODELS } from "./config.js";
import { JsonDoc } from "./fileStore.js";
import { randomToken } from "./secrets.js";

export type UserStatus = "onboarding" | "active" | "paused";
export type OnboardingStep = "welcome" | "name" | "school";

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
  /** The user's own reusable invite link code (see personalInvite). */
  personalInvite?: string;
  /** Texts-from-Beast settings from the account page; unset fields use the server defaults. */
  prefs?: Partial<Prefs>;
}

export interface Prefs {
  briefTime: string; // "06:30"
  quietStart: string; // "23:00"
  quietEnd: string; // "08:00"
  nudges: boolean;
  nightly: boolean;
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
  /** Links stop working after this; an unused expired invite is refunded to its creator once. */
  expiresAt?: string;
  refunded?: boolean;
  /** A user's personal reusable link: works while its creator has invites left, never expires. */
  personal?: boolean;
  /** Everyone who joined through a personal link. */
  usedByAll?: string[];
}

export type InviteState = "ok" | "used" | "expired" | "missing";

export interface WaitlistEntry {
  /** An email or an E.164 phone number. */
  email: string;
  kind?: "email" | "phone";
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
  /** Signed-in account sessions: sha256(session id) -> user. Stored so a deploy doesn't sign everyone out. */
  sessions: Record<string, { userId: string; expiresAt: string }>;
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
  sessions: {},
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
const CODE_LENGTH = 12; // ~59 bits, and the join endpoint is rate-limited, so codes can't be guessed
const INVITE_TTL_MS = 14 * 864e5;

export function createInvite(createdBy: string, note = "", phone: string | null = null): Invite {
  let code = "";
  do {
    code = Array.from(randomBytes(CODE_LENGTH), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  } while (g().invites[code]);
  const invite: Invite = {
    code,
    createdBy,
    createdAt: now(),
    note,
    phone,
    usedBy: null,
    usedAt: null,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
  };
  g().invites[code] = invite;
  save();
  return invite;
}

export function getInvite(code: string): Invite | undefined {
  return g().invites[code.trim().toLowerCase()];
}

export function inviteState(code: string): InviteState {
  const invite = getInvite(code);
  if (!invite) return "missing";
  if (invite.personal) {
    // Reusable: open while its owner has invites left (the Beast owner always does).
    const creator = g().users[invite.createdBy];
    return creator && (creator.role === "owner" || creator.invitesLeft > 0) ? "ok" : "used";
  }
  if (invite.usedBy) return "used";
  if (invite.expiresAt && Date.parse(invite.expiresAt) < Date.now()) return "expired";
  return "ok";
}

/**
 * Burns the invite for this user (or, for a personal link, uses up one of its owner's invites). The check and
 * the write happen in one synchronous step, so two people racing on the same link can't both get in.
 */
export function redeemInvite(code: string, userId: string): boolean {
  if (inviteState(code) !== "ok") return false;
  const invite = getInvite(code)!;
  if (invite.personal) {
    (invite.usedByAll ??= []).push(userId);
    invite.usedAt = now();
    const creator = g().users[invite.createdBy];
    if (creator && creator.role !== "owner") creator.invitesLeft -= 1;
    save();
    return true;
  }
  invite.usedBy = userId;
  invite.usedAt = now();
  const entry = g().waitlist.find((w) => w.inviteCode === invite.code);
  if (entry) entry.status = "joined";
  save();
  return true;
}

export const INVITE_NAME = /^[a-z0-9-]{8,64}$/;

/**
 * A user's own reusable invite link, created on first use. `name` renames it (8–64 lowercase letters, numbers,
 * hyphens) if that name isn't taken. Returns the invite and how many people joined through it.
 */
export function personalInvite(userId: string, name?: string): { invite: Invite; joined: number; error?: string } {
  const user = g().users[userId];
  if (!user) throw new Error("no such user");
  let invite = user.personalInvite ? g().invites[user.personalInvite] : undefined;
  if (!invite) {
    invite = createInvite(userId, "personal link");
    invite.personal = true;
    delete invite.expiresAt;
    user.personalInvite = invite.code;
    save();
  }
  if (name !== undefined && name !== invite.code) {
    const wanted = name.trim().toLowerCase();
    if (!INVITE_NAME.test(wanted)) return { invite, joined: invite.usedByAll?.length ?? 0, error: "Use 8–64 lowercase letters, numbers or hyphens." };
    if (g().invites[wanted]) return { invite, joined: invite.usedByAll?.length ?? 0, error: "That name is taken." };
    delete g().invites[invite.code];
    invite.code = wanted;
    g().invites[wanted] = invite;
    user.personalInvite = wanted;
    save();
  }
  return { invite, joined: invite.usedByAll?.length ?? 0 };
}

/** Expires an open invite now (admin "revoke"); a user's spent invite comes back right away. */
export function revokeInvite(code: string): boolean {
  if (getInvite(code)?.personal) return false; // personal links are controlled by their owner's invite count
  if (inviteState(code) !== "ok") return false;
  const invite = getInvite(code)!;
  invite.expiresAt = new Date(Date.now() - 1000).toISOString();
  save();
  refundExpiredInvites();
  return true;
}

/** Gives an expired, unused invite back to whoever made it (owners have unlimited invites anyway). */
export function refundExpiredInvites(): number {
  let refunded = 0;
  for (const invite of Object.values(g().invites)) {
    if (invite.usedBy || invite.refunded || !invite.expiresAt || Date.parse(invite.expiresAt) > Date.now()) continue;
    invite.refunded = true;
    const user = g().users[invite.createdBy];
    if (user && user.role !== "owner") user.invitesLeft += 1;
    refunded++;
  }
  if (refunded) save();
  return refunded;
}

export function listInvites(): Invite[] {
  return Object.values(g().invites).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---- waitlist ----

export function joinWaitlist(contact: string, kind: "email" | "phone" = "email"): boolean {
  const e = contact.trim().toLowerCase();
  if (g().waitlist.some((w) => w.email === e)) return false;
  g().waitlist.push({ email: e, kind, createdAt: now(), status: "waiting", inviteCode: null });
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

// ---- account sessions (the /app sign-in) ----

const SESSION_TTL_MS = 30 * 864e5;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Starts a session and returns the raw id for the cookie (only its hash is stored). */
export function createSession(userId: string): string {
  const db = g();
  for (const [k, s] of Object.entries(db.sessions)) if (Date.parse(s.expiresAt) < Date.now()) delete db.sessions[k];
  const id = randomToken(32);
  db.sessions[sha(id)] = { userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() };
  save();
  return id;
}

export function sessionUser(id: string): User | undefined {
  const s = g().sessions[sha(id)];
  if (!s || Date.parse(s.expiresAt) < Date.now()) return undefined;
  return g().users[s.userId];
}

export function endSession(id: string) {
  delete g().sessions[sha(id)];
  save();
}

/** Signs a user out everywhere (account deleted, number changed). */
export function endUserSessions(userId: string) {
  for (const [k, s] of Object.entries(g().sessions)) if (s.userId === userId) delete g().sessions[k];
  save();
}
