// The "Up next" board, shared by the account page (/app/board) and the private board link (/dashboard/<slug>).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const DAY = 864e5;
const EXAM_WINDOW_DAYS = 21;

/** Whole calendar days from today to the due date (negative = in the past), in the viewer's time zone. */
function daysAway(iso, now) {
  const midnight = (t) => new Date(new Date(t).toDateString()).getTime();
  return Math.round((midnight(Date.parse(iso)) - midnight(now)) / DAY);
}

function fmtDue(iso) {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
  const h = d.getHours();
  const time = `${((h + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
  return `${day} · ${time}`;
}

/** Up next, Exams & quizzes and Done this week, as HTML sections. */
export function boardHtml(assignments, now = Date.now()) {
  const isExam = (a) => a.type === "exam" || a.type === "quiz";
  const open = assignments.filter((a) => a.status !== "done");
  const exams = open.filter((a) => isExam(a) && (!a.dueAt || Date.parse(a.dueAt) > now - DAY)).sort((a, b) => (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9"));
  // Exams: the next three weeks up front, everything else (and undated ones) behind "Show all".
  const examsSoon = exams.filter((a) => a.dueAt && daysAway(a.dueAt, now) <= EXAM_WINDOW_DAYS);
  const examsLater = exams.filter((a) => !examsSoon.includes(a));
  const upNext = open.filter((a) => !isExam(a)).sort((a, b) => (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9"));
  const isLate = (a) => a.dueAt && Date.parse(a.dueAt) < now;
  const overdue = upNext.filter(isLate).length;
  const weekAgo = now - 7 * DAY;
  const done = assignments.filter((a) => a.status === "done" && a.completedAt && Date.parse(a.completedAt) > weekAgo);
  const item = (a, showDue = true) => {
    const link = a.canvasHtmlUrl || a.url;
    // Red only for late; bold for due within two days.
    const late = a.status !== "done" && isLate(a);
    const soon = a.status !== "done" && !late && a.dueAt && Date.parse(a.dueAt) - now < 2 * DAY;
    let when = "Done";
    if (showDue) {
      if (!a.dueAt) when = "No date";
      else if (late) {
        const d = -daysAway(a.dueAt, now);
        when = d <= 0 ? "Late, due today" : `${d} day${d === 1 ? "" : "s"} late`;
      } else when = fmtDue(a.dueAt);
    }
    return `<div class="item"><div class="when${late ? " late" : soon ? " soon" : ""}">${esc(when)}</div>
      <div class="what">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(a.title)}</a>` : esc(a.title)}${a.tentative ? `<span class="tag">tentative</span>` : ""}${a.status === "in_progress" ? `<span class="tag">in progress</span>` : ""}
      ${a.course ? `<div class="course">${esc(a.course)}</div>` : ""}</div></div>`;
  };
  return `
    <section>
      <h2>Up next</h2>
      <p class="desc">${upNext.length ? `${upNext.length} open${overdue ? ` · <span class="late">${overdue} overdue</span>` : ""}` : "Nothing open. Enjoy it."}</p>
      <div class="rule">${upNext.slice(0, 40).map((a) => item(a)).join("") || `<div class="empty">You're clear.</div>`}</div>
    </section>
    <section>
      <h2>Exams &amp; quizzes</h2>
      <p class="desc">The next three weeks. From Canvas, your syllabi and the schedule of classes; tentative ones aren't on Canvas yet.</p>
      <div class="rule">${examsSoon.map((a) => item(a)).join("") || `<div class="empty">Nothing in the next three weeks.</div>`}
        ${examsLater.length ? `<details class="more"><summary>Show all (${examsLater.length} more)</summary>${examsLater.map((a) => item(a)).join("")}</details>` : ""}</div>
    </section>
    <section>
      <h2>Done this week</h2>
      <p class="desc">${done.length ? `${done.length} finished` : "Nothing yet this week."}</p>
      <div class="rule">${done.map((a) => item(a, false)).join("")}</div>
    </section>`;
}
