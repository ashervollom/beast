// Enriches Canvas-imported assignments from the Canvas planner API (read-only):
// points, missing flag, assignment link, and auto-complete when Canvas shows a submission.
import { config } from "./config.js";
import { canvasApiConfigured, canvasGetAll, CanvasRateLimitError } from "./canvasApi.js";
import { notifyCanvas } from "./proactive.js";
import * as store from "./store.js";

const SYNC_INTERVAL_MS = 20 * 60_000;
const DAY = 864e5;

interface PlannerItem {
  plannable_type: string;
  plannable_id: number;
  html_url?: string;
  plannable?: { assignment_id?: number; points_possible?: number | null; title?: string };
  submissions?: false | { submitted?: boolean; missing?: boolean };
}

/** Assignments use plannable_id; quizzes and graded discussions point at their assignment. */
function assignmentIdOf(item: PlannerItem): number | null {
  if (item.plannable_type === "assignment") return item.plannable_id;
  return item.plannable?.assignment_id ?? null;
}

export interface PlannerSyncResult {
  skipped?: string;
  items: number;
  matched: number;
  updated: number;
  markedDone: string[];
}

let running: Promise<PlannerSyncResult> | null = null;

export function syncPlanner(): Promise<PlannerSyncResult> {
  running ??= doSync().finally(() => (running = null));
  return running;
}

async function doSync(): Promise<PlannerSyncResult> {
  if (!canvasApiConfigured()) return { skipped: "CANVAS_TOKEN / CANVAS_BASE_URL not set", items: 0, matched: 0, updated: 0, markedDone: [] };
  try {
    const start = new Date(Date.now() - 14 * DAY).toISOString();
    const end = new Date(Date.now() + 28 * DAY).toISOString();
    const items = await canvasGetAll<PlannerItem>(
      `/api/v1/planner/items?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&per_page=100`,
    );

    const byAssignmentId = new Map<number, PlannerItem>();
    for (const item of items) {
      const id = assignmentIdOf(item);
      if (id !== null) byAssignmentId.set(id, item);
    }

    let matched = 0;
    let updated = 0;
    const markedDone: store.Assignment[] = [];
    // Only existing assignments are touched; planner items without a match are ignored (no duplicates).
    for (const a of store.listAssignments({ status: "all" })) {
      const item = a.canvasAssignmentId !== null ? byAssignmentId.get(a.canvasAssignmentId) : undefined;
      if (!item) continue;
      matched++;

      const sub = item.submissions || {};
      const submitted = Boolean(sub.submitted);
      // Auto-complete only on the first time we see the submission, so reopening it by hand sticks.
      const newlySubmitted = submitted && !a.canvasSubmitted;
      const willMarkDone = newlySubmitted && a.status !== "done";
      const changed = store.applyCanvasInfo(
        a.id,
        {
          pointsPossible: item.plannable?.points_possible ?? null,
          canvasMissing: Boolean(sub.missing),
          canvasSubmitted: submitted,
          canvasHtmlUrl: item.html_url ? new URL(item.html_url, config.canvasBaseUrl).toString() : a.canvasHtmlUrl,
        },
        { markDone: willMarkDone },
      );
      if (changed) updated++;
      if (willMarkDone) markedDone.push(a);
    }

    store.finishPlannerSync(null);
    console.log(`[canvas-api] planner: ${items.length} items, ${matched} matched, ${updated} updated, ${markedDone.length} marked done`);
    if (markedDone.length) await notifyCanvas(submittedMessage(markedDone.map((a) => a.title)));
    return { items: items.length, matched, updated, markedDone: markedDone.map((a) => a.title) };
  } catch (err) {
    // Quiet by design: log one line, record it for the dashboard, never text or crash.
    const message = err instanceof Error ? err.message : String(err);
    const kind = err instanceof CanvasRateLimitError ? "rate limited, will retry next run" : "sync failed";
    console.warn(`[canvas-api] planner ${kind}: ${message}`);
    store.finishPlannerSync(message);
    return { skipped: message, items: 0, matched: 0, updated: 0, markedDone: [] };
  }
}

export function submittedMessage(titles: string[]): string {
  if (titles.length === 1) return `saw u turned in ${titles[0]} on canvas, marked it done`;
  const list = `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
  return `saw u turned in ${list} on canvas, marked them done`;
}

export function startPlannerSync() {
  if (!canvasApiConfigured()) return;
  setInterval(() => void syncPlanner(), SYNC_INTERVAL_MS);
}
