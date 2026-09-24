// Minimal iCalendar (RFC 5545) reader: enough for Canvas calendar feeds.

export interface IcsDate {
  /** ISO 8601 instant, or YYYY-MM-DD for all-day values. */
  value: string;
  allDay: boolean;
}

export interface IcsEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  url: string | null;
  start: IcsDate | null;
  end: IcsDate | null;
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  // Continuation lines start with a space or tab.
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseLine(line: string): Property | null {
  // The name/params part ends at the first ':' that isn't inside a quoted param value.
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

const unescapeText = (v: string) =>
  v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));

/** Offset (ms) of `timeZone` from UTC at the instant `utcMs`. */
function tzOffset(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs;
}

/** Converts a wall-clock time in `timeZone` to a UTC instant (DST-aware). */
export function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - tzOffset(guess, timeZone);
  return new Date(guess - tzOffset(first, timeZone));
}

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseDate(prop: Property, defaultZone: string): IcsDate | null {
  const m = prop.value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { value: `${y}-${mo}-${d}`, allDay: true };
  const nums = [y, mo, d, h, mi, s].map(Number) as [number, number, number, number, number, number];
  if (z) return { value: new Date(Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5])).toISOString(), allDay: false };
  const zone = prop.params.TZID && isValidZone(prop.params.TZID) ? prop.params.TZID : defaultZone;
  return { value: zonedTimeToUtc(...nums, zone).toISOString(), allDay: false };
}

/** Parses the VEVENTs out of an .ics document. Floating times are read in `defaultZone`. */
export function parseIcs(text: string, defaultZone: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let current: IcsEvent | null = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      current = { uid: "", summary: "", description: "", location: "", url: null, start: null, end: null };
      continue;
    }
    if (line === "END:VEVENT") {
      if (current?.uid) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    switch (prop.name) {
      case "UID":
        current.uid = prop.value.trim();
        break;
      case "SUMMARY":
        current.summary = unescapeText(prop.value).trim();
        break;
      case "DESCRIPTION":
        current.description = unescapeText(prop.value).trim();
        break;
      case "LOCATION":
        current.location = unescapeText(prop.value).trim();
        break;
      case "URL":
        current.url = prop.value.trim() || null;
        break;
      case "DTSTART":
        current.start = parseDate(prop, defaultZone);
        break;
      case "DTEND":
        current.end = parseDate(prop, defaultZone);
        break;
    }
  }
  return events;
}
