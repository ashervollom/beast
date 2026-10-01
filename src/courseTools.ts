// Agent tools over the course profiles from the deep scan. Only offered in the user's own chats.
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import { scanCourses } from "./courseScan.js";
import * as store from "./store.js";
import { htmlToText } from "./text.js";

const json = (v: unknown) => JSON.stringify(v);

/** Finds a course profile by any name the user might use: "stats", "cs 122", "189", "information retrieval". */
export function findProfile(query: string): store.CourseProfile | undefined {
  const q = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const profiles = Object.values(store.getCourseProfiles());
  const hay = (p: store.CourseProfile) =>
    [p.course, p.title, p.dept && p.number ? `${p.dept} ${p.number}` : "", p.number].join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const words = q.split(" ").filter(Boolean);
  return (
    profiles.find((p) => hay(p).includes(q)) ??
    profiles
      .map((p) => ({ p, hits: words.filter((w) => hay(p).includes(w)).length }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)[0]?.p
  );
}

const ASPECTS = ["overview", "schedule", "links", "office_hours", "grading", "policies", "exams", "key_dates"] as const;

function describe(p: store.CourseProfile, aspect: (typeof ASPECTS)[number]) {
  const f = p.facts;
  const schedule = { meetings: p.meetings, final: p.final, sectionChoicePending: p.sectionChoice?.options.map((o) => o.label) ?? null };
  switch (aspect) {
    case "schedule":
      return schedule;
    case "links":
      return { canvas: p.canvasUrl, website: p.website, links: p.links.filter((l) => l.kind !== "other").concat(p.links.filter((l) => l.kind === "other").slice(0, 10)) };
    case "office_hours":
      return { officeHours: f?.officeHours ?? [], zoom: f?.zoomLinks ?? [] };
    case "grading":
      return { grading: f?.grading ?? [] };
    case "policies":
      return { policies: f?.policies ?? [], textbook: f?.textbook ?? null };
    case "exams":
      return { exams: f?.exams ?? [], officialFinal: p.final };
    case "key_dates":
      return { keyDates: f?.keyDates ?? [] };
    default:
      return {
        course: p.course,
        code: p.dept && p.number ? `${p.dept} ${p.number}` : null,
        title: p.title,
        instructors: p.instructors,
        summary: f?.summary ?? null,
        ...schedule,
        website: p.website,
        keyLinks: p.links.filter((l) => ["ed", "gradescope", "zoom", "recordings", "website", "piazza"].includes(l.kind)),
        gaps: p.gaps,
        lastScanned: p.lastScannedAt,
      };
  }
}

/** Plain keyword overlap; good enough to pick the right paragraphs for the model to read. */
function rank(question: string, texts: { source: string; url: string; text: string }[], limit = 6) {
  const words = (question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !["the", "and", "for", "what", "when", "where", "how", "does", "with"].includes(w));
  return texts
    .map((t) => ({ ...t, score: words.filter((w) => t.text.toLowerCase().includes(w)).length }))
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _s, ...t }) => ({ ...t, text: t.text.slice(0, 700) }));
}

async function liveSitePages(url: string, max = 8): Promise<{ source: string; url: string; text: string }[]> {
  const root = new URL(url);
  const out: { source: string; url: string; text: string }[] = [];
  const queue = [root.toString()];
  const seen = new Set<string>();
  while (queue.length && out.length < max) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(12_000) });
      if (!res.ok) continue;
      const html = await res.text();
      out.push({ source: "Course website (live)", url: u, text: htmlToText(html) });
      for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
        try {
          const next = new URL(m[1], u);
          if (next.origin === root.origin && next.pathname.startsWith(root.pathname)) queue.push(next.toString());
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }
  return out.flatMap((p) => p.text.split(/\n+/).filter((l) => l.length > 30).map((text) => ({ source: p.source, url: p.url, text })));
}

export const courseTools = [
  betaZodTool({
    name: "course_info",
    description:
      "What Beast dug up about a class from Canvas, the syllabus, the course website and the schedule of classes: meeting times and rooms, " +
      "the final exam slot, links (Ed, Gradescope, Zoom, recordings, course website), office hours, grading, policies, exams and key dates. " +
      "Omit course to get an overview of all classes. Exams marked from a syllabus are tentative.",
    inputSchema: z.object({
      course: z.string().optional().describe('Any name for the class: "stats", "cs 122", "189"'),
      aspect: z.enum(ASPECTS).optional(),
    }),
    run: async ({ course, aspect }) => {
      const profiles = Object.values(store.getCourseProfiles());
      if (!profiles.length) return "No classes scanned yet. If Canvas isn't connected, they can text \"connect canvas\".";
      if (!course) return json(profiles.map((p) => describe(p, "overview")));
      const p = findProfile(course);
      if (!p) return `No class matching "${course}". Classes: ${profiles.map((x) => x.course).join(", ")}`;
      return json(describe(p, aspect ?? "overview"));
    },
  }),
  betaZodTool({
    name: "find_course_info",
    description:
      "Search a class's sources for a specific answer that course_info doesn't have (e.g. \"is lecture recorded\", \"what's the late policy for labs\", " +
      "\"where are discussion sections\"). Checks saved excerpts first, then reads the course website live. Returns passages with links; answer from them " +
      "and include the link if it helps.",
    inputSchema: z.object({ course: z.string(), question: z.string() }),
    run: async ({ course, question }) => {
      const p = findProfile(course);
      if (!p) return `No class matching "${course}".`;
      let hits = rank(question, p.excerpts);
      if (hits.length < 2 && p.website) hits = [...hits, ...rank(question, await liveSitePages(p.website))].slice(0, 6);
      return hits.length
        ? json({ course: p.course, passages: hits, canvas: p.canvasUrl })
        : `Nothing about that in ${p.course}'s sources. Point them to ${p.website ?? p.canvasUrl}.`;
    },
  }),
  betaZodTool({
    name: "rescan_course",
    description: "Re-read a class's Canvas pages, syllabus and website right now (e.g. the professor just posted the syllabus). Omit course to rescan all.",
    inputSchema: z.object({ course: z.string().optional() }),
    run: async ({ course }) => {
      const results = await scanCourses({ force: true, only: course ? (findProfile(course)?.course ?? course) : undefined });
      return results.length ? json(results) : "Nothing to scan (Canvas not connected, or no matching class).";
    },
  }),
  betaZodTool({
    name: "set_course_section",
    description:
      "Save which lab or discussion section your user is in, after they tell you (the overview shows sectionChoicePending with the options). " +
      "Pass the 5-digit section code from the options.",
    inputSchema: z.object({ course: z.string(), section_code: z.string() }),
    run: async ({ course, section_code }) => {
      const p = findProfile(course);
      if (!p) return `No class matching "${course}".`;
      const option = p.sectionChoice?.options.find((o) => o.code === section_code.trim());
      if (!option) return `Not one of the options: ${p.sectionChoice?.options.map((o) => `${o.code} (${o.label})`).join(", ") ?? "none pending"}`;
      store.setCourseProfile({ ...p, chosenSections: [...new Set([...p.chosenSections, option.code])], sectionChoice: null });
      await scanCourses({ force: true, only: p.course }); // rebuilds meetings with the chosen section (no model call if nothing changed)
      return `Saved: ${option.label}`;
    },
  }),
];
