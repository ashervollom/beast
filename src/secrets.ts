// AES-256-GCM for stored connection secrets (Canvas tokens, feed URLs). The key comes from MASTER_KEY.
// Secrets are only decrypted right before use and never logged, put in prompts or sent back to users.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

function key(): Buffer {
  const k = Buffer.from(config.masterKey, "base64");
  if (k.length !== 32) throw new Error("MASTER_KEY must be 32 random bytes, base64-encoded");
  return k;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("unrecognized secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

/** URL-safe random token for links (invites, connect pages, dashboard and calendar slugs). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
