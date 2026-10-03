// Enriches Canvas-imported assignments from the Canvas planner API (read-only):
// points, missing flag, assignment link, auto-complete when Canvas shows a submission, and due dates
// that Canvas moved (unless the user set that date themselves).
// Runs for the current user (inside withUser).
import { CanvasApiError, canvasGetAll, CanvasRateLimitError } from "./canvasApi.js";
import { canvasCreds, markConnection } from "./connections.js";
import { notifyCanvas } from "./proactive.js";
import { formatLocal } from "./snapshot.js";
import * as store from "./store.js";
import { currentUserId } from "./userContext.js";

const DAY = 864e5;

interface PlannerItem {
  plannable_type: string;
  plannable_id: number;
  html_url?: string;
  plannable?: { assignment_id?: number; points_possible?: number | null; title?: string; due_at?: string | null };
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

const running = new Map<string, Promise<PlannerSyncResult>>();

/** One sync at a time per user. */
export function syncPlanner(): Promise<PlannerSyncResult> {
  const id = currentUserId();
  let p = running.get(id);
  if (!p) {
    p = doSync().finally(() => running.delete(id));
    running.set(id, p);
  }
  return p;
}

async function doSync(): Promise<PlannerSyncResult> {
  const creds = canvasCreds();
  if (!creds) return { skipped: "Canvas not connected", items: 0, matched: 0, updated: 0, markedDone: [] };
  try {
    const start = new Date(Date.now() - 14 * DAY).toISOString();
    const end = new Date(Date.now() + 28 * DAY).toISOString();
    const items = await canvasGetAll<PlannerItem>(
      `/api/v1/planner/items?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&per_page=100`,
      creds,
    );

    const byAssignmentId = new Map<number, PlannerItem>();
    for (const item of items) {
      const id = assignmentIdOf(item);
      if (id !== null) byAssignmentId.set(id, item);
    }

    let matched = 0;
    let updated = 0;
    const markedDone: store.Assignment[] = [];
    const moved: string[] = [];
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
          canvasHtmlUrl: item.html_url ? new URL(item.html_url, creds.baseUrl).toString() : a.canvasHtmlUrl,
        },
        { markDone: willMarkDone },
      );
      // The professor moved the due date on Canvas: follow it, unless the user set this date by hand.
      const canvasDue = item.plannable?.due_at ?? null;
      if (canvasDue && a.dueAt && Math.abs(Date.parse(canvasDue) - Date.parse(a.dueAt)) > 60_000 && !a.dueAtEditedByUser) {
        store.updateAssignment(a.id, { dueAt: canvasDue }, { byUser: false });
        moved.push(`${a.title}${a.course ? ` (${a.course})` : ""} moved to ${formatLocal(canvasDue)}`);
      }
      if (changed) updated++;
      if (willMarkDone) markedDone.push(a);
    }

    store.finishPlannerSync(null);
    markConnection("canvas", null);
    console.log(`[canvas-api] planner: ${items.length} items, ${matched} matched, ${updated} updated, ${markedDone.length} marked done`);
    if (markedDone.length) await notifyCanvas(submittedMessage(markedDone.map((a) => a.title)));
    // Date changes ride along with the next brief or reply, never as their own text.
    if (moved.length) {
      store.holdNotice(`canvas moved due dates: ${moved.join("; ")}`);
      console.log(`[canvas-api] ${moved.length} due date${moved.length > 1 ? "s" : ""} moved on Canvas`);
    }
    return { items: items.length, matched, updated, markedDone: markedDone.map((a) => a.title) };
  } catch (err) {
    // Quiet by design: log one line, record it for the agent, never text or crash.
    const message = err instanceof Error ? err.message : String(err);
    const kind = err instanceof CanvasRateLimitError ? "rate limited, will retry next run" : "sync failed";
    console.warn(`[canvas-api] planner ${kind}: ${message}`);
    store.finishPlannerSync(message);
    // 401 means the token expired or was revoked: the agent sees this and offers a reconnect.
    if (err instanceof CanvasApiError && err.status === 401) markConnection("canvas", "token expired or revoked");
    return { skipped: message, items: 0, matched: 0, updated: 0, markedDone: [] };
  }
}

export function submittedMessage(titles: string[]): string {
  if (titles.length === 1) return `saw u turned in ${titles[0]} on canvas, marked it done`;
  const list = `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
  return `saw u turned in ${list} on canvas, marked them done`;
}
