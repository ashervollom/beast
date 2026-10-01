// A user's optional connections (Canvas token, Canvas calendar feed). Secrets are stored encrypted
// and only decrypted right here, right before use.
import { decrypt, encrypt } from "./secrets.js";
import * as store from "./store.js";

export interface CanvasCreds {
  baseUrl: string;
  token: string;
}

export function canvasCreds(): CanvasCreds | null {
  const c = store.getConnectionRecord("canvas");
  if (!c?.meta.baseUrl) return null;
  try {
    return { baseUrl: c.meta.baseUrl, token: decrypt(c.secret) };
  } catch {
    return null;
  }
}

export function canvasIcsUrl(): string | null {
  const c = store.getConnectionRecord("canvas_ics");
  if (!c) return null;
  try {
    return decrypt(c.secret);
  } catch {
    return null;
  }
}

export function saveConnection(kind: store.ConnectionKind, secret: string, meta: Record<string, string> = {}) {
  store.setConnectionRecord(kind, {
    secret: encrypt(secret),
    meta,
    addedAt: new Date().toISOString(),
    lastOkAt: new Date().toISOString(),
    lastError: null,
  });
}

export function removeConnection(kind: store.ConnectionKind) {
  store.setConnectionRecord(kind, null);
}

export function isConnected(kind: store.ConnectionKind): boolean {
  return Boolean(store.getConnectionRecord(kind));
}

/** Records the outcome of using a connection (shown to the agent, so it can tell the user to reconnect). */
export function markConnection(kind: store.ConnectionKind, error: string | null) {
  const c = store.getConnectionRecord(kind);
  if (!c) return;
  store.setConnectionRecord(kind, { ...c, ...(error ? { lastError: error } : { lastOkAt: new Date().toISOString(), lastError: null }) });
}
