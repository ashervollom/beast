// Background work, run for each user inside withUser so no job can touch another user's data.
// /healthz reads lastOk to tell when a job has stopped succeeding.
import { runBackup } from "./backups.js";
import { syncCanvas } from "./canvas.js";
import { syncPlanner } from "./canvasPlanner.js";
import { scanCourses, scanSummary } from "./courseScan.js";
import { sendToChat } from "./notify.js";
import * as store from "./store.js";
import { isConnected } from "./connections.js";
import * as global from "./globalStore.js";
import { tick } from "./proactive.js";
import { withUser } from "./userContext.js";

const MIN = 60_000;

export const JOBS = {
  proactive: { everyMs: MIN },
  canvasFeed: { everyMs: 60 * MIN },
  canvasPlanner: { everyMs: 20 * MIN },
  backup: { everyMs: 24 * 60 * MIN },
  // Checks hourly; each course is only rescanned when due (daily in weeks 0-2, weekly after).
  courseScan: { everyMs: 60 * MIN },
  housekeeping: { everyMs: 60 * MIN },
} as const;
export type JobName = keyof typeof JOBS;

/** When each job last finished a full pass over all users without throwing. */
export const lastOk: Partial<Record<JobName, string>> = {};

const activeUsers = () => global.listUsers().filter((u) => u.status === "active");

/** Runs fn for every active user, one at a time. One user's failure doesn't stop the rest. */
export async function forEachUser(job: string, fn: (u: global.User) => Promise<unknown>) {
  for (const u of activeUsers()) {
    try {
      await withUser(u.id, () => fn(u));
    } catch (err) {
      console.error(`[jobs] ${job} failed for a user:`, err instanceof Error ? err.message : err);
    }
  }
}

const RUN: Record<JobName, () => Promise<void>> = {
  proactive: () => forEachUser("proactive", () => tick()),
  canvasFeed: () => forEachUser("canvasFeed", () => (isConnected("canvas_ics") ? syncCanvas().catch(() => {}) : Promise.resolve())),
  canvasPlanner: () => forEachUser("canvasPlanner", () => (isConnected("canvas") ? syncPlanner() : Promise.resolve())),
  // One bundle per day; re-running the same day overwrites it, so restarts don't pile up backups.
  backup: async () => void (await runBackup()),
  courseScan: () => forEachUser("courseScan", () => (isConnected("canvas") ? scanCourses() : Promise.resolve())),
  // Expired, unused invites go back to whoever made them.
  housekeeping: async () => {
    const n = global.refundExpiredInvites();
    if (n) console.log(`[jobs] refunded ${n} expired invite${n > 1 ? "s" : ""}`);
  },
};

const running = new Set<JobName>();

export async function runJob(name: JobName) {
  if (running.has(name)) return; // a slow pass doesn't stack up
  running.add(name);
  try {
    await RUN[name]();
    lastOk[name] = new Date().toISOString();
  } catch (err) {
    // Never let a failed job crash the server; /healthz notices it went stale.
    console.error(`[jobs] ${name} failed:`, err instanceof Error ? err.message : err);
  } finally {
    running.delete(name);
  }
}

/**
 * Right after someone connects Canvas: feed first (so assignments exist), then the planner, then the deep
 * course scan, then one summary text. That text answers something they just did, so it isn't a notification.
 */
export function syncUserNow(userId: string) {
  return withUser(userId, async () => {
    if (isConnected("canvas_ics")) await syncCanvas().catch(() => {});
    if (isConnected("canvas")) await syncPlanner();
    const results = isConnected("canvas") ? await scanCourses({ force: true }) : [];
    const chatId = store.getSettings().chatId;
    if (chatId) await sendToChat(chatId, scanSummary(results)).catch((err) => console.error("[connect] summary text failed:", err instanceof Error ? err.message : err));
  });
}

export function startJobs() {
  // On start: Canvas feed, then planner, then the course scan (only courses that are due), then the scheduler loop.
  void runJob("canvasFeed")
    .then(() => runJob("canvasPlanner"))
    .then(() => runJob("courseScan"));
  for (const name of Object.keys(JOBS) as JobName[]) {
    setInterval(() => void runJob(name), JOBS[name].everyMs);
  }
  void runJob("proactive");
  void runJob("housekeeping");
  setTimeout(() => void runJob("backup"), 5 * MIN);
}
