// One-time move from the single-user data/db.json to per-user files. The old file is kept as
// data/db.legacy.json (never deleted). Runs at startup only when data/global.json doesn't exist yet.
import fs from "node:fs";
import path from "node:path";
import { config, MODELS } from "./config.js";
import { saveConnection } from "./connections.js";
import * as global from "./globalStore.js";
import { normalizeCanvasBaseUrl } from "./canvasApi.js";
import * as store from "./store.js";
import { withUser } from "./userContext.js";

interface LegacyDB {
  courses?: store.Course[];
  assignments?: store.Assignment[];
  conversations?: Record<string, store.ChatTurn[]>;
  settings?: { studentChatId?: string | null; lastStudentMessageAt?: string | null };
  proactive?: store.ProactiveState;
  chatModes?: Record<string, { roast: boolean }>;
  guests?: Record<string, { handle: string; name: string | null }>;
  processedEvents?: string[];
  canvas?: store.CanvasState;
}

export function migrateIfNeeded() {
  if (fs.existsSync(global.globalFile())) return;
  const legacyFile = path.join(config.dataDir, "db.json");
  const handle = config.linq.ownerHandle;
  if (!handle) {
    console.warn("[migrate] STUDENT_HANDLE isn't set, so there's no owner yet. Set it and restart.");
    return;
  }

  const legacy: LegacyDB = fs.existsSync(legacyFile) ? JSON.parse(fs.readFileSync(legacyFile, "utf8")) : {};
  const owner = global.createUser({
    handle,
    name: config.linq.ownerName,
    role: "owner",
    status: "active",
    onboardingStep: null,
    school: "UC Irvine",
    model: MODELS.replyStrong,
    invitesLeft: 0,
  });

  // Only the owner's own chat and group chats come along. Other people's 1:1 chats with the old
  // single-user Beast stay in the legacy file.
  const ownChat = legacy.settings?.studentChatId ?? null;
  const conversations: Record<string, store.ChatTurn[]> = {};
  for (const [key, turns] of Object.entries(legacy.conversations ?? {})) {
    const chatId = key.replace(/^imessage:/, "");
    const isGroup = turns.some((t) => t.from);
    if (chatId === ownChat || isGroup) conversations[key] = turns;
    if (isGroup) global.setGroupOwner(chatId, owner.id);
  }

  const data = store.emptyUserDB();
  Object.assign(data, {
    courses: legacy.courses ?? [],
    assignments: legacy.assignments ?? [],
    conversations,
    settings: { chatId: ownChat, lastMessageAt: legacy.settings?.lastStudentMessageAt ?? null },
    proactive: { ...data.proactive, ...legacy.proactive, sent: (legacy.proactive?.sent ?? []).filter((s) => (s.kind as string) !== "guest") },
    chatModes: legacy.chatModes ?? {},
    canvas: { ...data.canvas, ...legacy.canvas },
    memory: legacyMemory(),
  });
  store.writeUserFile(owner.id, data);

  // The owner's Canvas moves from .env into encrypted connections.
  withUser(owner.id, () => {
    const { icsUrl, baseUrl, token } = config.legacyCanvas;
    const host = baseUrl ? normalizeCanvasBaseUrl(baseUrl) : null;
    if (token && host) saveConnection("canvas", token, { baseUrl: host });
    if (icsUrl) saveConnection("canvas_ics", icsUrl);
  });

  // Names of people Beast already met.
  for (const g of Object.values(legacy.guests ?? {})) {
    if (g.handle !== handle) global.upsertPerson(g.handle, { name: g.name });
  }
  for (const id of legacy.processedEvents ?? []) global.markEventProcessed(id);

  if (fs.existsSync(legacyFile)) fs.renameSync(legacyFile, path.join(config.dataDir, "db.legacy.json"));
  console.log(`[migrate] moved the single-user database to per-user files (owner: ${owner.name}).`);
}

/** The owner's old prompts/you.md bullets become their first memories. */
function legacyMemory(): store.MemoryItem[] {
  try {
    const text = fs.readFileSync(path.resolve("prompts", "you.md"), "utf8");
    return text
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*-\s*(.+?):\s*(.+)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m && m[2].trim() && !/\[fill in/i.test(m[2])))
      .map((m, i) => ({ id: `you${i}`, text: `${m[1]}: ${m[2].trim()}`.slice(0, 300), at: new Date().toISOString() }));
  } catch {
    return [];
  }
}
