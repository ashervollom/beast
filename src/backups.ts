// Daily backups of data/ to Cloudflare R2 (S3-compatible), 14 kept. Each backup is one gzipped JSON
// bundle with global.json and every user's file stored separately, so "delete my data" can strip a user
// out of every backup. Without R2 settings (local dev) backups are skipped.
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "./config.js";

const PREFIX = "beast/";
const KEEP = 14;

export interface Bundle {
  createdAt: string;
  global: Record<string, any>;
  users: Record<string, unknown>;
}

const r2 = config.backups;
export const backupsConfigured = () => Boolean(r2.endpoint && r2.accessKeyId && r2.secretAccessKey && r2.bucket);

let client: S3Client | null = null;
function s3(): S3Client {
  return (client ??= new S3Client({
    region: "auto",
    endpoint: r2.endpoint,
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
  }));
}

/** Reads data/ from disk into one bundle. Files are written atomically, so each one is consistent. */
export function snapshotBundle(): Bundle {
  const dir = config.dataDir;
  const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
  const usersDir = path.join(dir, "users");
  const users: Record<string, unknown> = {};
  if (fs.existsSync(usersDir)) {
    for (const f of fs.readdirSync(usersDir).filter((f) => f.endsWith(".json"))) users[f.replace(/\.json$/, "")] = readJson(path.join(usersDir, f));
  }
  const globalFile = path.join(dir, "global.json");
  return { createdAt: new Date().toISOString(), global: fs.existsSync(globalFile) ? readJson(globalFile) : {}, users };
}

export const packBundle = (b: Bundle) => gzipSync(JSON.stringify(b));
export const unpackBundle = (buf: Buffer): Bundle => JSON.parse(gunzipSync(buf).toString("utf8"));

async function listKeys(): Promise<string[]> {
  const res = await s3().send(new ListObjectsV2Command({ Bucket: r2.bucket, Prefix: PREFIX }));
  return (res.Contents ?? []).map((o) => o.Key!).filter(Boolean).sort();
}

async function getBundle(key: string): Promise<Bundle> {
  const res = await s3().send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
  return unpackBundle(Buffer.from(await res.Body!.transformToByteArray()));
}

async function putBundle(key: string, bundle: Bundle) {
  await s3().send(new PutObjectCommand({ Bucket: r2.bucket, Key: key, Body: packBundle(bundle), ContentType: "application/gzip" }));
}

/** Uploads today's backup and keeps the newest 14. Returns the key, or null when R2 isn't set up. */
export async function runBackup(): Promise<string | null> {
  if (!backupsConfigured()) return null;
  const bundle = snapshotBundle();
  const key = `${PREFIX}${bundle.createdAt.slice(0, 10)}.json.gz`;
  await putBundle(key, bundle);
  const keys = await listKeys();
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) {
    await s3().send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: old }));
  }
  console.log(`[backups] uploaded ${key} (${Object.keys(bundle.users).length} users)`);
  return key;
}

/** Removes a user from a bundle's user files and from everything global that points at them. */
export function stripUser(bundle: Bundle, userId: string): boolean {
  let changed = delete bundle.users[userId];
  const g = bundle.global;
  if (g.users?.[userId]) {
    delete g.users[userId];
    changed = true;
  }
  for (const map of [g.handles, g.groupOwners]) {
    for (const [k, v] of Object.entries(map ?? {})) if (v === userId) delete (map as Record<string, unknown>)[k];
  }
  for (const [t, tok] of Object.entries(g.connectTokens ?? {})) if ((tok as { userId: string }).userId === userId) delete g.connectTokens[t];
  if (Array.isArray(g.feedback)) g.feedback = g.feedback.filter((f: { userId: string }) => f.userId !== userId);
  return changed;
}

/** "delete my data": rewrites every stored backup without this user. */
export async function purgeUserFromBackups(userId: string) {
  if (!backupsConfigured()) return;
  for (const key of await listKeys()) {
    const bundle = await getBundle(key);
    if (stripUser(bundle, userId)) await putBundle(key, bundle);
  }
  console.log("[backups] removed a deleted user from all backups");
}

/** Restore helper: writes a bundle into a data directory (used by scripts/restore-backup.ts). */
export function writeBundle(bundle: Bundle, dir: string) {
  fs.mkdirSync(path.join(dir, "users"), { recursive: true });
  fs.writeFileSync(path.join(dir, "global.json"), JSON.stringify(bundle.global, null, 2));
  for (const [id, data] of Object.entries(bundle.users)) fs.writeFileSync(path.join(dir, "users", `${id}.json`), JSON.stringify(data, null, 2));
}

export async function fetchBackup(which: string): Promise<Bundle> {
  const keys = await listKeys();
  const key = which === "latest" ? keys.at(-1) : keys.find((k) => k.includes(which));
  if (!key) throw new Error(`no backup matching "${which}" (have: ${keys.join(", ") || "none"})`);
  return getBundle(key);
}
