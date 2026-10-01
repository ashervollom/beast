// The deep course scan: for each current-term Canvas course, gather everything Beast can find (Canvas
// pages, syllabus files, the course website, the school's schedule of classes), pull the useful facts out
// with one model call, and save a course profile. Runs for the current user (inside withUser).
//
// Cheap by design: unchanged content (same hash) never reaches the model, and schedule-of-classes data
// plus extracted facts are cached per section and shared by every enrolled user.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import { resolveCourse } from "./canvas.js";
import { canvasGet, canvasGetAll } from "./canvasApi.js";
import { config, MODELS } from "./config.js";
import { canvasCreds, type CanvasCreds } from "./connections.js";
import { currentUser } from "./session.js";
import { recordUsage, track } from "./metrics.js";
import { adapterFor, parseSectionName, type ScheduledCourse, type Section, type TermInfo } from "./schools.js";
import * as store from "./store.js";
import { extractLinks, htmlToText, sha1, type Link } from "./text.js";

const client = new Anthropic();
const DAY = 864e5;

const MAX_CANVAS_CALLS = 60;
const MAX_PAGES = 25;
const MAX_SITE_PAGES = 15;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** ~60k tokens of source text per course goes to the model, at most. */
const MAX_SOURCE_CHARS = 220_000;
const MAX_EXCERPTS = 40;

// ---- Canvas course list ----

interface CanvasCourse {
  id: number;
  name: string;
  course_code: string;
  term?: { name: string; start_at: string | null; end_at: string | null };
  sections?: { name: string }[];
  teachers?: { display_name: string }[];
  syllabus_body?: string | null;
}

/** Current-term classes only: the term hasn't ended, and at least one section parses as a real class. */
export async function currentCourses(creds: CanvasCreds, now = new Date()): Promise<CanvasCourse[]> {
  const all = await canvasGetAll<CanvasCourse>(
    "/api/v1/courses?enrollment_state=active&per_page=50&include[]=term&include[]=sections&include[]=teachers",
    creds,
  );
  return all.filter((c) => {
    if (!c.name || !c.term?.end_at || Date.parse(c.term.end_at) < now.getTime()) return false;
    if (c.term.start_at && Date.parse(c.term.start_at) > now.getTime() + 21 * DAY) return false;
    return (c.sections ?? []).some((s) => parseSectionName(s.name));
  });
}

// ---- gathering ----

interface Gathered {
  texts: { source: string; url: string; text: string }[];
  links: Link[];
  tabs: { label: string; url: string }[];
}

/** GET-only sweep of one Canvas course, at most MAX_CANVAS_CALLS requests. */
async function sweepCanvas(course: CanvasCourse, creds: CanvasCreds): Promise<Gathered> {
  const base = creds.baseUrl;
  const courseUrl = `${base}/courses/${course.id}`;
  const out: Gathered = { texts: [], links: [], tabs: [] };
  let calls = 0;
  const get = async <T>(p: string, all = false): Promise<T | null> => {
    if (calls >= MAX_CANVAS_CALLS) return null;
    calls++;
    try {
      return all ? ((await canvasGetAll<unknown>(p, creds)) as T) : await canvasGet<T>(p, creds);
    } catch {
      return null; // a hidden tab or locked page isn't an error worth stopping for
    }
  };
  const addHtml = (source: string, url: string, html: string | null | undefined) => {
    if (!html) return;
    const text = htmlToText(html);
    if (text.length > 40) out.texts.push({ source, url, text });
    out.links.push(...extractLinks(html, base));
  };

  const full = await get<CanvasCourse>(`/api/v1/courses/${course.id}?include[]=syllabus_body`);
  addHtml("Canvas syllabus", `${courseUrl}/assignments/syllabus`, full?.syllabus_body);
  const front = await get<{ body?: string }>(`/api/v1/courses/${course.id}/front_page`);
  addHtml("Canvas home page", courseUrl, front?.body);

  const tabs = (await get<{ label: string; type: string; html_url: string; hidden?: boolean }[]>(`/api/v1/courses/${course.id}/tabs`)) ?? [];
  for (const t of tabs) if (t.type === "external" && !t.hidden) out.tabs.push({ label: t.label, url: new URL(t.html_url, base).toString() });

  const modules = (await get<{ name: string; items?: { type: string; title: string; page_url?: string; external_url?: string; html_url?: string }[] }[]>(
    `/api/v1/courses/${course.id}/modules?include[]=items&per_page=50`,
    true,
  )) ?? [];
  const pageUrls: { title: string; slug: string }[] = [];
  for (const m of modules) {
    for (const it of m.items ?? []) {
      if (it.type === "Page" && it.page_url) pageUrls.push({ title: `${m.name}: ${it.title}`, slug: it.page_url });
      if (it.type === "ExternalUrl" && it.external_url) out.links.push({ url: it.external_url, text: it.title });
    }
  }
  if (!modules.length) {
    // Courses without modules often still have pages.
    const pages = (await get<{ title: string; url: string }[]>(`/api/v1/courses/${course.id}/pages?per_page=50`, true)) ?? [];
    for (const p of pages) pageUrls.push({ title: p.title, slug: p.url });
  }
  for (const p of pageUrls.slice(0, MAX_PAGES)) {
    const page = await get<{ body?: string }>(`/api/v1/courses/${course.id}/pages/${encodeURIComponent(p.slug)}`);
    addHtml(`Canvas page "${p.title}"`, `${courseUrl}/pages/${p.slug}`, page?.body);
  }

  const announcements = (await get<{ title: string; message: string; html_url: string; posted_at: string }[]>(
    `/api/v1/announcements?context_codes[]=course_${course.id}&per_page=10`,
  )) ?? [];
  for (const a of announcements) addHtml(`Announcement "${a.title}" (${a.posted_at?.slice(0, 10)})`, a.html_url, a.message);

  const assignments = (await get<{ name: string; description: string | null; html_url: string; due_at: string | null }[]>(
    `/api/v1/courses/${course.id}/assignments?per_page=50`,
    true,
  )) ?? [];
  for (const a of assignments.slice(0, 50)) addHtml(`Assignment "${a.name}"${a.due_at ? ` due ${a.due_at}` : ""}`, a.html_url, a.description);

  // Syllabus-like files linked from the syllabus or pages (the Files tab is often hidden, links still work).
  const fileIds = new Set<string>();
  for (const l of out.links) {
    const m = l.url.match(/\/courses\/\d+\/files\/(\d+)/);
    if (m && /syllab|schedule|course.?info|calendar|policy|policies/i.test(`${l.text} ${l.url}`)) fileIds.add(m[1]);
  }
  for (const id of [...fileIds].slice(0, 4)) {
    const meta = await get<{ display_name: string; url: string; size: number; "content-type": string }>(`/api/v1/files/${id}`);
    if (!meta?.url || meta.size > MAX_FILE_BYTES) continue;
    const text = await fileText(meta.url, meta["content-type"], meta.display_name);
    if (text) out.texts.push({ source: `File "${meta.display_name}"`, url: `${courseUrl}/files/${id}`, text });
  }
  return out;
}

/** Text from a PDF or DOCX download link (Canvas file URLs carry their own verifier, no token needed). */
async function fileText(url: string, type: string, name: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (/pdf/i.test(type) || /\.pdf$/i.test(name)) {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const { text } = await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true });
      return text;
    }
    if (/word|docx/i.test(type) || /\.docx$/i.test(name)) {
      const mammoth = await import("mammoth");
      return (await mammoth.extractRawText({ buffer: buf })).value;
    }
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
  [/yuja|panopto|youtube\.com|youtu\.be/i, "recordings"],
  [/docs\.google|drive\.google/i, "doc"],
  [/sites\.google\.com|github\.io|\.edu\/~|ics\.uci\.edu\/~|people\./i, "website"],
  [/amazon\.|isbn|pearson|mheducation|wiley|cengage|openstax/i, "textbook"],
];

function kindOf(url: string, label = ""): string {
  if (/ed discussion/i.test(label)) return "ed";
  if (/gradescope/i.test(label)) return "gradescope";
  if (/zoom/i.test(label)) return "zoom";
  if (/yuja|panopto/i.test(label)) return "recordings";
  for (const [re, kind] of LINK_KINDS) if (re.test(url)) return kind;
  return "other";
}

/** Canvas links (the school's host or any *.instructure.com alias) aren't worth keeping as course links. */
const isCanvasUrl = (url: string, canvasHost: string) => url.startsWith(canvasHost) || /^https:\/\/[^/]*instructure(-uploads)?\.com\//i.test(url);

function classifyLinks(g: Gathered, canvasHost: string, websiteHint: string | null) {
  const seen = new Set<string>();
  const links: store.CourseProfile["links"] = [];
  const add = (label: string, url: string) => {
    const key = url.replace(/[?#].*$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    const kind = kindOf(url, label);
    // Plain Canvas links and asset noise aren't worth keeping; external tools and real sites are.
    if (kind === "other" && (isCanvasUrl(url, canvasHost) || /\.(css|js|png|jpe?g|gif|svg)(\?|$)/i.test(url))) return;
    links.push({ label: label || new URL(url).hostname, url, kind });
  };
  for (const t of g.tabs) add(t.label, t.url);
  if (websiteHint) add("Course website", websiteHint);
  for (const l of g.links) add(l.text, l.url);
  return links.slice(0, 60);
}

// ---- course website ----

/** Same-site crawl: up to 2 levels deep, at most MAX_SITE_PAGES pages, only under the start path. */
async function crawlSite(start: string): Promise<{ source: string; url: string; text: string }[]> {
  const root = new URL(start);
  const prefix = root.pathname.replace(/\/[^/]*\.[a-z]+$/i, "/");
  const queue: { url: string; depth: number }[] = [{ url: root.toString(), depth: 0 }];
  const seen = new Set<string>();
  const pages: { source: string; url: string; text: string }[] = [];
  while (queue.length && pages.length < MAX_SITE_PAGES) {
    const { url, depth } = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "BeastCourseScan/1.0 (student assistant)" } });
      if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) continue;
      const html = await res.text();
      const text = htmlToText(html);
      if (text.length > 80) pages.push({ source: `Course website (${new URL(url).pathname})`, url, text });
      if (depth < 2) {
        for (const l of extractLinks(html, url)) {
          const u = new URL(l.url);
          if (u.origin === root.origin && u.pathname.startsWith(prefix) && !seen.has(u.toString())) queue.push({ url: u.toString(), depth: depth + 1 });
        }
      }
    } catch {
      // unreachable page: skip it
    }
  }
  return pages;
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
});

async function extractFacts(courseLabel: string, term: TermInfo | null, sources: Gathered["texts"]): Promise<store.CourseFacts | null> {
  let budget = MAX_SOURCE_CHARS;
  const parts: string[] = [];
  // Syllabus-ish sources first, so they survive the budget.
  const ranked = [...sources].sort((a, b) => score(b.source) - score(a.source));
  for (const s of ranked) {
    if (budget <= 0) break;
    const chunk = s.text.slice(0, Math.min(s.text.length, budget, 40_000));
    budget -= chunk.length;
    parts.push(`<source name="${s.source.replace(/"/g, "'")}" url="${s.url}">\n${chunk}\n</source>`);
  }
  if (!parts.length) return null;
  const res = await client.messages.parse({
    model: MODELS.extract,
    max_tokens: 8000,
    output_config: { format: zodOutputFormat(FactsSchema) },
    system:
      "You extract course logistics for a student's assistant. Only report what the sources actually say; never guess dates. " +
      "Exams and quizzes: include each one the sources name, with a date only if stated (resolve weekday-only dates using the term dates). " +
      "Key dates: deadlines and milestones that aren't regular assignments (project milestones, presentations, drop deadlines). Keep text short.",
    messages: [
      {
        role: "user",
        content: `Course: ${courseLabel}\n${term ? `Term: ${term.quarter} ${term.year}, instruction ${term.instructionStart} to ${term.instructionEnd}, finals ${term.finalsStart} to ${term.finalsEnd}.` : ""}\n\n${parts.join("\n\n")}`,
      },
    ],
  });
  recordUsage(MODELS.extract, res.usage);
  return res.parsed_output ?? null;
}

const score = (source: string) => (/syllab/i.test(source) ? 3 : /file|website/i.test(source) ? 2 : /home page|page/i.test(source) ? 1 : 0);

// ---- shared per-section cache ----

interface SectionCache {
  contentHash: string;
  facts: store.CourseFacts | null;
  at: string;
}
const cacheFile = (term: TermInfo | null, code: string) =>
  path.join(config.dataDir, "cache", `section-${term ? `${term.year}-${term.quarter}` : "x"}-${code}.json`);

function readCache(file: string): SectionCache | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---- the scan ----

export interface ScanResult {
  course: string;
  isNew: boolean;
  links: number;
  exams: number;
  gaps: string[];
  extracted: boolean;
}

/** Scans one course and saves its profile. */
export async function scanCourse(course: CanvasCourse, creds: CanvasCreds, term: TermInfo | null): Promise<ScanResult> {
  const user = currentUser();
  const prev = store.getCourseProfiles()[String(course.id)];
  const lecture = (course.sections ?? []).map((s) => parseSectionName(s.name)).find(Boolean) ?? null;
  const boardCourse = tidyCourseName(resolveCourse(course.name), lecture);

  // Schedule of classes (public, cached per course per day).
  const adapter = adapterFor(user.school);
  let scheduled: ScheduledCourse | null = null;
  if (adapter && term && lecture) scheduled = await adapter.course(term, lecture.dept, lecture.number).catch(() => null);
  const mySection = scheduled?.sections.find((s) => s.code === lecture?.code) ?? null;
  const related = relatedSections(scheduled, mySection);

  const gathered = await sweepCanvas(course, creds);
  const websiteHint = mySection?.webUrl && !mySection.webUrl.startsWith(creds.baseUrl) ? mySection.webUrl : null;
  let links = classifyLinks(gathered, creds.baseUrl, websiteHint);
  const website = links.find((l) => l.kind === "website")?.url ?? null;
  if (website) gathered.texts.push(...(await crawlSite(website)));

  // Model extraction only when the gathered content changed (per section, shared across classmates).
  const contentHash = sha1(gathered.texts.map((t) => `${t.url}\n${t.text}`).join("\n\n"));
  const cachePath = cacheFile(term, lecture?.code ?? `canvas${course.id}`);
  const cached = readCache(cachePath);
  let facts: store.CourseFacts | null;
  let extracted = false;
  if (cached && cached.contentHash === contentHash) {
    facts = cached.facts;
  } else if (prev && prev.contentHash === contentHash) {
    facts = prev.facts;
  } else {
    facts = await extractFacts(`${course.name}${lecture ? ` (${lecture.dept} ${lecture.number})` : ""}`, term, gathered.texts).catch((err) => {
      console.error("[scan] extraction failed:", err instanceof Error ? err.message : err);
      return prev?.facts ?? null;
    });
    extracted = true;
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ contentHash, facts, at: new Date().toISOString() } satisfies SectionCache));
  }
  for (const z of facts?.zoomLinks ?? []) if (!links.some((l) => l.url === z.url)) links.push({ label: z.label, url: z.url, kind: "zoom" });
  links = links.slice(0, 60);

  const chosen = prev?.chosenSections ?? [];
  const meetings = [mySection, ...related.filter((s) => chosen.includes(s.code) || related.length === 1)]
    .filter((s): s is Section => Boolean(s))
    .flatMap((s) => s.meetings.map((m) => ({ kind: s.type, section: s.num, code: s.code, ...m })));
  const needsChoice = related.length > 1 && !related.some((s) => chosen.includes(s.code));

  const gaps: string[] = [];
  const hasSyllabus = gathered.texts.some((t) => /syllab/i.test(t.source) && t.text.length > 300) || Boolean(facts?.grading.length);
  if (!hasSyllabus) gaps.push("no syllabus posted yet");
  if (!website) gaps.push("no course website found");
  if (!facts?.officeHours.length) gaps.push("office hours not listed yet");
  if (adapter && !scheduled) gaps.push("not found in the schedule of classes");

  const profile: store.CourseProfile = {
    canvasCourseId: course.id,
    course: boardCourse,
    canvasUrl: `${creds.baseUrl}/courses/${course.id}`,
    dept: lecture?.dept ?? null,
    number: lecture?.number ?? null,
    title: scheduled?.title ?? null,
    sectionCode: lecture?.code ?? null,
    instructors: mySection?.instructors.length ? mySection.instructors : (course.teachers ?? []).map((t) => t.display_name).slice(0, 3),
    meetings,
    final: mySection?.final ?? null,
    website,
    links,
    facts,
    excerpts: excerptsFrom(gathered.texts),
    gaps,
    sources: [...new Set(gathered.texts.map((t) => t.source.replace(/ ".*$/, "")))],
    contentHash,
    lastScannedAt: new Date().toISOString(),
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
  const exams = applyFindings(profile, term);
  return { course: boardCourse, isNew: !prev, links: links.length, exams, gaps, extracted };
}

const DEPT_SHORT: Record<string, string> = { COMPSCI: "CS", IN4MATX: "INF", "I&C SCI": "ICS" };

/**
 * Canvas's calendar feed cuts course names off ("Information Retrieval ...", "MGMT 189 LEC ONL: OPER...").
 * Once the real course code is known, those become "CS 121" / "MGMT 189". Names the user picked stay.
 */
function tidyCourseName(name: string, lecture: { dept: string; number: string } | null): string {
  if (!lecture || !(/\.\.\.$|…$/.test(name) || /\b(LEC|DIS|LAB)\b.*:/.test(name))) return name;
  const tidy = `${DEPT_SHORT[lecture.dept] ?? lecture.dept} ${lecture.number}`;
  const course = store.findCourse(name);
  if (course && !store.findCourse(tidy)) store.renameCourse(course.id, tidy);
  return store.findCourse(tidy) ? tidy : name;
}

/** Labs/discussions that go with the user's lecture (UCI numbers them after the lecture letter: A -> A1, A2). */
function relatedSections(course: ScheduledCourse | null, lecture: Section | null): Section[] {
  if (!course || !lecture) return [];
  return course.sections.filter((s) => s.code !== lecture.code && s.type !== lecture.type && (s.num.startsWith(lecture.num) || course.sections.filter((x) => x.type === lecture.type).length === 1));
}

/** Short paragraphs that mention useful things, kept for find_course_info. */
function excerptsFrom(texts: Gathered["texts"]) {
  const out: store.CourseProfile["excerpts"] = [];
  for (const t of [...texts].sort((a, b) => score(b.source) - score(a.source))) {
    for (const para of t.text.split(/\n{1,}/)) {
      const p = para.trim();
      if (p.length < 40 || p.length > 600) continue;
      if (!/office hour|zoom|exam|midterm|quiz|final|late|grade|due|discussion|lab|lecture|recording|textbook|section/i.test(p)) continue;
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
  const [hh, mm] = (time ?? "23:59").split(":").map(Number);
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
function applyFindings(p: store.CourseProfile, term: TermInfo | null): number {
  let count = 0;
  const upsert = (key: string, title: string, type: "exam" | "quiz", dueAt: string | null, tentative: boolean, notes: string, url: string | null) => {
    const existing = store.findByScanKey(key);
    if (existing) {
      // The user's own edits win; only fill in a date that appeared later.
      if (!existing.dueAt && dueAt) store.updateAssignment(existing.id, { dueAt });
      count++;
      return;
    }
    if (canvasHasIt(p.course, title, dueAt)) return;
    store.addAssignment({ title, course: p.course, type, dueAt, priority: "high", notes, source: "syllabus", url, tentative, scanKey: key });
    track("scan_exam_added");
    count++;
  };

  if (p.final && p.sectionCode) {
    upsert(
      `final:${p.sectionCode}`,
      `${p.dept ? (DEPT_SHORT[p.dept] ?? p.dept) : ""} ${p.number ?? ""} final exam`.trim(),
      "exam",
      localIso(p.final.date, p.final.start),
      false,
      `${p.final.start}-${p.final.end}${p.final.location ? ` in ${p.final.location}` : ""} (official schedule of classes)`,
      null,
    );
  }
  const termEnd = term ? Date.parse(term.finalsEnd) + DAY : Infinity;
  for (const e of p.facts?.exams ?? []) {
    if (e.type === "final" && p.final) continue; // the official slot is already on the board
    if (e.confidence === "low") continue;
    const dueAt = e.date ? localIso(e.date, e.time) : null;
    if (dueAt && (Date.parse(dueAt) < Date.now() - DAY || Date.parse(dueAt) > termEnd)) continue;
    upsert(`exam:${p.sectionCode ?? p.canvasCourseId}:${slug(e.title)}`, e.title, e.type === "quiz" ? "quiz" : "exam", dueAt, true, `per ${e.source}`, null);
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
  const term = (await adapterFor(user.school)?.currentTerm().catch(() => null)) ?? null;
  const courses = await currentCourses(creds);
  const profiles = store.getCourseProfiles();
  const results: ScanResult[] = [];
  for (const c of courses) {
    if (only && !`${c.name} ${resolveCourse(c.name)}`.toLowerCase().includes(only.toLowerCase())) continue;
    const prev = profiles[String(c.id)];
    if (!force && prev && Date.now() - Date.parse(prev.lastScannedAt) < cadenceMs(term)) continue;
    try {
      results.push(await scanCourse(c, creds, term));
    } catch (err) {
      console.error("[scan] course failed:", err instanceof Error ? err.message : err);
    }
  }
  if (results.length) {
    track("scan");
    console.log(`[scan] ${results.map((r) => `${r.course}: ${r.links} links, ${r.exams} exams${r.extracted ? " (extracted)" : ""}`).join("; ")}`);
  }
  return results;
}

/** Daily in the first two weeks of the term (pages fill in late), weekly after. */
export function cadenceMs(term: TermInfo | null, now = Date.now()): number {
  if (!term) return 7 * DAY;
  const week = Math.floor((now - Date.parse(term.instructionStart)) / (7 * DAY));
  return week <= 2 ? DAY : 7 * DAY;
}

/** "scanned ur 4 classes: …" for right after Canvas connects. */
export function scanSummary(results: ScanResult[]): string {
  if (!results.length) return "canvas is hooked up, but i didnt find any classes for this term yet. i'll keep checking";
  const lines = results.map((r) => `📚 ${r.course.toLowerCase()}${r.exams ? `, ${r.exams} exam${r.exams > 1 ? "s" : ""} on ur board` : ""}${r.gaps.includes("no syllabus posted yet") ? " (no syllabus yet)" : ""}`);
  return [`canvas is hooked up. dug through ur ${results.length} classes:`, ...lines, "ask me anything about them, links, office hours, whatever"].join("\n");
}
