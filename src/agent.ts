import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import { config } from "./config.js";
import * as store from "./store.js";
import { buildSnapshot, formatLocal } from "./snapshot.js";
import { replySystemPrompt } from "./prompts.js";
import { cleanText } from "./sanitize.js";
import { getDashboardUrl } from "./tunnel.js";

const client = new Anthropic();

export type Channel = "imessage" | "web";

const statusEnum = z.enum(["todo", "in_progress", "done"]);
const typeEnum = z.enum(["homework", "exam", "quiz", "project", "reading", "paper", "other"]);
const priorityEnum = z.enum(["low", "medium", "high"]);

const json = (v: unknown) => JSON.stringify(v);

const ASSIGNMENT_FIELDS =
  "Each assignment has: id, title, course, type, due_at (ISO) and due_local, status (todo | in_progress | done: the student's own tracking, " +
  "which is what update_assignment changes), canvas_state (done = submitted on Canvas, missing = Canvas flags it missing, pending = neither; " +
  "null for manual items), points_possible (null if unknown), priority, source (canvas | manual) and notes.";

/** The agent-facing view of an assignment: only what's useful for answering, no internal plumbing. */
function view(a: store.Assignment) {
  return {
    id: a.id,
    title: a.title,
    course: a.course,
    type: a.type,
    due_at: a.dueAt,
    due_local: a.dueAt ? formatLocal(a.dueAt) : null,
    status: a.status,
    canvas_state: a.source === "canvas" ? (a.canvasSubmitted ? "done" : a.canvasMissing ? "missing" : "pending") : null,
    points_possible: a.pointsPossible,
    priority: a.priority,
    source: a.source,
    notes: a.notes || undefined,
  };
}

const tools = [
  betaZodTool({
    name: "list_assignments",
    description:
      `List assignments, sorted by due date. Defaults to open work (status not done). Use due_before/due_after (ISO 8601) to narrow to a window, e.g. this week. ${ASSIGNMENT_FIELDS}`,
    inputSchema: z.object({
      status: z.enum(["open", "todo", "in_progress", "done", "all"]).optional(),
      course: z.string().optional().describe("Exact course name"),
      due_before: z.string().optional(),
      due_after: z.string().optional(),
    }),
    run: async (i) =>
      json(store.listAssignments({ status: i.status, course: i.course, dueBefore: i.due_before, dueAfter: i.due_after }).map(view)),
  }),
  betaZodTool({
    name: "add_assignment",
    description:
      "Record a new assignment, exam, reading, etc. (source manual). The course is created automatically if it doesn't exist. Returns the saved assignment.",
    inputSchema: z.object({
      title: z.string(),
      course: z.string().optional(),
      type: typeEnum.optional(),
      due_at: z.string().optional().describe("ISO 8601 with UTC offset"),
      priority: priorityEnum.optional(),
      notes: z.string().optional(),
    }),
    run: async (i) =>
      json(
        view(
          store.addAssignment({
          title: i.title,
          course: i.course,
          type: i.type,
          dueAt: i.due_at,
          priority: i.priority,
          notes: i.notes,
          }),
        ),
      ),
  }),
  betaZodTool({
    name: "update_assignment",
    description:
      "Change fields on an existing assignment, including marking it in_progress or done, or reopening it (status todo), e.g. when something auto-marked done from Canvas isn't actually finished. Only pass fields that change. Canvas-owned fields (canvas_state, points_possible, source) can't be changed. Returns the updated assignment.",
    inputSchema: z.object({
      id: z.string(),
      title: z.string().optional(),
      course: z.string().optional(),
      type: typeEnum.optional(),
      due_at: z.string().nullable().optional(),
      priority: priorityEnum.optional(),
      status: statusEnum.optional(),
      notes: z.string().optional(),
    }),
    run: async ({ id, due_at, ...rest }) => {
      const patch: store.AssignmentPatch = { ...rest };
      if (due_at !== undefined) patch.dueAt = due_at;
      const updated = store.updateAssignment(id, patch);
      return updated ? json(view(updated)) : "Error: no assignment with that id";
    },
  }),
  betaZodTool({
    name: "delete_assignment",
    description: "Permanently remove an assignment (e.g. it was cancelled or added by mistake). To record completion, use update_assignment with status done instead.",
    inputSchema: z.object({ id: z.string() }),
    run: async ({ id }) => (store.deleteAssignment(id) ? "Deleted" : "Error: no assignment with that id"),
  }),
  betaZodTool({
    name: "list_calendar_events",
    description:
      "Search the student's Canvas calendar events (lectures, discussions, labs, office hours, etc.; not assignments). Defaults to the next 14 days. Times include a local-time rendering.",
    inputSchema: z.object({
      from: z.string().optional().describe("ISO 8601 start of window (default: now)"),
      to: z.string().optional().describe("ISO 8601 end of window (default: 14 days after from)"),
      query: z.string().optional().describe("Case-insensitive text to match in title, course, location or description"),
    }),
    run: async ({ from, to, query }) => {
      const start = from ? Date.parse(from) : Date.now();
      const end = to ? Date.parse(to) : start + 14 * 864e5;
      if (Number.isNaN(start) || Number.isNaN(end)) return "Error: from/to must be ISO 8601";
      const q = query?.toLowerCase();
      const events = store
        .listCalendarEvents()
        .filter((e) => {
          const t = Date.parse(e.start);
          const endT = e.end ? Date.parse(e.end) : t;
          return endT >= start && t <= end;
        })
        .filter((e) => !q || [e.title, e.course, e.location, e.description].some((f) => f?.toLowerCase().includes(q)))
        .slice(0, 100)
        .map((e) => ({ ...e, startLocal: localTime(e.start, e.allDay), endLocal: e.end ? localTime(e.end, e.allDay) : null }));
      return events.length ? json(events) : "No calendar events in that window.";
    },
  }),
  betaZodTool({
    name: "list_courses",
    description: "List the student's courses.",
    inputSchema: z.object({}),
    run: async () => json(store.listCourses()),
  }),
  betaZodTool({
    name: "add_course",
    description: "Add a course / class.",
    inputSchema: z.object({ name: z.string() }),
    run: async ({ name }) => json(store.addCourse(name)),
  }),
];

function localTime(value: string, allDay: boolean): string {
  if (allDay) return `${value} (all day)`;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

// ---- history ----

const HISTORY_MIN = 20;
const HISTORY_STEP = 10;

/**
 * The last 20-29 stored messages. The window's start only moves every 10 messages (instead of every
 * message), so the conversation prefix stays byte-identical between turns and keeps hitting the prompt cache.
 */
export function historyWindow(turns: store.ChatTurn[]): Anthropic.Beta.BetaMessageParam[] {
  const extra = Math.max(0, turns.length - HISTORY_MIN);
  const start = extra - (extra % HISTORY_STEP);
  const window: Anthropic.Beta.BetaMessageParam[] = turns
    .slice(start)
    .map((t) => ({ role: t.role, content: t.from ? `${t.from.toLowerCase()}: ${t.text}` : t.text }));
  // The API needs the first message to be from the user. Rather than dropping leading assistant
  // messages (e.g. a Canvas notice), put a fixed placeholder in front of them.
  if (window[0]?.role === "assistant") window.unshift({ role: "user", content: "(earlier messages omitted)" });
  return window;
}

// ---- who's talking, and what they may do ----

export interface Speaker {
  /** "Talking with: ..." line for the context note. */
  talkingWith: string;
  /** Only the student can change data; everyone else is a read-only viewer. */
  canEdit: boolean;
  /** "his" for the student, "their" for anyone else, used in the tapback line. */
  pronoun: "his" | "their";
}

export const STUDENT: Speaker = {
  talkingWith: `Talking with: ${config.linq.studentName} (the student).`,
  canEdit: true,
  pronoun: "his",
};

const READ_ONLY_TOOLS = new Set(["list_assignments", "list_calendar_events", "list_courses"]);
const viewerTools = tools.filter((t) => READ_ONLY_TOOLS.has(t.name));

const CHANNEL_LABEL: Record<Channel, string> = { imessage: "iMessage", web: "web dashboard" };

function contextNote(
  channel: Channel,
  speaker: Speaker,
  tapback: string | null | undefined,
  extra = "",
  group?: { roast: boolean },
): string {
  const lines = [speaker.talkingWith, `Channel: ${CHANNEL_LABEL[channel]}`];
  if (group) {
    lines.push("Chat: group chat, other people can see everything you say. You can reply SKIP to stay quiet.");
    lines.push(`Roast mode: ${group.roast ? "ON (Asher said you can roast him)" : "off (hype Asher up and defend him)"}`);
  }
  if (tapback !== undefined) lines.push(`tapback on ${speaker.pronoun} message: ${tapback ?? "none"}`);
  if (extra) lines.push(extra);
  lines.push(buildSnapshot());
  return lines.join("\n");
}

/** History + cache breakpoint on the newest user message + the context note as the final system message. */
export function buildMessages(conversationKey: string, note: string): Anthropic.Beta.BetaMessageParam[] {
  const messages = historyWindow(store.getConversation(conversationKey));
  const last = messages.at(-1)!;
  last.content = [{ type: "text", text: last.content as string, cache_control: { type: "ephemeral" } }];
  // The note goes last, as a system message, so the fixed prompt and history before it stay cached.
  messages.push({ role: "system", content: note });
  return messages;
}

/** Chat-specific tools: roast mode is per chat, and only Asher gets to flip it. */
function chatTools(conversationKey: string) {
  return [
    betaZodTool({
      name: "set_roast_mode",
      description:
        "Turn roast mode on or off for this group chat. Only when Asher himself clearly says you can roast him (on) or to stop (off).",
      inputSchema: z.object({ on: z.boolean() }),
      run: async ({ on }) => {
        store.setRoastMode(conversationKey, on);
        return `Roast mode is now ${on ? "on" : "off"} for this chat.`;
      },
    }),
  ];
}

async function callModel(messages: Anthropic.Beta.BetaMessageParam[], canEdit: boolean, extraTools: ReturnType<typeof chatTools> = []) {
  return client.beta.messages.toolRunner({
    model: config.replyModel,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: config.replyEffort },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: replySystemPrompt(), cache_control: { type: "ephemeral" } }],
    tools: canEdit ? [...tools, ...extraTools] : viewerTools,
    max_iterations: 12,
    messages,
  });
}

function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// One reply at a time per conversation, so rapid-fire texts see each other's results.
const queues = new Map<string, Promise<unknown>>();

export interface TurnOptions {
  speaker?: Speaker;
  /** The tapback already put on this message (null = none). Omit when there's no tapback step. */
  tapback?: string | null;
  /** Group chat: Beast may stay quiet, messages are labelled by sender, roast mode applies. */
  group?: { senderName: string };
}

/** Resolves to the reply, or null when Beast chose to stay quiet in a group chat. */
export function runAgent(conversationKey: string, channel: Channel, userText: string, opts: TurnOptions = {}): Promise<string | null> {
  const prev = queues.get(conversationKey) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => respond(conversationKey, channel, userText, opts));
  queues.set(conversationKey, next);
  next
    .finally(() => {
      if (queues.get(conversationKey) === next) queues.delete(conversationKey);
    })
    .catch(() => {}); // the caller handles the error; this branch only cleans up
  return next;
}

async function respond(conversationKey: string, channel: Channel, userText: string, opts: TurnOptions): Promise<string | null> {
  const speaker = opts.speaker ?? STUDENT;
  store.appendTurn(conversationKey, {
    role: "user",
    text: userText,
    ...(opts.tapback ? { emoji: opts.tapback } : {}),
    ...(opts.group ? { from: opts.group.senderName } : {}),
  });
  const group = opts.group ? { roast: store.isRoastMode(conversationKey) } : undefined;

  const final = await callModel(
    buildMessages(conversationKey, contextNote(channel, speaker, opts.tapback, dashboardLinkLine(conversationKey, !speaker.canEdit || !!group), group)),
    speaker.canEdit,
    group ? chatTools(conversationKey) : [],
  );
  if (final.stop_reason === "refusal") return group ? null : remember(conversationKey, "cant help with that one");
  const text = cleanText(textOf(final));
  // In a group chat Beast doesn't have to answer everything (friends talking to each other).
  if (group && (!text || /^skip\b/i.test(text))) return null;
  // Remember when this chat actually got the current dashboard link, so Beast doesn't keep resending it.
  const url = getDashboardUrl();
  if (url && text.includes(url)) store.recordLinkSent(conversationKey, url);
  return remember(conversationKey, text || "done ✅");
}

/**
 * "Dashboard link: https://… (current link sent: never | 2h ago)". Asher's own chats get the plain version;
 * guests and group chats get it labelled as Asher's view-only board, to share when it helps.
 */
export function dashboardLinkLine(conversationKey: string, forGuests = false, now = new Date()): string {
  const url = getDashboardUrl();
  if (!url) return "Dashboard link: not available right now";
  const sent = store.getLinkSent(conversationKey);
  let when = "never";
  if (sent && sent.url === url) {
    const mins = Math.round((now.getTime() - Date.parse(sent.at)) / 60_000);
    when = mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)} days ago`;
  }
  return forGuests
    ? `Dashboard link: ${url} (Asher's view-only board; current link sent in this chat: ${when})`
    : `Dashboard link: ${url} (current link sent: ${when})`;
}

function remember(conversationKey: string, reply: string): string {
  store.appendTurn(conversationKey, { role: "assistant", text: reply });
  return reply;
}

/**
 * Has the model write a proactive text (brief, nudge, check-in) for the student's chat.
 * Returns the cleaned text, or null if the model decided to SKIP. Nothing is stored or sent here.
 */
export async function writeProactive(conversationKey: string, instruction: string, { allowSkip = true } = {}): Promise<string | null> {
  const messages = historyWindow(store.getConversation(conversationKey));
  // A mid-conversation system message has to follow a user turn, so mark the scheduled moment as one.
  messages.push({ role: "user", content: "(scheduled: no new message from asher, this is a proactive text from beast)" });
  const skipRule = allowSkip
    ? "Reply with only the exact text to send. If there's nothing worth saying right now, or you know he's busy (gym, work, surfing), reply with just SKIP."
    : "Reply with only the exact text to send. This one always goes out, so don't reply SKIP.";
  messages.push({ role: "system", content: contextNote("imessage", STUDENT, undefined, `${instruction}\n${skipRule}`) });

  const final = await callModel(messages, false); // proactive texts never change data
  if (final.stop_reason === "refusal") return null;
  const text = cleanText(textOf(final));
  if (!text || (allowSkip && /^skip\b/i.test(text))) return null;
  return text;
}
