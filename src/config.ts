import "dotenv/config";

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Model IDs live here and only here, so swapping one is a one-line change. */
export const MODELS = {
  /** Replies for new users (supports mid-conversation system messages, which the snapshot relies on). */
  reply: process.env.DEFAULT_REPLY_MODEL ?? "claude-sonnet-5-5",
  /** The owner's replies (and anyone switched with /model <name> opus). */
  replyStrong: process.env.REPLY_MODEL ?? "claude-opus-5",
  /** Tapbacks, name extraction, importance: small and fast. */
  fast: process.env.EMOJI_MODEL ?? "claude-haiku-4-5",
  /** Course scan fact extraction. */
  extract: process.env.EXTRACT_MODEL ?? "claude-sonnet-5-5",
};

/** Running on Railway (or any host that sets CLOUD=1): one port, no tunnel, no localhost shortcuts. */
const CLOUD = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.CLOUD === "1");

export const config = {
  port: Number(process.env.PORT ?? 3000),
  cloud: CLOUD,
  // Public pages (dashboards, invite and connect pages). Bound to localhost; shared through the tunnel or the host.
  viewerPort: CLOUD || process.env.VIEWER_PORT === "" ? null : Number(process.env.VIEWER_PORT ?? 3001),
  // Cloudflare quick tunnel to the public pages. "off" to disable (always off in the cloud).
  tunnel: {
    enabled: !CLOUD && (process.env.TUNNEL ?? "on").toLowerCase() !== "off",
    command: process.env.CLOUDFLARED_PATH || "cloudflared",
  },
  publicUrl: process.env.PUBLIC_URL ?? "",
  /** Base URL for links Beast texts (dashboards, invites, connect pages). Falls back to the tunnel. */
  webUrl: (process.env.WEB_URL ?? "").replace(/\/$/, ""),
  /** Beast's own iMessage number, for the invite page's "Text Beast" button. */
  beastNumber: process.env.BEAST_NUMBER ?? "",
  timezone: process.env.TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  dataDir: process.env.DATA_DIR ?? "data",

  replyEffort: (process.env.REPLY_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max",

  /** Encrypts stored connection secrets (Canvas tokens, feed URLs). 32 random bytes, base64. */
  masterKey: process.env.MASTER_KEY ?? "",
  /** Bearer token for /api/admin/*. */
  adminToken: process.env.ADMIN_TOKEN ?? "",

  linq: {
    apiKey: process.env.LINQ_API_KEY ?? "",
    baseUrl: process.env.LINQ_BASE_URL ?? "https://api.linqapp.com/api/partner/v3",
    webhookSecret: process.env.LINQ_WEBHOOK_SECRET ?? "",
    /** Linq organization id (not a secret), for adding Shared Line contacts. From ~/.linq/config.json. */
    orgId: process.env.LINQ_ORG_ID ?? "",
    /** Testing: log outgoing texts instead of sending them (no Linq calls at all). */
    dryRun: process.env.LINQ_DRY_RUN === "1",
    // The owner: the first user, with admin commands. Used to migrate the single-user database.
    ownerName: process.env.STUDENT_NAME || "Owner",
    ownerHandle: process.env.STUDENT_HANDLE ?? "",
    // "number=name" pairs for people Beast should recognise by name in group chats.
    handleLabels: Object.fromEntries(
      list(process.env.HANDLE_LABELS)
        .map((pair) => pair.split("=").map((s) => s.trim()))
        .filter(([handle, label]) => handle && label),
    ) as Record<string, string>,
  },

  // The owner's Canvas from before connections existed. Moved into the owner's encrypted connections once.
  legacyCanvas: {
    icsUrl: process.env.CANVAS_ICS_URL ?? "",
    baseUrl: process.env.CANVAS_BASE_URL ?? "",
    token: process.env.CANVAS_TOKEN ?? "",
  },
  /** Canvas host offered to new users at the default school. */
  defaultCanvasBaseUrl: process.env.DEFAULT_CANVAS_BASE_URL ?? "https://canvas.eee.uci.edu",

  // Off-site backups (Cloudflare R2, S3-compatible). All four set = daily backups on.
  backups: {
    endpoint: process.env.R2_ENDPOINT ?? "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    bucket: process.env.R2_BUCKET ?? "beast-backups",
  },

  limits: {
    dailyMessages: Number(process.env.USER_DAILY_MESSAGES ?? 50),
    maxMessageChars: 2000,
    invitesPerUser: Number(process.env.INVITES_PER_USER ?? 1),
  },

  // Proactive texts (local time, 24h "HH:MM").
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
