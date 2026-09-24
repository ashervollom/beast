const $ = (sel, root = document) => root.querySelector(sel);
const state = { assignments: [], courses: [], filter: "all", showAllDone: false, canvas: null };

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isHttp = (url) => /^https?:\/\//i.test(url || "");

const DAY = 864e5;
const DONE_LIMIT = 8;

// ---------- data ----------

async function refresh() {
  const [assignments, courses, canvas] = await Promise.all([
    api("/api/assignments?status=all"),
    api("/api/courses"),
    api("/api/canvas/status").catch(() => null),
  ]);
  Object.assign(state, { assignments, courses, canvas });
  render();
}

function startOfWeek(now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  return d;
}

const isOverdue = (a, now) => a.status !== "done" && a.dueAt && new Date(a.dueAt) < now;

// ---------- properties (the numbers) ----------

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 6e4);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function renderProps(now) {
  const open = state.assignments.filter((a) => a.status !== "done");
  const overdue = open.filter((a) => isOverdue(a, now)).length;
  const due = open.length - overdue;
  const weekStart = startOfWeek(now);
  const doneThisWeek = state.assignments.filter((a) => a.completedAt && new Date(a.completedAt) >= weekStart).length;

  const rows = [
    ["Due", `${due}`],
    ["Overdue", `${overdue}`, overdue ? "alert" : ""],
    ["Completed this week", `${doneThisWeek}`],
  ];
  const c = state.canvas;
  if (c?.enabled) {
    const error = c.lastError || c.api?.lastError;
    rows.push(["Canvas", error ? "Sync issue" : c.lastSyncAt ? `Synced ${ago(c.lastSyncAt)}` : "Syncing…", error ? "alert" : "muted"]);
  }
  rows.push(["Today", now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), "muted"]);
  $("#props").innerHTML = rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ""}">${escapeHtml(v)}</dd>`).join("");
}

// ---------- filters ----------

function renderFilters() {
  const chips = [["all", "All courses", null], ...state.courses.map((c) => [c.name, c.name, c.color])];
  $("#filters").innerHTML = chips
    .map(
      ([value, label, color]) =>
        `<button class="filter ${state.filter === value ? "active" : ""}" data-filter="${escapeHtml(value)}">${
          color ? `<span class="dot" style="background:${escapeHtml(color)}"></span>` : ""
        }${escapeHtml(label)}</button>`,
    )
    .join("");
}

$("#filters").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-filter]");
  if (!chip) return;
  state.filter = chip.dataset.filter;
  render();
});

// ---------- board ----------

function formatDue(iso, now) {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}

function relative(iso, now) {
  const diff = new Date(iso) - now;
  const abs = Math.abs(diff);
  const text = abs < 36e5 ? `${Math.max(1, Math.round(abs / 6e4))}m` : abs < DAY ? `${Math.round(abs / 36e5)}h` : `${Math.round(abs / DAY)}d`;
  return diff < 0 ? `${text} overdue` : `in ${text}`;
}

const byDue = (a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999");
const byCompleted = (a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "");

function renderBoard(now) {
  const visible = state.assignments.filter((a) => state.filter === "all" || a.course === state.filter);
  const colors = Object.fromEntries(state.courses.map((c) => [c.name, c.color]));

  for (const column of document.querySelectorAll(".column")) {
    const status = column.dataset.status;
    let items = visible.filter((a) => a.status === status).sort(status === "done" ? byCompleted : byDue);
    $(".count", column).textContent = items.length || "";
    const total = items.length;
    if (status === "done" && !state.showAllDone) items = items.slice(0, DONE_LIMIT);

    const list = $(".cards", column);
    list.innerHTML = items.length ? items.map((a) => renderCard(a, now, colors)).join("") : `<div class="empty">Nothing here</div>`;
    if (status === "done" && total > DONE_LIMIT) {
      list.insertAdjacentHTML(
        "beforeend",
        `<button class="show-all" data-toggle-done>${state.showAllDone ? "Show less" : `Show all ${total}`}</button>`,
      );
    }
  }
}

$("#board").addEventListener("click", (e) => {
  if (!e.target.closest("[data-toggle-done]")) return;
  state.showAllDone = !state.showAllDone;
  render();
});

function renderCard(a, now, colors) {
  const link = [a.canvasHtmlUrl, a.url].find(isHttp);
  const title = link
    ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.title)}</a>`
    : escapeHtml(a.title);

  const tags = [];
  if (a.course) tags.push(`<span class="tag course" style="--c:${escapeHtml(colors[a.course] || "#9b9a97")}">${escapeHtml(a.course)}</span>`);
  if (a.canvasMissing) tags.push(`<span class="tag missing">Missing</span>`);
  if (a.pointsPossible != null) tags.push(`<span class="tag">${a.pointsPossible} pts</span>`);
  if (a.type && a.type !== "homework") tags.push(`<span class="tag">${escapeHtml(a.type)}</span>`);

  let due = "";
  if (a.status === "done") {
    if (a.completedAt) due = `<div class="due">Completed ${new Date(a.completedAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>`;
  } else if (a.dueAt) {
    const late = isOverdue(a, now);
    const soon = !late && new Date(a.dueAt) - now < 2 * DAY;
    due = `<div class="due ${late ? "late" : soon ? "soon" : ""}">${formatDue(a.dueAt, now)} · ${relative(a.dueAt, now)}</div>`;
  }

  const { text, files } = linkify(a.notes || "");
  return `<article class="card ${a.status === "done" ? "done" : ""}">
    <div class="card-title">${title}</div>
    ${tags.length ? `<div class="tags">${tags.join("")}</div>` : ""}
    ${due}
    ${text ? `<div class="notes">${text}</div>` : ""}
    ${files.length ? `<div class="files">${files.join("")}</div>` : ""}
  </article>`;
}

// ---------- notes: Canvas "[file.pdf] (https://…)" → file links, bare URLs → links ----------

const PAPERCLIP = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 7.6 8.1 12.7a3.3 3.3 0 0 1-4.7-4.7l5.4-5.4a2.2 2.2 0 0 1 3.1 3.1l-5.3 5.3a1.1 1.1 0 0 1-1.6-1.6l4.9-4.9"/></svg>`;

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 24 ? `${u.pathname.slice(0, 24)}…` : u.pathname;
    return `${u.hostname.replace(/^www\./, "")}${path === "/" ? "" : path}`;
  } catch {
    return url;
  }
}

function linkify(raw) {
  const files = [];
  const pattern = /\[([^\]\n]+)\]\s*\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"')\]]+)/g;
  let out = "";
  let last = 0;
  for (const m of raw.matchAll(pattern)) {
    out += escapeHtml(raw.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      files.push(`<a class="file" href="${escapeHtml(m[2])}" target="_blank" rel="noopener noreferrer">${PAPERCLIP}${escapeHtml(m[1])}</a>`);
    } else {
      out += `<a href="${escapeHtml(m[3])}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortUrl(m[3]))}</a>`;
    }
  }
  out += escapeHtml(raw.slice(last));
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), files };
}

// ---------- loop ----------

function render() {
  const now = new Date();
  renderProps(now);
  renderFilters();
  renderBoard(now);
}

refresh();
// Picks up texts to Beast, Canvas syncs and anything Beast changed.
setInterval(refresh, 5000);
