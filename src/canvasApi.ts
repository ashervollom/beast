// Read-only Canvas REST client. It deliberately exposes GET only: nothing here can modify Canvas.
// The token is sent in the Authorization header and never appears in logs or error messages.
import { config } from "./config.js";

export class CanvasRateLimitError extends Error {}
export class CanvasApiError extends Error {}

const MAX_PAGES = 20;

export function canvasApiConfigured(): boolean {
  return Boolean(config.canvasBaseUrl && config.canvasToken);
}

/** GETs a Canvas API path and follows Link rel="next" pagination. Returns all rows. */
export async function canvasGetAll<T>(pathWithQuery: string): Promise<T[]> {
  const base = config.canvasBaseUrl.replace(/\/$/, "");
  let url: string | null = `${base}${pathWithQuery}`;
  const rows: T[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    // Only ever follow links back to the same Canvas host, so the token can't leak elsewhere.
    if (new URL(url).origin !== new URL(base).origin) throw new CanvasApiError("pagination link pointed off-host");
    const res: Response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.canvasToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    const where = new URL(url).pathname;
    if (res.status === 429 || (res.status === 403 && /rate limit/i.test(await res.clone().text()))) {
      throw new CanvasRateLimitError(`rate limited on ${where}`);
    }
    if (!res.ok) throw new CanvasApiError(`${where} returned HTTP ${res.status}`);
    const body = (await res.json()) as T[];
    rows.push(...body);
    url = nextLink(res.headers.get("link"));
  }
  return rows;
}

function nextLink(header: string | null): string | null {
  const m = header?.split(",").find((part) => /rel="next"/.test(part))?.match(/<([^>]+)>/);
  return m ? m[1] : null;
}
