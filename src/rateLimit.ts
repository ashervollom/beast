// A small in-memory rate limiter for public endpoints (enough for one server).
import type { NextFunction, Request, Response } from "express";

/** Express middleware: at most `perMinute` requests per minute per IP for this path. */
export function limited(perMinute: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    if (!allow(hits, `${req.path}|${req.ip}`, perMinute, 60_000)) return void res.status(429).json({ error: "Slow down a sec and try again." });
    next();
  };
}

/** Records a hit for `key` and says whether it's within `max` per `windowMs`. */
export function allow(hits: Map<string, number[]>, key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear(); // crude cap so it can't grow without bound
  return true;
}
