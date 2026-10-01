// What Beast knows about a school's schedule of classes. Only UC Irvine has an adapter for now (the free
// Anteater API); other schools get null and rely on Canvas alone until a generic adapter exists.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface TermInfo {
  year: string;
  quarter: string; // "Fall"
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

/** The last term an adapter found, for synchronous callers (the snapshot). Set whenever currentTerm runs. */
let knownTerm: TermInfo | null = null;
export const lastKnownTerm = () => knownTerm;

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
        if (now.getTime() >= from && now.getTime() <= to) return (knownTerm = t);
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

/** The adapter for a user's school, or null when Beast doesn't know that school's schedule system. */
export function adapterFor(school: string | null): ScheduleAdapter | null {
  return school === "UC Irvine" ? uci : null;
}
