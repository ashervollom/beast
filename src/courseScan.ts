// The deep course scan: for each current-term Canvas course, gather everything Beast can find (every Canvas
// page, announcement, assignment, quiz and calendar event, syllabus files, the course website, and the
// school's schedule of classes), pull the useful facts out with the model, and save a course profile.
// Runs for the current user (inside withUser).
//
// Thorough but cheap: the sweep is GET-only and budgeted by course size, unchanged content (same hash)
// never reaches the model, and schedule data plus extracted facts are cached per section and shared by
// every enrolled user. When a course website has the real schedule, it outranks Canvas.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import { resolveCourse } from "./canvas.js";
import { canvasGet, canvasGetAll, canvasRateRemaining } from "./canvasApi.js";
import { config, MODELS } from "./config.js";
import { canvasCreds, type CanvasCreds } from "./connections.js";
import { currentUser } from "./session.js";
import { learnSchool } from "./schoolLearning.js";
import { getSchool } from "./schoolDiscovery.js";
import { recordUsage, track } from "./metrics.js";
import { adapterFor, parseCourseCode, parseSectionName, type ScheduledCourse, type Section, type TermInfo } from "./schools.js";
import * as store from "./store.js";
import { extractLinks, htmlToText, sha1, type Link } from "./text.js";

const client = new Anthropic();
const DAY = 864e5;

/** Canvas GET budget per course: a normal course fits in the first, big ones get the second. */
const CALLS_NORMAL = 120;
const CALLS_BIG = 400;
const MAX_FILE_READS = 8;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_SITE_PAGES = 40;
const MAX_SITE_FILES = 5;
/** ~60k tokens of source text per extraction pass, and at most 3 passes per course. */
const PASS_CHARS = 220_000;
const MAX_PASSES = 3;
const MAX_EXCERPTS = 60;
/** Bump when the extraction prompt, schema or text handling changes, so every course re-extracts once. */
const EXTRACTOR_VERSION = "3";

/** File and page names that usually hold logistics (worth reading in full). */
const LOGISTICS = /syllab|schedule|calendar|policy|policies|course.?info|overview|outline|logistic|exam|midterm|final|grading|office.?hours|welcome|start.?here/i;
/** Course names that aren't classes (orientation spaces, trainings, sandboxes). */
const NOT_A_CLASS = /\b(training|orientation|advising|sandbox|testing center|resources?|community|onboarding|module|registration)\b/i;

// ---- Canvas course list ----

interface CanvasCourse {
  id: number;
  name: string;
  course_code: string;
  start_at?: string | null;
  end_at?: string | null;
  term?: { name: string; start_at: string | null; end_at: string | null };
  sections?: { name: string }[];
  teachers?: { display_name: string }[];
  syllabus_body?: string | null;
}

/** Current-term classes at any school: the term hasn't ended, it started (or starts within 3 weeks), and it isn't an orientation/training space. */
export async function currentCourses(creds: CanvasCreds, now = new Date()): Promise<CanvasCourse[]> {
  const all = await canvasGetAll<CanvasCourse>(
    "/api/v1/courses?enrollment_state=active&per_page=50&include[]=term&include[]=sections&include[]=teachers",
    creds,
  );
  return all.filter((c) => {
    if (!c.name) return false;
    const end = c.term?.end_at ?? c.end_at;
    const start = c.start_at ?? c.term?.start_at;
    if (!end || Date.parse(end) < now.getTime()) return false;
    if (start && Date.parse(start) > now.getTime() + 21 * DAY) return false;
    // A course code isn't required (some schools' names have none); a missed class is worse than an extra one.
    const hasCode = Boolean(courseCodeOf(c));
    return !NOT_A_CLASS.test(c.name) || hasCode;
  });
}

function courseCodeOf(c: CanvasCourse): { dept: string; number: string } | null {
  for (const s of c.sections ?? []) {
    const p = parseSectionName(s.name);
    if (p) return p;
  }
  return parseCourseCode(c.course_code) ?? parseCourseCode(c.name) ?? (c.sections ?? []).map((s) => parseCourseCode(s.name)).find(Boolean) ?? null;
}

// ---- gathering ----

type Text = { source: string; url: string; text: string };

interface Gathered {
  texts: Text[];
  links: Link[];
  tabs: { label: string; url: string }[];
  calls: number;
  files: number;
  skipped: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET-only sweep of one Canvas course: everything that can hold course facts, within a size-based budget. */
async function sweepCanvas(course: CanvasCourse, creds: CanvasCreds, termStart: string | null): Promise<Gathered> {
  const base = creds.baseUrl;
  const courseUrl = `${base}/courses/${course.id}`;
  const out: Gathered = { texts: [], links: [], tabs: [], calls: 0, files: 0, skipped: [] };
  let budget = CALLS_NORMAL;

  const get = async <T>(p: string, all = false): Promise<T | null> => {
    if (out.calls >= budget) return null;
    // Stay well inside Canvas's rate limit: slow down when the bucket runs low.
    const remaining = canvasRateRemaining();
    if (remaining !== null && remaining < 100) await sleep(2000);
    out.calls++;
    try {
      return all ? ((await canvasGetAll<unknown>(p, creds)) as T) : await canvasGet<T>(p, creds);
    } catch {
      return null; // a hidden tab or locked page isn't worth stopping for
    }
  };
  const addHtml = (source: string, url: string, html: string | null | undefined) => {
    if (!html) return;
    const text = htmlToText(html);
    if (text.length > 30) out.texts.push({ source, url, text });
    out.links.push(...extractLinks(html, base));
  };

  const full = await get<CanvasCourse>(`/api/v1/courses/${course.id}?include[]=syllabus_body`);
  addHtml("Canvas syllabus", `${courseUrl}/assignments/syllabus`, full?.syllabus_body);
  const front = await get<{ body?: string }>(`/api/v1/courses/${course.id}/front_page`);
  addHtml("Canvas home page", courseUrl, front?.body);

  const tabs = (await get<{ label: string; type: string; html_url: string; hidden?: boolean }[]>(`/api/v1/courses/${course.id}/tabs`)) ?? [];
  for (const t of tabs) if (t.type === "external" && !t.hidden) out.tabs.push({ label: t.label, url: new URL(t.html_url, base).toString() });

  // Modules: every item. Big courses get the bigger budget.
  const modules =
    (await get<{ name: string; items?: { type: string; title: string; page_url?: string; external_url?: string; content_id?: number }[] }[]>(
      `/api/v1/courses/${course.id}/modules?include[]=items&per_page=100`,
      true,
    )) ?? [];
  const pages = new Map<string, string>(); // slug -> title
  const fileIds = new Map<string, string>(); // id -> title
  for (const m of modules) {
    for (const it of m.items ?? []) {
      if (it.type === "Page" && it.page_url) pages.set(it.page_url, `${m.name}: ${it.title}`);
      if (it.type === "File" && it.content_id && LOGISTICS.test(it.title)) fileIds.set(String(it.content_id), it.title);
      if (it.type === "ExternalUrl" && it.external_url) out.links.push({ url: it.external_url, text: it.title });
    }
  }
  const allPages = (await get<{ title: string; url: string }[]>(`/api/v1/courses/${course.id}/pages?per_page=100`, true)) ?? [];
  for (const p of allPages) if (!pages.has(p.url)) pages.set(p.url, p.title);
  const itemCount = modules.reduce((n, m) => n + (m.items?.length ?? 0), 0);
  if (itemCount > 80 || pages.size > 40) budget = CALLS_BIG;

  // Logistics-looking pages first, so they survive the budget on huge courses.
  const orderedPages = [...pages].sort(([, a], [, b]) => Number(LOGISTICS.test(b)) - Number(LOGISTICS.test(a)));
  for (const [slug, title] of orderedPages) {
    const page = await get<{ body?: string }>(`/api/v1/courses/${course.id}/pages/${encodeURIComponent(slug)}`);
    if (!page) {
      if (out.calls >= budget) out.skipped.push(`page "${title}" (budget)`);
      continue;
    }
    addHtml(`Canvas page "${title}"`, `${courseUrl}/pages/${slug}`, page.body);
  }

  // Announcements this term: newest first, dated, because a newer announcement can move a date.
  const since = termStart ?? new Date(Date.now() - 150 * DAY).toISOString();
  const announcements =
    (await get<{ title: string; message: string; html_url: string; posted_at: string }[]>(
      `/api/v1/announcements?context_codes[]=course_${course.id}&start_date=${encodeURIComponent(since)}&per_page=50`,
      true,
    )) ?? [];
  for (const a of announcements) addHtml(`Announcement "${a.title}" (posted ${a.posted_at?.slice(0, 10)})`, a.html_url, a.message);

  const assignments =
    (await get<{ name: string; description: string | null; html_url: string; due_at: string | null }[]>(
      `/api/v1/courses/${course.id}/assignments?per_page=100`,
      true,
    )) ?? [];
  for (const a of assignments) {
    out.texts.push({ source: `Assignment "${a.name}"`, url: a.html_url, text: `${a.name}${a.due_at ? ` (due ${a.due_at})` : ""}\n${a.description ? htmlToText(a.description) : ""}`.trim() });
    if (a.description) out.links.push(...extractLinks(a.description, base));
  }

  const quizzes = (await get<{ title: string; description: string | null; html_url: string; due_at: string | null }[]>(`/api/v1/courses/${course.id}/quizzes?per_page=100`, true)) ?? [];
  for (const q of quizzes) out.texts.push({ source: `Quiz "${q.title}"`, url: q.html_url, text: `${q.title}${q.due_at ? ` (due ${q.due_at})` : ""}\n${q.description ? htmlToText(q.description) : ""}`.trim() });

  const discussions = (await get<{ title: string; message: string | null; html_url: string; pinned?: boolean }[]>(`/api/v1/courses/${course.id}/discussion_topics?per_page=50`, true)) ?? [];
  for (const d of discussions.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))).slice(0, 25)) addHtml(`Discussion "${d.title}"`, d.html_url, d.message);

  const events =
    (await get<{ title: string; start_at: string | null; end_at: string | null; location_name?: string | null; description?: string | null; html_url: string }[]>(
      `/api/v1/calendar_events?context_codes[]=course_${course.id}&all_events=true&per_page=100`,
      true,
    )) ?? [];
  if (events.length) {
    out.texts.push({
      source: "Canvas calendar events",
      url: `${base}/calendar`,
      text: events.map((e) => `${e.title}: ${e.start_at ?? "?"}${e.end_at ? ` to ${e.end_at}` : ""}${e.location_name ? ` @ ${e.location_name}` : ""}${e.description ? ` (${htmlToText(e.description).slice(0, 200)})` : ""}`).join("\n"),
    });
  }

  // Files: the Files list when the course shows it, plus file links found anywhere above.
  const files = (await get<{ id: number; display_name: string }[]>(`/api/v1/courses/${course.id}/files?per_page=100`, true)) ?? [];
  for (const f of files) if (LOGISTICS.test(f.display_name)) fileIds.set(String(f.id), f.display_name);
  for (const l of out.links) {
    const m = l.url.match(/\/courses\/\d+\/files\/(\d+)/);
    if (m && LOGISTICS.test(`${l.text} ${l.url}`)) fileIds.set(m[1], l.text || "file");
  }
  for (const [id, title] of [...fileIds].slice(0, MAX_FILE_READS)) {
    const meta = await get<{ display_name: string; url: string; size: number; "content-type": string }>(`/api/v1/files/${id}`);
    if (!meta?.url || meta.size > MAX_FILE_BYTES) {
      if (meta && meta.size > MAX_FILE_BYTES) out.skipped.push(`file "${title}" (too big)`);
      continue;
    }
    const text = await fileText(meta.url, meta["content-type"], meta.display_name);
    if (text) {
      out.texts.push({ source: `File "${meta.display_name}"`, url: `${courseUrl}/files/${id}`, text });
      out.files++;
    }
  }
  if (fileIds.size > MAX_FILE_READS) out.skipped.push(`${fileIds.size - MAX_FILE_READS} more logistics files`);
  if (out.calls >= budget) out.skipped.push("Canvas call budget reached");
  return out;
}

/** Text from a PDF or DOCX download link (Canvas file URLs carry their own verifier, no token needed). */
async function fileText(url: string, type: string, name: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) return null;
    if (/pdf/i.test(type) || /\.pdf$/i.test(name)) {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const { text } = await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true });
      return text;
    }
    if (/word|docx/i.test(type) || /\.docx$/i.test(name)) {
      const mammoth = await import("mammoth");
      return (await mammoth.extractRawText({ buffer: buf })).value;
    }
    if (/text\/(plain|html)/i.test(type)) return htmlToText(buf.toString("utf8"));
  } catch (err) {
    console.warn("[scan] couldn't read a file:", err instanceof Error ? err.message : err);
  }
  return null;
}

// ---- links ----

const LINK_KINDS: [RegExp, string][] = [
  [/edstem\.org/i, "ed"],
  [/gradescope\.com/i, "gradescope"],
  [/piazza\.com/i, "piazza"],
  [/campuswire\.com/i, "campuswire"],
  [/zoom\.us\/(j|my|s)\//i, "zoom"],
  [/yuja|panopto|youtube\.com|youtu\.be|kaltura/i, "recordings"],
  [/docs\.google|drive\.google/i, "doc"],
  [/sites\.google\.com|github\.io|\.edu\/~|\.edu\/(class|courses?)\/|people\.|notion\.site/i, "website"],
  [/amazon\.|isbn|pearson|mheducation|wiley|cengage|openstax/i, "textbook"],
];

function kindOf(url: string, label = ""): string {
  if (/ed discussion/i.test(label)) return "ed";
  if (/gradescope/i.test(label)) return "gradescope";
  if (/piazza/i.test(label)) return "piazza";
  if (/zoom/i.test(label)) return "zoom";
  if (/yuja|panopto|kaltura/i.test(label)) return "recordings";
  if (/course (web)?site|class (web)?site|course page/i.test(label) && !/canvas|instructure/i.test(url)) return "website";
  for (const [re, kind] of LINK_KINDS) if (re.test(url)) return kind;
  return "other";
}

/**
 * Canvas links aren't course websites. Schools often run Canvas under two names (UCI: canvas.eee.uci.edu and
 * ucirvine.instructure.com), so anything on the connected host, any instructure.com host, a "canvas." host,
 * or a Canvas-shaped path counts.
 */
const isCanvasUrl = (url: string, canvasHost: string) =>
  url.startsWith(canvasHost) ||
  /^https:\/\/[^/]*instructure(-uploads)?\.com\//i.test(url) ||
  /^https:\/\/canvas\.[^/]+\//i.test(url) ||
  /\/courses\/(sis_course_id:)?[\w-]+\/(assignments|pages|files|modules|syllabus)/i.test(url);

/**
 * The course website among the links, or null. A link has to look like *this* course's site: labelled as the
 * course site, or carrying the course number, or a typical course-site host on the school's own domain.
 * (Plain .edu links are often tools, like a plagiarism checker at another university.)
 */
function pickWebsite(links: store.CourseProfile["links"], code: { dept: string; number: string } | null, schoolDomain: string | null, hint: string | null): string | null {
  if (hint) return hint;
  const num = code?.number.toLowerCase().replace(/[^a-z0-9]/g, "");
  let best: { url: string; score: number } | null = null;
  for (const l of links) {
    if (l.kind !== "website" && !/course (web)?site|class (web)?site|course page|course homepage/i.test(l.label)) continue;
    const u = l.url.toLowerCase();
    let score = 0;
    if (/course (web)?site|class (web)?site|course page|course homepage|website/i.test(l.label)) score += 3;
    if (num && u.replace(/[^a-z0-9]/g, "").includes(num)) score += 3;
    if (/sites\.google\.com|github\.io|notion\.site/.test(u)) score += 1;
    if (schoolDomain && new URL(l.url).hostname.endsWith(schoolDomain)) score += 2;
    if (!best || score > best.score) best = { url: l.url, score };
  }
  return best && best.score >= 3 ? best.url : null;
}

function classifyLinks(g: Gathered, canvasHost: string, websiteHint: string | null) {
  const seen = new Set<string>();
  const links: store.CourseProfile["links"] = [];
  const add = (label: string, url: string) => {
    const key = url.replace(/[?#].*$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    const kind = kindOf(url, label);
    if (kind === "other" && (isCanvasUrl(url, canvasHost) || /\.(css|js|png|jpe?g|gif|svg)(\?|$)/i.test(url))) return;
    links.push({ label: label || new URL(url).hostname, url, kind });
  };
  for (const t of g.tabs) add(t.label, t.url);
  if (websiteHint) add("Course website", websiteHint);
  for (const l of g.links) add(l.text, l.url);
  return links.slice(0, 80);
}

// ---- course website ----

/** Same-site crawl: up to 3 levels deep, MAX_SITE_PAGES pages, plus logistics PDFs/DOCX linked from it. */
async function crawlSite(start: string): Promise<{ texts: Text[]; pages: number }> {
  const root = new URL(start);
  const prefix = root.pathname.replace(/\/[^/]*\.[a-z]+$/i, "/");
  const queue: { url: string; depth: number }[] = [{ url: root.toString(), depth: 0 }];
  const seen = new Set<string>();
  const texts: Text[] = [];
  const docs = new Map<string, string>(); // url -> link text
  let pages = 0;
  while (queue.length && pages < MAX_SITE_PAGES) {
    const { url, depth } = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "BeastCourseScan/1.0 (student assistant)" } });
      if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) continue;
      const html = await res.text();
      pages++;
      const text = htmlToText(html);
      if (text.length > 60) texts.push({ source: `Course website (${new URL(url).pathname})`, url, text });
      for (const l of extractLinks(html, url)) {
        const u = new URL(l.url);
        if (/\.(pdf|docx)$/i.test(u.pathname) && LOGISTICS.test(`${l.text} ${u.pathname}`)) docs.set(u.toString(), l.text);
        else if (depth < 3 && u.origin === root.origin && u.pathname.startsWith(prefix) && !seen.has(u.toString())) queue.push({ url: u.toString(), depth: depth + 1 });
      }
    } catch {
      // unreachable page: skip it
    }
  }
  for (const [url, label] of [...docs].slice(0, MAX_SITE_FILES)) {
    const text = await fileText(url, url.endsWith(".pdf") ? "application/pdf" : "application/docx", url);
    if (text) texts.push({ source: `Course website file "${label || path.basename(new URL(url).pathname)}"`, url, text });
  }
  return { texts, pages };
}

/** The site is the real source when it carries schedule/syllabus content, not just a link page. */
function websiteIsPrimary(texts: Text[]): boolean {
  const site = texts.filter((t) => t.source.startsWith("Course website")).map((t) => t.text).join("\n");
  if (site.length < 1500) return false;
  const signals = ["schedule", "syllabus", "lecture", "midterm", "final", "office hours", "exam", "week 1", "grading"].filter((w) => site.toLowerCase().includes(w));
  return signals.length >= 3;
}

// ---- extraction ----

const FactsSchema = z.object({
  summary: z.string().describe("One or two sentences: what the course is and how it's run (in person, online, async)."),
  officeHours: z.array(z.object({ who: z.string(), when: z.string(), where: z.string() })),
  zoomLinks: z.array(z.object({ label: z.string(), url: z.string() })),
  grading: z.array(z.object({ item: z.string(), weight: z.string() })),
  policies: z.array(z.object({ topic: z.string().describe("late work, attendance, regrades, AI use, collaboration, ..."), text: z.string() })),
  textbook: z.string().nullable(),
  exams: z.array(
    z.object({
      title: z.string(),
      type: z.enum(["exam", "midterm", "final", "quiz"]),
      date: z.string().nullable().describe("YYYY-MM-DD if stated, else null"),
      time: z.string().nullable().describe("HH:MM 24h local if stated, else null"),
      source: z.string().describe("Which source said it"),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
  keyDates: z.array(z.object({ title: z.string(), date: z.string().describe("YYYY-MM-DD"), source: z.string() })),
  sectionInfo: z.string().nullable().describe("Discussion / lab section details (times, TAs) if the sources describe them."),
  meetings: z
    .array(z.object({ kind: z.string().describe('"Lec", "Dis", "Lab"'), days: z.string().describe('Like "MWF" or "TuTh"'), start: z.string().describe("HH:MM 24h"), end: z.string(), location: z.string() }))
    .describe("Regular class meetings, only if the sources state days and times."),
  finalExam: z.object({ date: z.string(), start: z.string().nullable(), end: z.string().nullable(), location: z.string().nullable() }).nullable(),
});

type Facts = z.infer<typeof FactsSchema>;

function rankScore(source: string, websiteFirst: boolean): number {
  if (source.startsWith("Course website")) return websiteFirst ? 6 : 3;
  if (/syllab/i.test(source)) return 5;
  if (/^File/.test(source)) return 4;
  if (/^Announcement/.test(source)) return 4; // can move dates
  if (/calendar events/i.test(source)) return 3;
  if (/home page|^Canvas page/.test(source)) return 2;
  if (/^(Assignment|Quiz)/.test(source)) return 1;
  return 0;
}

async function extractFacts(courseLabel: string, termLine: string, sources: Text[], websiteFirst: boolean): Promise<store.CourseFacts | null> {
  const ranked = [...sources].sort((a, b) => rankScore(b.source, websiteFirst) - rankScore(a.source, websiteFirst));
  // Split into passes of PASS_CHARS (each source capped at 40k chars), at most MAX_PASSES.
  const passes: string[][] = [[]];
  let used = 0;
  for (const s of ranked) {
    const chunk = `<source name="${s.source.replace(/"/g, "'")}" url="${s.url}">\n${s.text.slice(0, 40_000)}\n</source>`;
    if (used + chunk.length > PASS_CHARS) {
      if (passes.length >= MAX_PASSES) break;
      passes.push([]);
      used = 0;
    }
    passes.at(-1)!.push(chunk);
    used += chunk.length;
  }
  if (!passes[0].length) return null;

  const precedence = websiteFirst
    ? "This course runs on its own website: for schedule, exams and logistics the course website wins over Canvas pages, except a newer Canvas announcement that changes a date wins over both."
    : "For schedule, exams and logistics, the syllabus wins over other Canvas pages, except a newer Canvas announcement that changes a date wins over both.";
  const results: Facts[] = [];
  for (const [i, parts] of passes.entries()) {
    const res = await client.messages.parse({
      model: MODELS.extract,
      max_tokens: 10_000,
      output_config: { format: zodOutputFormat(FactsSchema) },
      system:
        "You extract course logistics for a student's assistant. Only report what the sources actually say; never guess dates. " +
        "Exams and quizzes: include every one the sources name, including recurring, in-class and online quizzes listed in schedules or " +
        "tables (one entry per quiz), with a date only if stated (resolve weekday-only dates using the term dates). " +
        "Key dates: deadlines and milestones that aren't regular assignments (project milestones, presentations, drop deadlines, no-class days). " +
        `Meetings and the final exam: only when stated. ${precedence} Keep text short.` +
        (passes.length > 1 ? ` This is part ${i + 1} of ${passes.length} of the sources; extract what this part says.` : ""),
      messages: [{ role: "user", content: `Course: ${courseLabel}\n${termLine}\n\n${parts.join("\n\n")}` }],
    });
    recordUsage(MODELS.extract, res.usage);
    if (res.parsed_output) results.push(res.parsed_output);
  }
  return results.length ? mergeFacts(results) : null;
}

/** Merges extraction passes: lists are combined without duplicates, single values come from the first pass that has one. */
function mergeFacts(parts: Facts[]): store.CourseFacts {
  const uniq = <T>(items: T[], key: (t: T) => string) => [...new Map(items.map((t) => [key(t).toLowerCase(), t])).values()];
  const all = <K extends keyof Facts>(k: K) => parts.flatMap((p) => p[k] as unknown as unknown[]);
  return {
    summary: parts.find((p) => p.summary)?.summary ?? "",
    officeHours: uniq(all("officeHours") as Facts["officeHours"], (o) => `${o.who}|${o.when}`),
    zoomLinks: uniq(all("zoomLinks") as Facts["zoomLinks"], (o) => o.url),
    grading: uniq(all("grading") as Facts["grading"], (o) => o.item),
    policies: uniq(all("policies") as Facts["policies"], (o) => o.topic),
    textbook: parts.find((p) => p.textbook)?.textbook ?? null,
    exams: uniq(all("exams") as Facts["exams"], (o) => `${o.title}|${o.date}`),
    keyDates: uniq(all("keyDates") as Facts["keyDates"], (o) => `${o.title}|${o.date}`),
    sectionInfo: parts.find((p) => p.sectionInfo)?.sectionInfo ?? null,
    meetings: uniq(all("meetings") as Facts["meetings"], (o) => `${o.kind}|${o.days}|${o.start}`),
    finalExam: parts.find((p) => p.finalExam)?.finalExam ?? null,
  };
}

// ---- shared per-section cache ----

interface SectionCache {
  contentHash: string;
  facts: store.CourseFacts | null;
  at: string;
}
const cacheFile = (termName: string, key: string) => path.join(config.dataDir, "cache", `section-${termName.replace(/\W+/g, "_")}-${key.replace(/\W+/g, "_")}.json`);

function readCache(file: string): SectionCache | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---- terms ----

/** The term for this course: the school's (adapter/discovery), else Canvas's own term dates. */
function courseTerm(course: CanvasCourse, schoolTerm: TermInfo | null): store.CourseTerm | null {
  const canvasEnd = course.term?.end_at ?? course.end_at ?? null;
  if (schoolTerm && (!canvasEnd || Math.abs(Date.parse(schoolTerm.finalsEnd) - Date.parse(canvasEnd)) < 45 * DAY)) {
    return {
      name: schoolTerm.year ? `${schoolTerm.quarter} ${schoolTerm.year}` : schoolTerm.quarter,
      instructionStart: schoolTerm.instructionStart,
      instructionEnd: schoolTerm.instructionEnd,
      finalsStart: schoolTerm.finalsStart,
      finalsEnd: schoolTerm.finalsEnd,
    };
  }
  if (!canvasEnd) return null;
  const end = canvasEnd.slice(0, 10);
  const startIso = course.start_at ?? course.term?.start_at ?? new Date(Date.parse(canvasEnd) - 15 * 7 * DAY).toISOString();
  const finalsStart = new Date(Date.parse(canvasEnd) - 7 * DAY).toISOString().slice(0, 10);
  return { name: course.term?.name ?? "This term", instructionStart: startIso.slice(0, 10), instructionEnd: finalsStart, finalsStart, finalsEnd: end };
}

const toTermInfo = (t: store.CourseTerm): TermInfo => ({ year: "", quarter: t.name, instructionStart: t.instructionStart, instructionEnd: t.instructionEnd, finalsStart: t.finalsStart, finalsEnd: t.finalsEnd });

// ---- the scan ----

export interface ScanResult {
  course: string;
  isNew: boolean;
  links: number;
  exams: number;
  gaps: string[];
  extracted: boolean;
  primarySource: "website" | "canvas";
}

/** Scans one course and saves its profile. */
export async function scanCourse(course: CanvasCourse, creds: CanvasCreds, schoolTerm: TermInfo | null): Promise<ScanResult> {
  const user = currentUser();
  const prev = store.getCourseProfiles()[String(course.id)];
  const lecture = (course.sections ?? []).map((s) => parseSectionName(s.name)).find(Boolean) ?? null;
  const code = lecture ?? courseCodeOf(course);
  const boardCourse = tidyCourseName(resolveCourse(course.name), code);
  const term = courseTerm(course, schoolTerm);

  // Schedule of classes (public, cached).
  const adapter = adapterFor(user.school);
  let scheduled: ScheduledCourse | null = null;
  // The adapter's own term (UCI needs year + quarter); a Canvas-derived term only when the school has none.
  const lookupTerm = schoolTerm ?? (term ? toTermInfo(term) : null);
  if (adapter && lookupTerm && code) scheduled = await adapter.course(lookupTerm, code.dept, code.number).catch(() => null);
  const teachers = (course.teachers ?? []).map((t) => t.display_name.toLowerCase());
  const mySection =
    scheduled?.sections.find((s) => s.code === lecture?.code) ??
    // Other schools: the only lecture, or the lecture taught by this Canvas course's instructor.
    (scheduled && !lecture
      ? (scheduled.sections.filter((s) => /^lec/i.test(s.type)).find((s, _i, arr) => arr.length === 1 || s.instructors.some((i) => teachers.some((t) => t.includes(i.split(",")[0].toLowerCase())))) ?? null)
      : null);
  const related = relatedSections(scheduled, mySection);

  const gathered = await sweepCanvas(course, creds, term?.instructionStart ?? null);
  const websiteHint = mySection?.webUrl && !isCanvasUrl(mySection.webUrl, creds.baseUrl) ? mySection.webUrl : null;
  let links = classifyLinks(gathered, creds.baseUrl, websiteHint);
  const schoolDomain = getSchool(user.school)?.domain ?? null;
  const website = pickWebsite(links, code, schoolDomain, websiteHint);
  // Only the chosen site keeps the "website" label; other .edu pages stay plain links.
  links = links.map((l) => (l.kind === "website" && l.url !== website ? { ...l, kind: "other" } : l));
  let sitePages = 0;
  if (website) {
    const site = await crawlSite(website);
    gathered.texts.push(...site.texts);
    sitePages = site.pages;
  }
  const websiteFirst = websiteIsPrimary(gathered.texts);

  // Model extraction only when the gathered content changed (per section, shared across classmates).
  const contentHash = sha1(`v${EXTRACTOR_VERSION}\n` + gathered.texts.map((t) => `${t.url}\n${t.text}`).join("\n\n"));
  const cacheKey = lecture?.code ?? `${code ? `${code.dept}${code.number}-` : ""}canvas${course.id}`;
  const cachePath = cacheFile(term?.name ?? "term", cacheKey);
  const cached = readCache(cachePath);
  let facts: store.CourseFacts | null;
  let extracted = false;
  if (cached && cached.contentHash === contentHash) {
    facts = cached.facts;
  } else if (prev && prev.contentHash === contentHash) {
    facts = prev.facts;
  } else {
    const termLine = term ? `Term: ${term.name}, instruction ${term.instructionStart} to ${term.instructionEnd}, finals ${term.finalsStart} to ${term.finalsEnd}.` : "";
    facts = await extractFacts(`${course.name}${code ? ` (${code.dept} ${code.number})` : ""}`, termLine, gathered.texts, websiteFirst).catch((err) => {
      console.error("[scan] extraction failed:", err instanceof Error ? err.message : err);
      return prev?.facts ?? null;
    });
    // Extraction varies run to run. If it suddenly finds far fewer exams than the last good scan, keep the
    // earlier ones it didn't mention (newer entries with the same title still win).
    const before = prev?.facts?.exams ?? [];
    if (facts && before.length >= 3 && facts.exams.length < before.length / 2) {
      const titles = new Set(facts.exams.map((e) => e.title.toLowerCase()));
      facts = { ...facts, exams: [...facts.exams, ...before.filter((e) => !titles.has(e.title.toLowerCase()))] };
      console.warn(`[scan] ${course.name}: extraction found ${facts.exams.length - before.length} fewer exams, kept the earlier ones`);
    }
    extracted = true;
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ contentHash, facts, at: new Date().toISOString() } satisfies SectionCache));
  }
  for (const zl of facts?.zoomLinks ?? []) if (!links.some((l) => l.url === zl.url)) links.push({ label: zl.label, url: zl.url, kind: "zoom" });
  links = links.slice(0, 80);

  const chosen = prev?.chosenSections ?? [];
  let meetings: store.CourseMeeting[] = [mySection, ...related.filter((s) => chosen.includes(s.code) || related.length === 1)]
    .filter((s): s is Section => Boolean(s))
    .flatMap((s) => s.meetings.map((m) => ({ kind: s.type, section: s.num, code: s.code, ...m })));
  // No schedule of classes for this school: use the meetings the syllabus/site states.
  if (!meetings.length) meetings = (facts?.meetings ?? []).map((m) => ({ ...m, section: "", code: "" }));
  const needsChoice = related.length > 1 && !related.some((s) => chosen.includes(s.code));
  const final =
    mySection?.final ??
    (facts?.finalExam?.date && /^\d{4}-\d{2}-\d{2}$/.test(facts.finalExam.date)
      ? { date: facts.finalExam.date, start: facts.finalExam.start ?? "", end: facts.finalExam.end ?? "", location: facts.finalExam.location ?? "" }
      : null);

  const gaps: string[] = [];
  const hasSyllabus = gathered.texts.some((t) => /syllab/i.test(t.source) && t.text.length > 300) || Boolean(facts?.grading.length);
  if (!hasSyllabus) gaps.push("no syllabus posted yet");
  if (!website) gaps.push("no course website found");
  if (!facts?.officeHours.length) gaps.push("office hours not listed yet");
  if (!meetings.length) gaps.push("class meeting times not found");
  if (adapter && code && !scheduled) gaps.push("not found in the schedule of classes");

  const profile: store.CourseProfile = {
    canvasCourseId: course.id,
    course: boardCourse,
    canvasUrl: `${creds.baseUrl}/courses/${course.id}`,
    dept: code?.dept ?? null,
    number: code?.number ?? null,
    title: scheduled?.title || null,
    sectionCode: lecture?.code ?? mySection?.code ?? null,
    instructors: mySection?.instructors.length ? mySection.instructors : (course.teachers ?? []).map((t) => t.display_name).slice(0, 3),
    meetings,
    final,
    website,
    links,
    facts,
    excerpts: excerptsFrom(gathered.texts, websiteFirst),
    gaps,
    sources: [...new Set(gathered.texts.map((t) => t.source.replace(/ ["(].*$/, "")))],
    contentHash,
    lastScannedAt: new Date().toISOString(),
    term,
    primarySource: websiteFirst ? "website" : "canvas",
    coverage: { canvasCalls: gathered.calls, sourcesRead: gathered.texts.length, websitePages: sitePages, files: gathered.files, skipped: gathered.skipped },
    sectionChoice: needsChoice
      ? {
          kind: related[0].type,
          options: related.map((s) => ({ code: s.code, label: `${s.type} ${s.num}: ${s.meetings.map((m) => `${m.days} ${m.start}-${m.end}`).join(", ") || "TBA"}` })),
          askedAt: prev?.sectionChoice?.askedAt ?? null,
        }
      : null,
    chosenSections: chosen,
  };
  store.setCourseProfile(profile);
  const exams = applyFindings(profile);
  return { course: boardCourse, isNew: !prev, links: links.length, exams, gaps, extracted, primarySource: profile.primarySource! };
}

const DEPT_SHORT: Record<string, string> = { COMPSCI: "CS", IN4MATX: "INF", "I&C SCI": "ICS" };

/**
 * Canvas's calendar feed cuts course names off ("Information Retrieval ...", "MGMT 189 LEC ONL: OPER...").
 * Once the real course code is known, those become "CS 121" / "MGMT 189". Names the user picked stay.
 */
function tidyCourseName(name: string, code: { dept: string; number: string } | null): string {
  if (!code || !(/\.\.\.$|…$/.test(name) || /\b(LEC|DIS|LAB)\b.*:/.test(name))) return name;
  const tidy = `${DEPT_SHORT[code.dept] ?? code.dept} ${code.number}`;
  const course = store.findCourse(name);
  if (course && !store.findCourse(tidy)) store.renameCourse(course.id, tidy);
  return store.findCourse(tidy) ? tidy : name;
}

/** Labs/discussions that go with the user's lecture (UCI numbers them after the lecture letter: A -> A1, A2). */
function relatedSections(course: ScheduledCourse | null, lecture: Section | null): Section[] {
  if (!course || !lecture) return [];
  return course.sections.filter(
    (s) => s.code !== lecture.code && s.type !== lecture.type && (s.num.startsWith(lecture.num) || course.sections.filter((x) => x.type === lecture.type).length === 1),
  );
}

/** Short paragraphs that mention useful things, kept for find_course_info (website first when it's primary). */
function excerptsFrom(texts: Text[], websiteFirst: boolean) {
  const out: store.CourseProfile["excerpts"] = [];
  for (const t of [...texts].sort((a, b) => rankScore(b.source, websiteFirst) - rankScore(a.source, websiteFirst))) {
    for (const para of t.text.split(/\n+/)) {
      const p = para.trim();
      if (p.length < 40 || p.length > 600) continue;
      if (!/office hour|zoom|exam|midterm|quiz|final|late|grade|due|discussion|lab|lecture|recording|textbook|section|attendance|regrade|cancel|moved|resched/i.test(p)) continue;
      out.push({ source: t.source, url: t.url, text: p });
      if (out.length >= MAX_EXCERPTS) return out;
    }
  }
  return out;
}

// ---- findings -> board ----

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** "2026-11-04" + "19:30" in the user's timezone -> ISO. All-day exams default to 11:59 PM like Canvas items. */
function localIso(date: string, time: string | null): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (time || "23:59").split(":").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const offset = tzOffsetMinutes(guess);
  return new Date(guess.getTime() - offset * 60_000).toISOString();
}

function tzOffsetMinutes(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, timeZoneName: "longOffset" }).format(d);
  const m = parts.match(/GMT([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/** True when Canvas already has this exam (same course, similar title, within 3 days). */
function canvasHasIt(course: string, title: string, dueAt: string | null): boolean {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const t = words(title);
  return store.listAssignments({ status: "all", course }).some((a) => {
    if (a.source !== "canvas") return false;
    const overlap = [...words(a.title)].filter((w) => t.has(w)).length;
    const close = !dueAt || !a.dueAt || Math.abs(Date.parse(a.dueAt) - Date.parse(dueAt)) < 3 * DAY;
    return overlap > 0 && close && /exam|midterm|final|quiz/i.test(a.title);
  });
}

/** Exams and quizzes go on the board (tentative unless from the official schedule). Returns how many are on it. */
function applyFindings(p: store.CourseProfile): number {
  let count = 0;
  const key = p.sectionCode ?? String(p.canvasCourseId);
  const kept = new Set<string>(); // assignment ids this scan confirmed
  const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9#]+/g) ?? []).filter((w) => !["the", "a", "for", "after", "on", "of", "and", "exam", "quiz"].includes(w)));
  /** An item from an earlier scan that's the same thing worded differently ("Quiz after HW#1" vs "Quiz for HW#1"). */
  const sameThing = (title: string, type: string, dueAt: string | null) =>
    store.listAssignments({ status: "all", course: p.course }).find((a) => {
      if (!a.scanKey || a.type !== type) return false;
      const sameDay = (!dueAt && !a.dueAt) || (dueAt && a.dueAt && Math.abs(Date.parse(a.dueAt) - Date.parse(dueAt)) < 1.5 * DAY);
      const w = words(title);
      return sameDay && [...words(a.title)].some((x) => w.has(x));
    });
  const upsert = (scanKey: string, title: string, type: "exam" | "quiz", dueAt: string | null, tentative: boolean, notes: string) => {
    const existing = store.findByScanKey(scanKey) ?? sameThing(title, type, dueAt);
    if (existing) kept.add(existing.id);
    if (existing) {
      // The user's own edits win; a source that moved the date updates it otherwise.
      if (dueAt && existing.dueAt !== dueAt && !existing.dueAtEditedByUser) store.updateAssignment(existing.id, { dueAt }, { byUser: false });
      count++;
      return;
    }
    if (canvasHasIt(p.course, title, dueAt)) return;
    kept.add(store.addAssignment({ title, course: p.course, type, dueAt, priority: "high", notes, source: "syllabus", url: null, tentative, scanKey }).id);
    track("scan_exam_added");
    count++;
  };

  if (p.final) {
    const official = Boolean(p.sectionCode && p.final.start);
    upsert(
      `final:${key}`,
      `${p.dept ? `${DEPT_SHORT[p.dept] ?? p.dept} ${p.number ?? ""}` : p.course} final exam`.replace(/\s+/g, " ").trim(),
      "exam",
      localIso(p.final.date, p.final.start || null),
      !official,
      `${p.final.start ? `${p.final.start}-${p.final.end}` : "time TBA"}${p.final.location ? ` in ${p.final.location}` : ""}${official ? " (official schedule of classes)" : " (per the syllabus)"}`,
    );
  }
  const termEnd = p.term ? Date.parse(p.term.finalsEnd) + DAY : Infinity;
  for (const e of p.facts?.exams ?? []) {
    // The final is already on the board (official slot, or the syllabus one above); syllabus finals for
    // other lecture sections or "end-of-term exam" wording are the same exam.
    if (p.final && (e.type === "final" || /final|end.of.term/i.test(e.title))) continue;
    if (e.confidence === "low") continue;
    const dueAt = e.date ? localIso(e.date, e.time) : null;
    if (dueAt && (Date.parse(dueAt) < Date.now() - DAY || Date.parse(dueAt) > termEnd)) continue;
    upsert(`exam:${key}:${slug(e.title)}`, e.title, e.type === "quiz" ? "quiz" : "exam", dueAt, true, `per ${e.source}`);
  }

  // Duplicates from earlier scans (the same exam worded differently) go away. Items a thin scan simply didn't
  // find stay: a bad scan must never wipe the board. Only tentative, untouched, unfinished items are eligible.
  const keptItems = store.listAssignments({ status: "all", course: p.course }).filter((a) => kept.has(a.id));
  for (const a of store.listAssignments({ status: "all", course: p.course })) {
    if (!a.scanKey || !a.tentative || kept.has(a.id) || a.status !== "todo" || a.dueAtEditedByUser) continue;
    const duplicate = keptItems.some(
      (k) => k.type === a.type && ((!k.dueAt && !a.dueAt) || (k.dueAt && a.dueAt && Math.abs(Date.parse(k.dueAt) - Date.parse(a.dueAt)) < 1.5 * DAY)),
    );
    if (duplicate) store.deleteAssignment(a.id);
  }
  return count;
}

// ---- running scans ----

const running = new Map<string, Promise<ScanResult[]>>();

/** Scans the user's current courses. `force` rescans everything; otherwise only new or stale ones. */
export function scanCourses({ force = false, only }: { force?: boolean; only?: string } = {}): Promise<ScanResult[]> {
  const id = currentUser().id;
  let p = running.get(id);
  if (!p) {
    p = doScan(force, only).finally(() => running.delete(id));
    running.set(id, p);
  }
  return p;
}

async function doScan(force: boolean, only?: string): Promise<ScanResult[]> {
  const creds = canvasCreds();
  if (!creds) return [];
  const user = currentUser();
  // First scan for someone at a school Beast hasn't learned yet: learn it first (once per school per term).
  await learnSchool(user.school, { canvasHost: creds.baseUrl });
  const schoolTerm = (await adapterFor(user.school)?.currentTerm().catch(() => null)) ?? null;
  const courses = await currentCourses(creds);
  const profiles = store.getCourseProfiles();
  const results: ScanResult[] = [];
  for (const c of courses) {
    if (only && !`${c.name} ${resolveCourse(c.name)}`.toLowerCase().includes(only.toLowerCase())) continue;
    const prev = profiles[String(c.id)];
    if (!force && prev && Date.now() - Date.parse(prev.lastScannedAt) < cadenceMs(prev.term ?? null)) continue;
    try {
      results.push(await scanCourse(c, creds, schoolTerm));
    } catch (err) {
      console.error("[scan] course failed:", err instanceof Error ? err.message : err);
    }
  }
  if (results.length) {
    track("scan");
    console.log(`[scan] ${results.map((r) => `${r.course}: ${r.links} links, ${r.exams} exams, ${r.primarySource}${r.extracted ? " (extracted)" : ""}`).join("; ")}`);
  }
  return results;
}

/** Daily in the first two weeks of the term (pages fill in late), weekly after. */
export function cadenceMs(term: store.CourseTerm | null, now = Date.now()): number {
  if (!term) return 7 * DAY;
  const week = Math.floor((now - Date.parse(term.instructionStart)) / (7 * DAY));
  return week <= 2 ? DAY : 7 * DAY;
}

/** "dug through ur 4 classes: …" for right after Canvas connects. */
export function scanSummary(results: ScanResult[]): string {
  if (!results.length) return "canvas is hooked up, but i didnt find any classes for this term yet. i'll keep checking";
  const lines = results.map(
    (r) => `📚 ${r.course.toLowerCase()}${r.exams ? `, ${r.exams} exam${r.exams > 1 ? "s" : ""} on ur board` : ""}${r.gaps.includes("no syllabus posted yet") ? " (no syllabus yet)" : ""}`,
  );
  return [`canvas is hooked up. dug through ur ${results.length} classes:`, ...lines, "ask me anything about them, links, office hours, whatever"].join("\n");
}
