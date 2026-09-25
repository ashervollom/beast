// Compact, per-message view of the student's workload, sent to the agent as a system message.
import { config } from "./config.js";
import * as store from "./store.js";

const DAY = 864e5;
const MAX_PER_SECTION = 8;

function fmt(d: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, ...opts }).format(d);
}

/** YYYY-MM-DD in the student's timezone. */
export function localDay(d: Date): string {
  return fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2");
}

export function formatLocal(iso: string): string {
  return fmt(new Date(iso), { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function nowLine(): string {
  const d = new Date();
  const when = fmt(d, { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const offset = fmt(d, { timeZoneName: "longOffset" }).split(" ").pop()?.replace("GMT", "UTC") ?? "UTC";
  return `${when} (${config.timezone}, ${offset})`;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function syncLine(): string {
  const s = store.getCanvasState();
  const parts: string[] = [];
  if (config.canvasIcsUrl) parts.push(`calendar ${s.lastError ? `failing (${s.lastError})` : ago(s.lastSyncAt)}`);
  if (config.canvasBaseUrl && config.canvasToken) {
    parts.push(`submissions/points ${s.lastPlannerError ? `failing (${s.lastPlannerError})` : ago(s.lastPlannerSyncAt)}`);
  }
  return parts.length ? `Canvas last synced: ${parts.join("; ")}` : "Canvas: not connected";
}

function itemLine(a: store.Assignment, showTimeOnly = false): string {
  const bits = [a.title];
  if (a.course) bits[0] += ` (${a.course})`;
  if (a.dueAt) bits.push(showTimeOnly ? fmt(new Date(a.dueAt), { hour: "numeric", minute: "2-digit" }) : formatLocal(a.dueAt));
  if (a.pointsPossible != null) bits.push(`${a.pointsPossible} pts`);
  if (a.status === "in_progress") bits.push("in progress");
  if (a.status === "done") bits.push("marked done here");
  return `- ${bits.join(" · ")}`;
}

function section(title: string, items: store.Assignment[], showTimeOnly = false): string[] {
  if (!items.length) return [];
  const lines = items.slice(0, MAX_PER_SECTION).map((a) => itemLine(a, showTimeOnly));
  if (items.length > MAX_PER_SECTION) lines.push(`- +${items.length - MAX_PER_SECTION} more (use list_assignments)`);
  return [`${title}:`, ...lines];
}

export function buildSnapshot(): string {
  const now = new Date();
  const today = localDay(now);
  const tomorrow = localDay(new Date(now.getTime() + DAY));
  const weekEnd = now.getTime() + 7 * DAY;

  const all = store.listAssignments({ status: "all" });
  const open = all.filter((a) => a.status !== "done");
  const due = (a: store.Assignment) => (a.dueAt ? new Date(a.dueAt) : null);

  const missing = all.filter((a) => a.canvasMissing);
  const rest = open.filter((a) => !a.canvasMissing && a.dueAt);
  const overdue = rest.filter((a) => due(a)! < now);
  const dueToday = rest.filter((a) => due(a)! >= now && localDay(due(a)!) === today);
  const dueTomorrow = rest.filter((a) => localDay(due(a)!) === tomorrow);
  const nextWeek = rest.filter((a) => {
    const d = due(a)!;
    return d >= now && d.getTime() <= weekEnd && ![today, tomorrow].includes(localDay(d));
  });

  const lines = [
    `Snapshot of the student's school work (auto-generated for this message; don't mention it verbatim).`,
    `Now: ${nowLine()}`,
    syncLine(),
    ...section("Missing on Canvas", missing),
    ...section("Overdue", overdue),
    ...section("Due today", dueToday, true),
    ...section("Due tomorrow", dueTomorrow, true),
    ...section("Rest of the next 7 days", nextWeek),
  ];
  if (!missing.length && !overdue.length && !dueToday.length && !dueTomorrow.length && !nextWeek.length) {
    lines.push("Nothing missing, overdue or due in the next 7 days.");
  }
  return lines.join("\n");
}
