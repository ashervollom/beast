# School Assistant

A conversational assistant that keeps track of your school work. You text it over iMessage (through [Linq](https://linqapp.com)), and there's a web dashboard for when you want the full view.

## How a message is handled

```
iMessage ──► Linq ──► POST /webhooks/linq ─┬─► Haiku 4.5 ─► emoji ─► tapback on your message   (~1s)
                                           └─► Opus 5 + tools ─► read/update assignments ─► reply  (a few s)
```

- Both models start at the same moment. The small model returns almost immediately, so the emoji tapback (📐 for a math question, 📅 for "when is…") shows up while the typing bubble is still going.
- The reply model has tools to list, add, update, complete and delete assignments and courses. It resolves dates like "friday" against your timezone.
- The web dashboard uses the same agent, the same data and the same emoji-then-reply flow.

## Setup

1. **Install:** `npm install`
2. **Configure:** fill in `.env` (the template is `.env.example`):
   - `ANTHROPIC_API_KEY`
   - `LINQ_API_KEY`: from the Linq dashboard, under API → Overview → Generate new token
   - `STUDENT_NAME` / `STUDENT_HANDLE`: whose assistant this is. Only this number can change data; everyone else is a read-only viewer.
   - `HANDLE_LABELS`: other people Beast should know by name (`+15555550199=Royce`). `ALLOWED_HANDLES` empty = anyone can text.
   - `TIMEZONE`, and optionally `DASHBOARD_PASSWORD` and the proactive-text settings (`BRIEF_TIME`, quiet hours, cap)
   - `CANVAS_ICS_URL` (optional): Canvas → Calendar → "Calendar Feed" link. Keep it private.
   - `CANVAS_BASE_URL` + `CANVAS_TOKEN` (optional): Canvas → Account → Settings → New Access Token. Used read-only.
3. **Expose the server publicly** so Linq can reach it, for example:
   ```bash
   npx cloudflared tunnel --url http://localhost:3000
   ```
   Put the https URL it prints into `PUBLIC_URL`.
4. **Register the webhook** (only needed once):
   ```bash
   npm run register-webhook
   ```
   Copy the `LINQ_WEBHOOK_SECRET=…` line it prints into `.env`. Linq shows this secret only once.
5. **Run:**
   ```bash
   npm run dev
   ```
   Text your Linq number. The dashboard is at http://localhost:3000.

## Project layout

| File | Purpose |
|---|---|
| `src/server.ts` | Express app: webhook, read-only dashboard API, the shareable viewer port |
| `src/imessage.ts` | Webhook handler: tapback model first, then the reply model (told which tapback went on) |
| `src/emoji.ts` | Haiku 4.5 tapback picker |
| `src/agent.ts` | Opus 5 agent with the assignment tools (SDK tool runner) |
| `src/linq.ts` | Linq API client and webhook signature verification |
| `src/store.ts` | JSON-file storage (`data/db.json`) |
| `src/canvas.ts`, `src/ics.ts` | One-way Canvas calendar import (on start + hourly) |
| `src/canvasPlanner.ts`, `src/canvasApi.ts` | Read-only Canvas API enrichment (on start + every 20 min) |
| `src/proactive.ts` | Morning brief, deadline warnings, nightly check-in, Canvas notices (quiet hours, cap, no stale texts) |
| `src/sanitize.ts` | Strips dashes and markdown from every outgoing text |
| `src/guests.ts` | Guest onboarding, daily limit, /guests /remove /unblock |
| `src/tunnel.ts` | Runs the Cloudflare tunnel to the view-only dashboard and tracks its link |
| `public/` | View-only dashboard: a Notion-style status board (plain HTML, CSS and JS) |
| `prompts/` | All model prompts as Markdown (see below) |

## Canvas import

The server reads your Canvas calendar feed when it starts, then every hour.

- **Assignments** are created once, the first time each one appears in the feed. After that they're never updated or deleted by the sync, so your edits (and deletions) stick. The first sync skips anything already past due.
- **Course names** like "Stats 110/201 Fall 2026" are matched to your existing courses (ignoring the term). If there's no match, a new course is created. The match is remembered.
- **Other calendar events** (lectures, office hours, ...) don't appear on the dashboard. The agent can look them up, so you can ask "when's my stats lecture?". They're refreshed from the feed on every sync.
- **Notifications:** when a sync finds new assignments, you get one iMessage listing them. It goes to the chat you last texted the assistant from.

### Canvas API enrichment

With `CANVAS_TOKEN` set, the server reads `/api/v1/planner/items` (2 weeks back to 4 weeks ahead) on start and every 20 minutes. It only ever sends GET requests. Planner items are matched to imported assignments by Canvas assignment ID; items with no match are ignored.

- Shows points and a red **Missing** badge. The Canvas badge links to the real assignment page.
- When Canvas first shows a submission, the assignment is marked done and you get one text ("saw you turned in X, marked it done ✅"). Multiple submissions are batched into one text. If you reopen an assignment by hand, the sync won't close it again.
- Canvas errors and rate limits are logged and shown on the dashboard's sync status. You don't get texted about them. The token is never logged.

**Manual sync** (with the server running):
```bash
npm run canvas:sync
```
Add `-- planner` or `-- ics` to run just one part, e.g. `npm run canvas:sync -- planner`.

## Editing the prompts

Everything the models are told lives in `prompts/`, re-read on every message (no restart):

- `persona.md`, `voice.md`, `rules.md`, `you.md`, `examples.md`: who Beast is, how it texts, how it does the job, about Asher, example exchanges
- `mechanics.md`: technical rules (tools, dates, viewers, what the context lines mean)
- `emoji.md`: the tapback model. It answers one emoji or `NONE`.

The reply model gets them in that order. `<!-- comments -->` and unfilled `[fill in]` placeholders are skipped.

## Proactive texts

Only ever sent to the student's own 1:1 chat (never a group chat).

| Text | When | Counts toward the daily cap |
|---|---|---|
| Morning brief | `BRIEF_TIME` (6:30) every day, even in quiet hours; skipped if the server was off until 2h later | No |
| Deadline warnings | Due within `NUDGE_HOURS` (12) and not done, once per assignment per day; final one `FINAL_NUDGE_HOURS` (4) before if still `todo`. Always sent (outside quiet hours), even over the cap or unanswered | Yes |
| Nightly check-in | `NIGHT_TIME` (21:00), only if something's due soon or work got done today; Beast can skip it | Yes |
| Canvas notices | When a sync finds them; held for the next brief during quiet hours, over the cap, or while the last text is unanswered | Yes |

After downtime there's at most one catch-up text, and only if something is urgent. Every proactive text is saved to the chat history. `POST /api/proactive/preview` shows what the brief would say without sending it.

## Dashboard link (view only)

The dashboard is a view-only status board (Not started, In progress, Complete) with Due, Overdue and Completed-this-week counts; all changes happen by texting Beast. Titles link to the assignment in Canvas and attachments are clickable. Port 3000 and `VIEWER_PORT` (3001) show the same page; 3001 is the shareable one: no webhook, no model calls, and it only listens on localhost.

With `TUNNEL=on` (the default) the server also starts a free Cloudflare quick tunnel to port 3001 and Beast texts you the link:
- when you ask ("send me the dashboard"),
- when it adds or changes something and you haven't had the current link yet,
- when it's been 3+ days and something changed or the dashboard came up.

Only ever in your own chat, never in a group chat or to anyone else. The link changes every time the server starts; Beast knows when it's new.

One-time setup: install Cloudflare's tunnel tool
```bash
winget install --id Cloudflare.cloudflared
```
Then just run `npm start` and the Linq listener as usual. Keep the PC awake (Settings → System → Power: sleep "Never" while plugged in). Both pages refresh every 5 seconds.

## Guests

Anyone other than you who texts Beast is a guest. Guests can ask about your schoolwork but can't change anything (read-only tools, enforced in code).

- **1:1:** a new number gets "yo, i'm beast, asher's school assistant. who's this?" (no model call). Their reply's first name is picked out by the fast model, then Beast says "sweet, ask me what asher's got due this week." and texts you "<name> (<phone>) just started texting me."
- **Group chats:** a new number gets "wait who's (631) 413-1265?". Whoever answers, them or anyone else ("thats oli"), Beast replies "got it, oli 🤝".
- **Limits:** 50 messages per guest per day, then one "im tapped out for today" and silence until midnight.
- **Commands** (from your own 1:1 chat): `/guests` lists everyone, `/remove <name or number>` blocks someone silently, `/unblock <name or number>` undoes it.
- People in `HANDLE_LABELS` (like Royce) start out as named guests with no intro.
- Linq's free Shared Line only delivers texts from its contacts (max 20), so add new people with `linq contacts add +1…` first.

## Notes

- **Models:** `EMOJI_MODEL` and `REPLY_MODEL` in `.env`. `REPLY_EFFORT=medium` keeps texts quick. Set it to `high` if you want deeper study planning.
- **Refusal fallback:** replies use Anthropic's server-side refusal fallback (`fallbacks: "default"`), so a request declined by a safety classifier is retried on a fallback model instead of failing.
- **Security:** set `LINQ_WEBHOOK_SECRET` so forged webhooks are rejected. With `ALLOWED_HANDLES` empty, anyone who texts the number can read (not change) your schoolwork and uses your API credits. Set `DASHBOARD_PASSWORD` if the tunnel URL is public, because it exposes the dashboard too.
