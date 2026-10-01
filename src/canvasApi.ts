// Read-only Canvas REST client. It deliberately exposes GET only: nothing here can modify Canvas.
// The token is sent in the Authorization header and never appears in logs or error messages.
import type { CanvasCreds } from "./connections.js";

export class CanvasRateLimitError extends Error {}
export class CanvasApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const MAX_PAGES = 20;

async function get(url: string, creds: CanvasCreds): Promise<Response> {
  const base = new URL(creds.baseUrl);
  // Only ever send the token back to the user's own Canvas host.
  if (new URL(url).origin !== base.origin) throw new CanvasApiError("link pointed off the Canvas host");
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const where = new URL(url).pathname;
  if (res.status === 429 || (res.status === 403 && /rate limit/i.test(await res.clone().text()))) {
    throw new CanvasRateLimitError(`rate limited on ${where}`);
  }
  if (!res.ok) throw new CanvasApiError(`${where} returned HTTP ${res.status}`, res.status);
  return res;
}

/** GETs a Canvas API path and follows Link rel="next" pagination. Returns all rows. */
export async function canvasGetAll<T>(pathWithQuery: string, creds: CanvasCreds): Promise<T[]> {
  let url: string | null = `${creds.baseUrl.replace(/\/$/, "")}${pathWithQuery}`;
  const rows: T[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await get(url, creds);
    rows.push(...((await res.json()) as T[]));
    url = nextLink(res.headers.get("link"));
  }
  return rows;
}

/** GETs a single Canvas API object. */
export async function canvasGet<T>(pathWithQuery: string, creds: CanvasCreds): Promise<T> {
  const res = await get(`${creds.baseUrl.replace(/\/$/, "")}${pathWithQuery}`, creds);
  return (await res.json()) as T;
}

function nextLink(header: string | null): string | null {
  const m = header?.split(",").find((part) => /rel="next"/.test(part))?.match(/<([^>]+)>/);
  return m ? m[1] : null;
}

/** "canvas.eee.uci.edu", "https://x.instructure.com/" -> "https://canvas.eee.uci.edu" style origin, or null. */
export function normalizeCanvasBaseUrl(input: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
    if (u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}
