// Proactive texts to the student: the 6:30 morning brief, deadline warnings, the nightly check-in,
// and Canvas notices. The scheduler decides WHEN a text may go out (quiet hours, daily cap,
// "don't pile on", no stale sends after downtime); the reply model writes WHAT it says.
import { config } from "./config.js";
import { writeProactive } from "./agent.js";
import { formatLocal } from "./snapshot.js";
import { sendToChat } from "./notify.js";
import * as store from "./store.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const BRIEF_WINDOW_MIN = 120; // brief only goes out within 2h of its time; later = stale, skip today
const NIGHTLY_WINDOW_MIN = 90;
const DOWNTIME_MS = 2 * HOUR;

/** Swappable for tests. */
export const deps = { write: writeProactive, send: sendToChat };

// ---- time helpers (all in the student's timezone) ----

function local(d: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
};

function inQuietHours(now: Date): boolean {
  const { minutes } = local(now);
  const start = hm(config.proactive.quietStart);
  const end = hm(config.proactive.quietEnd);
  return start > end ? minutes >= start || minutes < end : minutes >= start && minutes < end;
}

const today = (now: Date) => local(now).date;
const sentToday = (now: Date) => store.getProactive().sent.filter((s) => local(new Date(s.at)).date === today(now));

// ---- rules ----

/** Brief and "X started texting me" notices don't count toward the cap or the unanswered rule. */
const counted = (s: { kind: store.ProactiveKind }) => s.kind !== "brief" && s.kind !== "guest";

/** Texts counted toward the daily cap. */
function capReached(now: Date): boolean {
  return sentToday(now).filter(counted).length >= config.proactive.dailyCap;
}

/** "Don't pile on": today's last counted proactive text hasn't been answered yet. */
function unanswered(now: Date): boolean {
  const last = sentToday(now).filter(counted).at(-1);
  if (!last) return false;
  const reply = store.getSettings().lastStudentMessageAt;
  return !reply || Date.parse(reply) < Date.parse(last.at);
}

function nudgedToday(now: Date, id: string): boolean {
  return sentToday(now).some((s) => s.kind !== "brief" && s.assignmentIds?.includes(id));
}

function finalNudged(id: string, now: Date): boolean {
  return store
    .getProactive()
    .sent.some(
      (s) =>
        s.assignmentIds?.includes(id) &&
        (s.kind === "final_nudge" || (s.kind === "catch_up" && now.getTime() - Date.parse(s.at) < config.proactive.finalNudgeHours * HOUR)),
    );
}

const openWithDue = () => store.listAssignments({ status: "open" }).filter((a) => a.dueAt);
const dueWithin = (a: store.Assignment, now: Date, hours: number) =>
  Date.parse(a.dueAt!) > now.getTime() && Date.parse(a.dueAt!) - now.getTime() <= hours * HOUR;
const describe = (a: store.Assignment) =>
  `${a.title}${a.course ? ` (${a.course})` : ""}, due ${formatLocal(a.dueAt!)}${a.pointsPossible != null ? `, ${a.pointsPossible} pts` : ""}, status ${a.status}`;

// ---- sending ----

async function send(kind: store.ProactiveKind, text: string, now: Date, assignmentIds?: string[]) {
  const chatId = store.getSettings().studentChatId!;
  await deps.send(chatId, text);
  store.recordProactive(kind, now, assignmentIds);
  console.log(`[proactive] sent ${kind}: ${text.split("\n")[0]}`);
}

async function write(instruction: string, fallback: string, allowSkip: boolean): Promise<string | null> {
  try {
    return await deps.write(`imessage:${store.getSettings().studentChatId}`, instruction, { allowSkip });
  } catch (err) {
    console.error("[proactive] writer failed, using fallback:", err instanceof Error ? err.message : err);
    return fallback || null;
  }
}

// ---- the texts ----

async function morningBrief(now: Date) {
  const held = [...store.getProactive().held];
  const instruction = [
    "Proactive text: the 6:30 morning brief. It goes out every morning like clockwork, so keep it brief.",
    "What's due today and tomorrow, anything missing, and one suggestion. If nothing is due, keep it short and chill.",
    held.length ? `Also fold in these updates that came in overnight (Canvas, new people texting you):\n${held.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const due = openWithDue().filter((a) => dueWithin(a, now, 48));
  const fallback = due.length ? `morning. up next:\n${due.map((a) => `📝 ${a.title}, ${formatLocal(a.dueAt!)}`).join("\n")}` : "morning. nothing due today, easy one";
  const text = await write(instruction, fallback, false);
  await send("brief", text ?? fallback, now);
  store.takeHeldNotices(); // only cleared once the brief actually went out
}

/** Deadline warnings always go out (outside quiet hours), even over the cap or when unanswered. */
async function deadlineWarnings(now: Date) {
  const open = openWithDue();
  const finals = open.filter((a) => a.status === "todo" && dueWithin(a, now, config.proactive.finalNudgeHours) && !finalNudged(a.id, now));
  if (finals.length) {
    const fallback = finals.map((a) => `${a.title} is due ${formatLocal(a.dueAt!)} and its still open 👀`).join("\n");
    const text = await write(
      `Proactive text: final deadline warning. Due within a few hours and not started:\n${finals.map(describe).join("\n")}`,
      fallback,
      false,
    );
    await send("final_nudge", text ?? fallback, now, finals.map((a) => a.id)); // warnings always go out
    return;
  }
  const nudges = open.filter((a) => dueWithin(a, now, config.proactive.nudgeHours) && !nudgedToday(now, a.id));
  if (nudges.length) {
    const fallback = nudges.map((a) => `heads up, ${a.title} is due ${formatLocal(a.dueAt!)}`).join("\n");
    const text = await write(`Proactive text: deadline nudge. Due soon and not done:\n${nudges.map(describe).join("\n")}`, fallback, false);
    await send("nudge", text ?? fallback, now, nudges.map((a) => a.id)); // warnings always go out
  }
}

let nightlyTriedOn: string | null = null;

async function nightlyCheckIn(now: Date) {
  nightlyTriedOn = today(now);
  const dueSoon = openWithDue().filter((a) => dueWithin(a, now, 24));
  const doneToday = store.listAssignments({ status: "done" }).filter((a) => a.completedAt && local(new Date(a.completedAt)).date === today(now));
  if (!dueSoon.length && !doneToday.length) return; // nothing to say, send nothing
  const text = await write(
    [
      "Proactive text: nightly check-in.",
      dueSoon.length ? `Due soon and not done:\n${dueSoon.map(describe).join("\n")}` : "",
      doneToday.length ? `Finished today:\n${doneToday.map((a) => a.title).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    "",
    true,
  );
  if (text) await send("nightly", text, now);
}

/** After downtime: at most one catch-up text, and only if something is urgent. Never replays missed texts. */
async function catchUp(now: Date) {
  if (inQuietHours(now) || capReached(now)) return;
  const urgent = openWithDue().filter((a) => dueWithin(a, now, config.proactive.nudgeHours));
  const missing = store.listAssignments({ status: "all" }).filter((a) => a.canvasMissing);
  if (!urgent.length && !missing.length) return;
  const text = await write(
    [
      "Proactive text: one catch-up text after you were offline for a while. Only what's urgent right now, nothing stale.",
      urgent.length ? `Due soon:\n${urgent.map(describe).join("\n")}` : "",
      missing.length ? `Missing on Canvas:\n${missing.map((a) => a.title).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    "",
    true,
  );
  if (text) await send("catch_up", text, now, urgent.map((a) => a.id));
}

// ---- Canvas notices (new items, "saw u turned in X") ----

/** Sends a Canvas notice now if the rules allow, otherwise holds it for the next morning brief. */
export async function notifyCanvas(text: string, now = new Date()) {
  if (!store.getSettings().studentChatId || !config.linq.apiKey) {
    console.log(`[proactive] no student chat yet (Asher needs to text once); canvas notice was:\n${text}`);
    return;
  }
  if (inQuietHours(now) || capReached(now) || unanswered(now)) {
    store.holdNotice(text);
    console.log("[proactive] canvas notice held for the morning brief");
    return;
  }
  try {
    await send("canvas", text, now);
  } catch (err) {
    console.error("[proactive] canvas notice failed:", err instanceof Error ? err.message : err);
  }
}

/** "<name> (<phone>) just started texting me." Sent right away, except in quiet hours (then folded into the brief). */
export async function notifyGuestJoined(text: string, now = new Date()) {
  if (!store.getSettings().studentChatId || !config.linq.apiKey) {
    console.log(`[proactive] no student chat yet; guest notice was: ${text}`);
    return;
  }
  if (inQuietHours(now)) {
    store.holdNotice(text);
    return;
  }
  try {
    await send("guest", text, now);
  } catch (err) {
    console.error("[proactive] guest notice failed:", err instanceof Error ? err.message : err);
  }
}

// ---- scheduler ----

let running = false;

export async function tick(now = new Date()) {
  if (running) return;
  running = true;
  try {
    const { lastTickAt } = store.getProactive();
    store.setLastTick(now);
    if (!store.getSettings().studentChatId || !config.linq.apiKey) return;

    if (lastTickAt && now.getTime() - Date.parse(lastTickAt) > DOWNTIME_MS) await catchUp(now);

    const { minutes } = local(now);
    const brief = hm(config.proactive.briefTime);
    if (minutes >= brief && minutes < brief + BRIEF_WINDOW_MIN && !sentToday(now).some((s) => s.kind === "brief")) {
      await morningBrief(now);
    }

    if (inQuietHours(now)) return;
    await deadlineWarnings(now);

    const night = hm(config.proactive.nightTime);
    if (
      minutes >= night &&
      minutes < night + NIGHTLY_WINDOW_MIN &&
      nightlyTriedOn !== today(now) &&
      !sentToday(now).some((s) => s.kind === "nightly") &&
      !capReached(now) &&
      !unanswered(now)
    ) {
      await nightlyCheckIn(now);
    }
  } catch (err) {
    console.error("[proactive] tick failed:", err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

/** Test hook: forget in-memory state between simulated days. */
export function resetForTests() {
  nightlyTriedOn = null;
}

export function startProactiveScheduler() {
  void tick();
  setInterval(() => void tick(), MIN);
}
