// Course lines for the per-message snapshot: week of the term, today's classes, key dates coming up,
// and lab/discussion sections Beast still needs to ask about (once).
import { config } from "./config.js";
import * as store from "./store.js";

const DAY = 864e5;
const WEEKDAY = ["Su", "M", "Tu", "W", "Th", "F", "Sa"];

function localParts(d: Date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => f.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
}

/** "TuTh" -> ["Tu", "Th"] */
const splitDays = (days: string): string[] => days.match(/Su|Sa|Tu|Th|M|W|F/g) ?? [];

/**
 * UCI numbering: when instruction starts mid-week (fall starts on a Thursday) that partial week is week 0 and
 * the next Monday starts week 1; when it starts on a Monday, that's week 1.
 */
function weekOfTerm(instructionStart: string, now: Date): number {
  const start = new Date(`${instructionStart}T12:00:00Z`);
  const dow = start.getUTCDay(); // 0 Sun .. 6 Sat
  const monday = start.getTime() - ((dow + 6) % 7) * DAY;
  const weeks = Math.floor((now.getTime() - monday) / (7 * DAY));
  return dow === 1 ? weeks + 1 : weeks;
}
const to12 = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
};

/** Lines for the snapshot. `ownChat` adds the section question (and marks it asked). */
export function courseLines(ownChat: boolean, now = new Date()): string[] {
  const profiles = Object.values(store.getCourseProfiles());
  if (!profiles.length) return [];
  const lines: string[] = [];
  // The term most of their classes are in (each course profile carries its own).
  const term = profiles.find((p) => p.term)?.term ?? null;
  const today = localParts(now);

  if (term) {
    const week = weekOfTerm(term.instructionStart, now);
    const inFinals = today.date >= term.finalsStart && today.date <= term.finalsEnd;
    lines.push(`Term: ${term.name}, ${inFinals ? "finals week" : today.date < term.instructionStart ? "starts " + term.instructionStart : `week ${week}`} (instruction ends ${term.instructionEnd}).`);
  }

  const inSession = !term || (today.date >= term.instructionStart && today.date <= term.instructionEnd);
  if (inSession) {
    const code = WEEKDAY[today.weekday];
    const classes = profiles
      .flatMap((p) => p.meetings.filter((m) => splitDays(m.days).includes(code)).map((m) => ({ p, m })))
      .sort((a, b) => a.m.start.localeCompare(b.m.start));
    lines.push(
      classes.length
        ? `Classes today: ${classes.map(({ p, m }) => `${p.dept ?? p.course} ${p.number ?? ""} ${m.kind} ${to12(m.start)}-${to12(m.end)}${m.location ? ` @ ${m.location}` : ""}`.replace(/\s+/g, " ")).join("; ")}`
        : "Classes today: none",
    );
  }

  const soon = profiles
    .flatMap((p) => (p.facts?.keyDates ?? []).map((k) => ({ ...k, course: p.course })))
    .filter((k) => k.date >= today.date && Date.parse(k.date) - now.getTime() <= 10 * DAY)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (soon.length) lines.push(`Key dates in the next 10 days (from syllabi/sites): ${soon.map((k) => `${k.title} (${k.course}) ${k.date}`).join("; ")}`);

  if (ownChat) {
    const pending = profiles.filter((p) => p.sectionChoice && !p.sectionChoice.askedAt);
    const first = pending[0];
    if (first?.sectionChoice) {
      lines.push(
        `Ask once, casually, when it fits: which ${first.sectionChoice.kind.toLowerCase()} section they're in for ${first.course} ` +
          `(${first.sectionChoice.options.map((o) => `${o.label} = ${o.code}`).join("; ")}). Save it with set_course_section.`,
      );
      store.setCourseProfile({ ...first, sectionChoice: { ...first.sectionChoice, askedAt: now.toISOString() } });
    }
    const gaps = profiles.filter((p) => p.gaps.length).map((p) => `${p.course}: ${p.gaps.join(", ")}`);
    if (gaps.length) lines.push(`Course scan gaps (mention only if relevant): ${gaps.join("; ")}`);
  }
  return lines;
}
