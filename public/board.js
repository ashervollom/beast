// The "Up next" board, shared by the account page (/app/board) and the private board link (/dashboard/<slug>).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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
  const exams = open.filter((a) => isExam(a) && (!a.dueAt || Date.parse(a.dueAt) > now - 864e5)).sort((a, b) => (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9"));
  const upNext = open.filter((a) => !isExam(a)).sort((a, b) => (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9"));
  const weekAgo = now - 7 * 864e5;
  const done = assignments.filter((a) => a.status === "done" && a.completedAt && Date.parse(a.completedAt) > weekAgo);
  const item = (a, showDue = true) => {
    const soon = a.dueAt && Date.parse(a.dueAt) - now < 2 * 864e5;
    const link = a.canvasHtmlUrl || a.url;
    return `<div class="item"><div class="when ${a.status !== "done" && soon ? "soon" : ""}">${showDue ? (a.dueAt ? esc(fmtDue(a.dueAt)) : "No date") : "Done"}</div>
      <div class="what">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(a.title)}</a>` : esc(a.title)}${a.tentative ? `<span class="tag">tentative</span>` : ""}${a.status === "in_progress" ? `<span class="tag">in progress</span>` : ""}
      ${a.course ? `<div class="course">${esc(a.course)}</div>` : ""}</div></div>`;
  };
  return `
    <section>
      <h2>Up next</h2>
      <p class="desc">${upNext.length ? `${upNext.length} open` : "Nothing open. Enjoy it."}</p>
      <div class="rule">${upNext.slice(0, 40).map((a) => item(a)).join("") || `<div class="empty">You're clear.</div>`}</div>
    </section>
    <section>
      <h2>Exams &amp; quizzes</h2>
      <p class="desc">From Canvas, your syllabi and the schedule of classes. Tentative ones aren't on Canvas yet.</p>
      <div class="rule">${exams.map((a) => item(a)).join("") || `<div class="empty">None coming up.</div>`}</div>
    </section>
    <section>
      <h2>Done this week</h2>
      <p class="desc">${done.length ? `${done.length} finished` : "Nothing yet this week."}</p>
      <div class="rule">${done.map((a) => item(a, false)).join("")}</div>
    </section>`;
}
