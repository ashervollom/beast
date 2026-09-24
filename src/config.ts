import "dotenv/config";

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Read-only dashboard for sharing (e.g. through a tunnel). Localhost only; empty = off.
  viewerPort: process.env.VIEWER_PORT === "" ? null : Number(process.env.VIEWER_PORT ?? 3001),
  // Cloudflare quick tunnel to the read-only dashboard, so Beast can text Asher a link. "off" to disable.
  tunnel: {
    enabled: (process.env.TUNNEL ?? "on").toLowerCase() !== "off",
    command: process.env.CLOUDFLARED_PATH || "cloudflared",
  },
  publicUrl: process.env.PUBLIC_URL ?? "",
  timezone: process.env.TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  dataFile: process.env.DATA_FILE ?? "data/db.json",

  // Models: a fast, cheap one for the instant emoji tapback, a strong one for the actual reply.
  emojiModel: process.env.EMOJI_MODEL ?? "claude-haiku-4-5",
  replyModel: process.env.REPLY_MODEL ?? "claude-opus-5",
  replyEffort: (process.env.REPLY_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max",

  linq: {
    apiKey: process.env.LINQ_API_KEY ?? "",
    baseUrl: process.env.LINQ_BASE_URL ?? "https://api.linqapp.com/api/partner/v3",
    webhookSecret: process.env.LINQ_WEBHOOK_SECRET ?? "",
    // Only these phone numbers / emails may talk to the assistant. Empty = anyone (not recommended).
    allowedHandles: list(process.env.ALLOWED_HANDLES),
    // The student this assistant belongs to.
    studentName: process.env.STUDENT_NAME || "the student",
    studentHandle: process.env.STUDENT_HANDLE ?? "",
    // "number=name" pairs for other people the assistant should recognise (e.g. "+15555550199=Royce").
    handleLabels: Object.fromEntries(
      list(process.env.HANDLE_LABELS)
        .map((pair) => pair.split("=").map((s) => s.trim()))
        .filter(([handle, label]) => handle && label),
    ) as Record<string, string>,
  },

  // Canvas calendar feed (Canvas -> Calendar -> Calendar Feed). Treat it like a password.
  canvasIcsUrl: process.env.CANVAS_ICS_URL ?? "",
  // Canvas REST API (read-only use). The token is a secret: never log it.
  canvasBaseUrl: process.env.CANVAS_BASE_URL ?? "",
  canvasToken: process.env.CANVAS_TOKEN ?? "",

  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? "",

  // Proactive texts to the student (local time, 24h "HH:MM").
  proactive: {
    briefTime: process.env.BRIEF_TIME ?? "06:30", // every day, like clockwork; not counted in the cap
    nightTime: process.env.NIGHT_TIME ?? "21:00",
    quietStart: process.env.QUIET_START ?? "23:00",
    quietEnd: process.env.QUIET_END ?? "08:00",
    dailyCap: Number(process.env.PROACTIVE_DAILY_CAP ?? 4),
    nudgeHours: Number(process.env.NUDGE_HOURS ?? 12), // first deadline nudge when due within this many hours
    finalNudgeHours: Number(process.env.FINAL_NUDGE_HOURS ?? 4), // last warning if still not started
  },
};
