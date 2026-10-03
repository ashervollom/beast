// Beast learns a school the first time a student from it shows up: Canvas address, term dates, how to look
// up a class in the public schedule, which email/calendar provider and course tools the school uses. It
// researches with web search, saves a school profile shared by everyone at that school, and the rest of
// Beast (course scan, connect page, suggestions) reads that profile. Refreshed each term.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import { config, MODELS } from "./config.js";
import { recordUsage } from "./metrics.js";

const client = new Anthropic();
const DAY = 864e5;

export interface SchoolTerm {
  name: string; // "Fall 2026"
  instructionStart: string; // YYYY-MM-DD
  instructionEnd: string;
  finalsStart: string | null;
  finalsEnd: string | null;
}

export interface SchoolProfile {
  id: string;
  name: string;
  domain: string | null; // "uci.edu"
  canvasHost: string | null; // "https://canvas.eee.uci.edu"
  termSystem: "quarter" | "semester" | "trimester" | "unknown";
  currentTerm: SchoolTerm | null;
  holidays: { name: string; date: string }[];
  scheduleOfClasses: { url: string; howToLookUp: string } | null;
  emailProvider: "google" | "microsoft" | "other" | "unknown";
  courseTools: string[];
  studentApps: string[];
  sources: string[];
  learnedAt: string;
  /** "builtin" for schools with a hand-written adapter (UCI), "discovered" otherwise. */
  origin: "builtin" | "discovered";
}

export const schoolId = (name: string) => name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const file = (id: string) => path.join(config.dataDir, "schools", `${id}.json`);

/** UC Irvine has its own adapter (Anteater API); its profile is written by hand. */
const UCI: Omit<SchoolProfile, "learnedAt" | "currentTerm"> = {
  id: "uc-irvine",
  name: "UC Irvine",
  domain: "uci.edu",
  canvasHost: "https://canvas.eee.uci.edu",
  termSystem: "quarter",
  holidays: [],
  scheduleOfClasses: { url: "https://www.reg.uci.edu/perl/WebSoc", howToLookUp: "Anteater API websoc (built in)" },
  emailProvider: "google",
  courseTools: ["Ed Discussion", "Gradescope", "Zoom", "YuJa", "Panopto"],
  studentApps: ["Anteater API", "PeterPortal", "AntAlmanac", "ZotPortal"],
  sources: ["built in"],
  origin: "builtin",
};

export function getSchool(name: string | null): SchoolProfile | null {
  if (!name) return null;
  if (name === "UC Irvine") return { ...UCI, currentTerm: null, learnedAt: "" };
  try {
    return JSON.parse(fs.readFileSync(file(schoolId(name)), "utf8"));
  } catch {
    return null;
  }
}

function save(profile: SchoolProfile) {
  fs.mkdirSync(path.dirname(file(profile.id)), { recursive: true });
  fs.writeFileSync(file(profile.id), JSON.stringify(profile, null, 2));
}

/** True when the saved profile is missing or its term is over (or it's more than ~4 months old). */
export function needsDiscovery(name: string | null, now = Date.now()): boolean {
  if (!name || name === "UC Irvine") return false;
  const p = getSchool(name);
  if (!p) return true;
  const termOver = p.currentTerm?.finalsEnd ?? p.currentTerm?.instructionEnd;
  return (termOver ? Date.parse(termOver) + 7 * DAY < now : false) || now - Date.parse(p.learnedAt) > 120 * DAY;
}

const ProfileSchema = z.object({
  officialName: z.string(),
  domain: z.string().nullable().describe('Main web domain, like "berkeley.edu"'),
  canvasHost: z.string().nullable().describe("Students' Canvas URL origin, like https://bcourses.berkeley.edu, or null if the school doesn't use Canvas"),
  termSystem: z.enum(["quarter", "semester", "trimester", "unknown"]),
  currentTerm: z
    .object({
      name: z.string(),
      instructionStart: z.string().describe("YYYY-MM-DD"),
      instructionEnd: z.string().describe("YYYY-MM-DD"),
      finalsStart: z.string().nullable(),
      finalsEnd: z.string().nullable(),
    })
    .nullable(),
  holidays: z.array(z.object({ name: z.string(), date: z.string().describe("YYYY-MM-DD") })),
  scheduleOfClasses: z
    .object({ url: z.string(), howToLookUp: z.string().describe("How to find one course's sections there (URL pattern or search steps)") })
    .nullable(),
  emailProvider: z.enum(["google", "microsoft", "other", "unknown"]).describe("Student email: Google Workspace (Gmail) or Microsoft 365 (Outlook)"),
  courseTools: z.array(z.string()).describe("Course tools widely used there: Ed Discussion, Piazza, Gradescope, Zoom, Panopto, YuJa, ..."),
  studentApps: z.array(z.string()).describe("Popular student apps or sites for scheduling, grades, dining, transit"),
  sources: z.array(z.string()).describe("URLs the facts came from"),
});

/**
 * Researches a school with web search and saves its profile. One run per school per term, with a hard cap on
 * searches and fetches. Returns null if research failed (Beast still works from Canvas alone).
 */
export async function discoverSchool(name: string, hints: { canvasHost?: string | null; emailDomain?: string | null } = {}): Promise<SchoolProfile | null> {
  const today = new Date().toISOString().slice(0, 10);
  const domainHint = hints.emailDomain ?? (hints.canvasHost ? new URL(hints.canvasHost).hostname.split(".").slice(-2).join(".") : null);
  try {
    // 1) Research with the web tools (server-side; Anthropic runs the searches and fetches).
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: "user",
        content:
          `Research this college for a student assistant app. Today is ${today}.\nSchool: ${name}` +
          `${hints.canvasHost ? `\nTheir Canvas is at ${hints.canvasHost}` : ""}${domainHint ? `\nLikely domain: ${domainHint}` : ""}\n\n` +
          "Find, preferring the school's own website: the Canvas address students use; quarter or semester; the current (or next) term's " +
          "instruction start/end and finals dates plus holidays from the official academic calendar; the public schedule of classes and how " +
          "to look up one course's sections and meeting times there; whether student email is Google or Microsoft; which course tools are " +
          "common (Ed, Piazza, Gradescope, Zoom, Panopto, YuJa); and popular student apps. Write concise notes with the source URL for each fact.",
      },
    ];
    const tools: Anthropic.Beta.BetaToolUnion[] = [
      { type: "web_search_20260209", name: "web_search", max_uses: 8 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 },
    ];
    let notes = "";
    for (let turn = 0; turn < 4; turn++) {
      const res = await client.beta.messages.create({ model: MODELS.extract, max_tokens: 8000, output_config: { effort: "medium" }, tools, messages });
      recordUsage(MODELS.extract, res.usage);
      notes += res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n");
      if (res.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: res.content }); // the server paused a long research turn; let it continue
    }
    if (!notes.trim()) return null;

    // 2) Turn the notes into the fixed schema.
    const parsed = await client.messages.parse({
      model: MODELS.extract,
      max_tokens: 4000,
      output_config: { format: zodOutputFormat(ProfileSchema) },
      system: "Fill the schema from the research notes only. Use null or 'unknown' when the notes don't say. Dates as YYYY-MM-DD.",
      messages: [{ role: "user", content: `School: ${name}\n\nResearch notes:\n${notes.slice(0, 60_000)}` }],
    });
    recordUsage(MODELS.extract, parsed.usage);
    const p = parsed.parsed_output;
    if (!p) return null;

    const profile: SchoolProfile = {
      id: schoolId(name),
      name,
      domain: p.domain,
      canvasHost: normalizeOrigin(p.canvasHost) ?? normalizeOrigin(hints.canvasHost ?? null),
      termSystem: p.termSystem,
      currentTerm: p.currentTerm,
      holidays: p.holidays,
      scheduleOfClasses: p.scheduleOfClasses,
      emailProvider: p.emailProvider,
      courseTools: p.courseTools.slice(0, 15),
      studentApps: p.studentApps.slice(0, 15),
      sources: p.sources.slice(0, 20),
      learnedAt: new Date().toISOString(),
      origin: "discovered",
    };
    save(profile);
    console.log(`[school] learned ${name}: canvas ${profile.canvasHost ?? "?"}, ${profile.termSystem}, schedule lookup ${profile.scheduleOfClasses ? "found" : "not found"}`);
    return profile;
  } catch (err) {
    console.error(`[school] discovery failed for a school:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function normalizeOrigin(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Plain-language lines about the user's school for the agent's context. */
export function schoolContextLine(name: string | null): string {
  const p = getSchool(name);
  if (!p) return "";
  const bits = [
    p.termSystem !== "unknown" ? `${p.termSystem} system` : "",
    p.emailProvider !== "unknown" ? `student email is ${p.emailProvider === "google" ? "Google (Gmail)" : p.emailProvider === "microsoft" ? "Microsoft (Outlook)" : "other"}` : "",
    p.courseTools.length ? `common tools: ${p.courseTools.join(", ")}` : "",
  ].filter(Boolean);
  return bits.length ? `Their school (${p.name}): ${bits.join("; ")}.` : "";
}
