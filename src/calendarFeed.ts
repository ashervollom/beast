// A user's private calendar feed (/cal/<slug>.ics): weekly class meetings for the term, exams and quizzes
// from the board, and key dates from syllabi. Subscribing on an iPhone is one tap; Beast keeps it current.
import { config } from "./config.js";
import { lastKnownTerm } from "./schools.js";
import * as store from "./store.js";

const BYDAY: Record<string, string> = { M: "MO", Tu: "TU", W: "WE", Th: "TH", F: "FR", Sa: "SA", Su: "SU" };
const JS_DAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const compact = (date: string, time?: string) => `${date.replace(/-/g, "")}${time ? `T${time.replace(":", "")}00` : ""}`;

/** Folds long lines at 75 octets as the iCalendar spec asks. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

/** UTC timestamp -> local date/time pieces in the user's timezone. */
function local(iso: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (t: string) => f.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

function addMinutes(time: string, mins: number): string {
  const [h, m] = time.split(":").map(Number);
  const t = Math.min(h * 60 + m + mins, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

export function buildCalendar(userName: string | null): string {
  const tz = config.timezone;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const events: string[][] = [];
  const term = lastKnownTerm();

  for (const p of Object.values(store.getCourseProfiles())) {
    const name = p.dept && p.number ? `${p.dept} ${p.number}` : p.course;
    // Weekly meetings for the term.
    if (term) {
      for (const m of p.meetings) {
        const days = (m.days.match(/Su|Sa|Tu|Th|M|W|F/g) ?? []).map((d) => BYDAY[d]);
        if (!days.length || !m.start || !m.end) continue;
        // DTSTART must be a real occurrence: the first meeting day on or after instruction start.
        const first = new Date(`${term.instructionStart}T12:00:00Z`);
        while (!days.some((d) => JS_DAY[d] === first.getUTCDay())) first.setUTCDate(first.getUTCDate() + 1);
        const firstDate = first.toISOString().slice(0, 10);
        const kind = m.kind === "Lec" ? "Lecture" : m.kind === "Dis" ? "Discussion" : m.kind === "Lab" ? "Lab" : m.kind;
        events.push([
          `UID:class-${m.code}-${m.days}@beast`,
          `DTSTAMP:${stamp}`,
          `SUMMARY:${esc(`${name} ${kind}`)}`,
          `DTSTART;TZID=${tz}:${compact(firstDate, m.start)}`,
          `DTEND;TZID=${tz}:${compact(firstDate, m.end)}`,
          `RRULE:FREQ=WEEKLY;BYDAY=${days.join(",")};UNTIL=${compact(term.instructionEnd)}T235959Z`,
          ...(m.location ? [`LOCATION:${esc(m.location)}`] : []),
          `DESCRIPTION:${esc([p.facts?.zoomLinks[0]?.url ? `Zoom: ${p.facts.zoomLinks[0].url}` : "", `Canvas: ${p.canvasUrl}`].filter(Boolean).join("\n"))}`,
          `URL:${p.canvasUrl}`,
        ]);
      }
    }
    // Key dates (all-day).
    for (const k of p.facts?.keyDates ?? []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k.date)) continue;
      const next = new Date(`${k.date}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      events.push([
        `UID:key-${p.canvasCourseId}-${k.date}-${k.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}@beast`,
        `DTSTAMP:${stamp}`,
        `SUMMARY:${esc(`${name}: ${k.title}`)}`,
        `DTSTART;VALUE=DATE:${compact(k.date)}`,
        `DTEND;VALUE=DATE:${compact(next.toISOString().slice(0, 10))}`,
        `DESCRIPTION:${esc(`From ${k.source}. Check Canvas for changes.`)}`,
      ]);
    }
  }

  // Exams and quizzes from the board (Canvas, syllabus or the official final schedule).
  for (const a of store.listAssignments({ status: "all" })) {
    if (!a.dueAt || (a.type !== "exam" && a.type !== "quiz")) continue;
    const { date, time } = local(a.dueAt);
    const allDay = time === "23:59";
    const end = new Date(`${date}T12:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    const finalSlot = a.notes.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})/);
    events.push([
      `UID:item-${a.id}@beast`,
      `DTSTAMP:${stamp}`,
      `SUMMARY:${esc(`${a.title}${a.course ? ` (${a.course})` : ""}${a.tentative ? " (tentative)" : ""}`)}`,
      ...(allDay
        ? [`DTSTART;VALUE=DATE:${compact(date)}`, `DTEND;VALUE=DATE:${compact(end.toISOString().slice(0, 10))}`]
        : [`DTSTART;TZID=${tz}:${compact(date, time)}`, `DTEND;TZID=${tz}:${compact(date, finalSlot ? finalSlot[2] : addMinutes(time, 60))}`]),
      ...(a.notes ? [`DESCRIPTION:${esc(a.notes.slice(0, 300))}`] : []),
    ]);
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Beast//School//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(`Beast${userName ? ` · ${userName}` : ""}`)}`,
    `X-WR-TIMEZONE:${tz}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
    ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
