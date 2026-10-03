// What Beast knows about a school's schedule of classes and term dates. UC Irvine has a hand-written adapter
// (the free Anteater API). Every other school gets a generic adapter built from what school discovery
// learned: term dates from the academic calendar, and course sections looked up on the school's public
// schedule of classes with web search (cached). Schools Beast couldn't learn fall back to Canvas alone.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import { config, MODELS } from "./config.js";
import { recordUsage } from "./metrics.js";
import { getSchool, type SchoolProfile } from "./schoolDiscovery.js";

export interface TermInfo {
  year: string;
  quarter: string; // "Fall" (or a full term name like "Fall 2026" for discovered schools)
  instructionStart: string; // YYYY-MM-DD
  instructionEnd: string;
  finalsStart: string;
  finalsEnd: string;
}

export interface Meeting {
  days: string; // "TuTh"
  start: string; // "12:30" (24h, local)
  end: string;
  location: string;
}

export interface Section {
  code: string; // "37030"
  type: string; // "Lec" | "Dis" | "Lab" | ...
  num: string; // "A", "A1"
  instructors: string[];
  meetings: Meeting[];
  final: { date: string; start: string; end: string; location: string } | null; // date YYYY-MM-DD
  webUrl: string;
}

export interface ScheduledCourse {
  dept: string;
  number: string;
  title: string;
  sections: Section[];
}

export interface ScheduleAdapter {
  currentTerm(now?: Date): Promise<TermInfo | null>;
  course(term: TermInfo, dept: string, number: string): Promise<ScheduledCourse | null>;
}

/** "STATS 110 LEC A: STATS METH DATA I (37030)" -> parts; null for non-class sections ("SHAPE Student Training"). */
export function parseSectionName(name: string): { dept: string; number: string; type: string; num: string; code: string } | null {
  const m = name.match(/^([A-Z][A-Z0-9&/ ]*?)\s+(\d+[A-Z]*)\s+([A-Z]{2,4})\s+([A-Z0-9]+)\b.*\((\d{5})\)\s*$/i);
  if (!m) return null;
  return { dept: m[1].toUpperCase(), number: m[2].toUpperCase(), type: m[3], num: m[4].toUpperCase(), code: m[5] };
}

/**
 * Any school: a course code from a Canvas course or section name. "CS 101-001", "MATH 2B", "ECON-1A",
 * "Stats 110/201 Fall 2026". Returns null when there's nothing that looks like a course code.
 */
export function parseCourseCode(text: string): { dept: string; number: string } | null {
  const m = text.toUpperCase().match(/\b([A-Z]{2,8}(?:\s?&\s?[A-Z]{1,4})?)[\s-]?(\d{1,4}[A-Z]{0,2})\b/);
  if (!m || /^(FALL|WINTER|SPRING|SUMMER|TERM|SEM|SECTION|SEC|LEC|DIS|LAB)$/.test(m[1])) return null;
  return { dept: m[1].replace(/\s+/g, " "), number: m[2] };
}

// ---- UC Irvine: Anteater API (https://anteaterapi.com), no key needed ----

const API = "https://anteaterapi.com/v2/rest";
const CACHE_DIR = () => path.join(config.dataDir, "cache");
const DAY = 864e5;

/** Small disk cache for public schedule data, shared by every user. */
async function cached<T>(name: string, maxAgeMs: number, load: () => Promise<T>): Promise<T> {
  const file = path.join(CACHE_DIR(), `${name}.json`);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < maxAgeMs) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // not cached yet
  }
  const value = await load();
  fs.mkdirSync(CACHE_DIR(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return value;
}

async function anteater<T>(pathWithQuery: string): Promise<T> {
  const res = await fetch(`${API}${pathWithQuery}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Anteater ${pathWithQuery.split("?")[0]} -> HTTP ${res.status}`);
  const body = (await res.json()) as { ok: boolean; data: T };
  if (!body.ok) throw new Error(`Anteater ${pathWithQuery.split("?")[0]} -> not ok`);
  return body.data;
}

const hhmm = (t?: { hour: number; minute: number }) => (t ? `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}` : "");

interface WebsocSection {
  sectionCode: string;
  sectionType: string;
  sectionNum: string;
  instructors: string[];
  meetings: { timeIsTBA: boolean; bldg?: string[]; days?: string; startTime?: { hour: number; minute: number }; endTime?: { hour: number; minute: number } }[];
  finalExam: { examStatus: string; month?: number; day?: number; startTime?: { hour: number; minute: number }; endTime?: { hour: number; minute: number }; bldg?: string[] };
  webURL: string;
  isCancelled?: boolean;
}

export const uci: ScheduleAdapter = {
  async currentTerm(now = new Date()) {
    const year = now.getFullYear();
    // The quarter whose window (a week before instruction through finals) contains today.
    const candidates = [
      { year: year - 1, quarter: "Fall" },
      { year, quarter: "Winter" },
      { year, quarter: "Spring" },
      { year, quarter: "Summer1" },
      { year, quarter: "Summer2" },
      { year, quarter: "Fall" },
    ];
    for (const c of candidates) {
      try {
        const t = await cached(`uci-term-${c.year}-${c.quarter}`, 30 * DAY, () => anteater<TermInfo>(`/calendar?year=${c.year}&quarter=${c.quarter}`));
        const from = Date.parse(t.instructionStart) - 7 * DAY;
        const to = Date.parse(t.finalsEnd) + DAY;
        if (now.getTime() >= from && now.getTime() <= to) return t;
      } catch {
        // that quarter doesn't exist (e.g. summer sessions) or the API is down: try the next
      }
    }
    return null;
  },

  async course(term, dept, number) {
    const q = `/websoc?year=${term.year}&quarter=${encodeURIComponent(term.quarter)}&department=${encodeURIComponent(dept)}&courseNumber=${encodeURIComponent(number)}`;
    const data = await cached(`uci-websoc-${term.year}-${term.quarter}-${dept}-${number}`.replace(/[^\w-]/g, "_"), DAY, () =>
      anteater<{ schools: { departments: { courses: { deptCode: string; courseNumber: string; courseTitle: string; sections: WebsocSection[] }[] }[] }[] }>(q),
    );
    const c = data.schools.flatMap((s) => s.departments).flatMap((d) => d.courses)[0];
    if (!c) return null;
    const year = Number(term.year);
    return {
      dept: c.deptCode,
      number: c.courseNumber,
      title: c.courseTitle,
      sections: c.sections
        .filter((s) => !s.isCancelled)
        .map((s) => ({
          code: s.sectionCode,
          type: s.sectionType,
          num: s.sectionNum,
          instructors: s.instructors.filter((i) => i !== "STAFF"),
          meetings: s.meetings
            .filter((m) => !m.timeIsTBA && m.days)
            .map((m) => ({ days: m.days!, start: hhmm(m.startTime), end: hhmm(m.endTime), location: (m.bldg ?? []).join(", ") })),
          // Anteater's final exam month is zero-based (11 = December).
          final:
            s.finalExam.examStatus === "SCHEDULED_FINAL" && s.finalExam.month !== undefined && s.finalExam.day !== undefined
              ? {
                  date: `${year}-${String(s.finalExam.month + 1).padStart(2, "0")}-${String(s.finalExam.day).padStart(2, "0")}`,
                  start: hhmm(s.finalExam.startTime),
                  end: hhmm(s.finalExam.endTime),
                  location: (s.finalExam.bldg ?? []).join(", "),
                }
              : null,
          webUrl: s.webURL,
        })),
    };
  },
};

// ---- every other school: built from the discovered school profile ----

const WebSectionsSchema = z.object({
  title: z.string().nullable(),
  sections: z.array(
    z.object({
      code: z.string().describe("Section id/number as the school writes it"),
      type: z.string().describe('"Lec", "Dis", "Lab", "Sem"'),
      num: z.string(),
      instructors: z.array(z.string()),
      meetings: z.array(z.object({ days: z.string().describe('Like "MWF" or "TuTh"'), start: z.string().describe("HH:MM 24h"), end: z.string(), location: z.string() })),
      final: z.object({ date: z.string(), start: z.string(), end: z.string(), location: z.string() }).nullable(),
    }),
  ),
});

const termOf = (p: SchoolProfile): TermInfo | null =>
  p.currentTerm
    ? {
        year: "",
        quarter: p.currentTerm.name,
        instructionStart: p.currentTerm.instructionStart,
        instructionEnd: p.currentTerm.instructionEnd,
        finalsStart: p.currentTerm.finalsStart ?? p.currentTerm.instructionEnd,
        finalsEnd: p.currentTerm.finalsEnd ?? p.currentTerm.instructionEnd,
      }
    : null;

function webAdapter(p: SchoolProfile): ScheduleAdapter {
  const client = new Anthropic();
  return {
    async currentTerm() {
      return termOf(p);
    },
    async course(term, dept, number) {
      const soc = p.scheduleOfClasses;
      if (!soc) return null;
      const key = `web-${p.id}-${term.quarter}-${dept}-${number}`.replace(/[^\w-]/g, "_");
      return cached(key, 7 * DAY, async () => {
        const domains = p.domain ? [p.domain] : undefined;
        const res = await client.beta.messages.create({
          model: MODELS.extract,
          max_tokens: 6000,
          output_config: { effort: "low" },
          tools: [
            { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5, ...(domains ? { allowed_domains: domains } : {}) },
            { type: "web_search_20260209", name: "web_search", max_uses: 3, ...(domains ? { allowed_domains: domains } : {}) },
          ],
          messages: [
            {
              role: "user",
              content:
                `Look up ${dept} ${number} for ${term.quarter} at ${p.name} on the public schedule of classes (${soc.url}; ` +
                `${soc.howToLookUp}). List every section: type, number, id, instructors, meeting days/times/rooms, and the final ` +
                "exam if listed. Only what the page says.",
            },
          ],
        });
        recordUsage(MODELS.extract, res.usage);
        const notes = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n");
        if (!notes.trim()) return null;
        const parsed = await client.messages.parse({
          model: MODELS.extract,
          max_tokens: 4000,
          output_config: { format: zodOutputFormat(WebSectionsSchema) },
          messages: [{ role: "user", content: `Course ${dept} ${number}. Turn these notes into the schema; empty sections if none were found.\n\n${notes.slice(0, 40_000)}` }],
        });
        recordUsage(MODELS.extract, parsed.usage);
        const out = parsed.parsed_output;
        if (!out || !out.sections.length) return null;
        return { dept, number, title: out.title ?? "", sections: out.sections.map((x) => ({ ...x, webUrl: "" })) };
      });
    },
  };
}

/** The adapter for a user's school: UCI's own, a discovered school's generic one, or null (Canvas only). */
export function adapterFor(school: string | null): ScheduleAdapter | null {
  if (school === "UC Irvine") return uci;
  const profile = getSchool(school);
  return profile && (profile.currentTerm || profile.scheduleOfClasses) ? webAdapter(profile) : null;
}
