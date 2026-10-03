// Owner sign-in for the /admin page: the ADMIN_TOKEN is exchanged once for a random session id kept in an
// httpOnly, SameSite=Strict cookie (Secure in the cloud). Sessions live in memory, so a deploy signs you out.
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { randomToken } from "./secrets.js";

const COOKIE = "beast_admin";
const TTL_MS = 12 * 3600_000;
const sessions = new Map<string, number>(); // id -> expires at

export function tokenMatches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(config.adminToken);
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(req: Request): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function hasSession(req: Request): boolean {
  const id = cookieValue(req);
  if (!id) return false;
  const exp = sessions.get(id);
  if (!exp || exp < Date.now()) {
    sessions.delete(id);
    return false;
  }
  return true;
}

function setCookie(res: Response, value: string, maxAgeSec: number) {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`];
  if (config.cloud) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function startSession(res: Response) {
  for (const [id, exp] of sessions) if (exp < Date.now()) sessions.delete(id);
  const id = randomToken(32);
  sessions.set(id, Date.now() + TTL_MS);
  setCookie(res, id, TTL_MS / 1000);
}

export function endSession(req: Request, res: Response) {
  const id = cookieValue(req);
  if (id) sessions.delete(id);
  setCookie(res, "", 0);
}
