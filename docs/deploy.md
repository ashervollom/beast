# Deploying Beast to Railway

One service, one volume, one domain. Claude does the code; you paste secrets into Railway yourself.
Never paste a secret into chat.

## 1. Service
1. Railway → New Project → Deploy from GitHub repo → `ashervollom/beast` (branch `main` once v2 is merged).
2. Service → Settings → **Volumes** → add a volume mounted at `/app/data`.
3. Service → Settings → **Networking** → Generate Domain (gives `*.up.railway.app`), then add your custom
   domain and create the DNS record Railway shows you at your registrar.
4. On Railway, Beast serves everything on one port and turns the tunnel off by itself.
5. `railway.json` already sets the start command (`npm start`) and the health check (`/healthz`).

## 2. Variables (Service → Variables)

| Name | Value | Secret? |
|---|---|---|
| `DATA_DIR` | `/app/data` | no |
| `WEB_URL` | `https://<your domain>` | no |
| `TIMEZONE` | `America/Los_Angeles` | no |
| `STUDENT_NAME` / `STUDENT_HANDLE` | owner name / owner phone (E.164) | no |
| `BEAST_NUMBER` | `+12052611117` | no |
| `LINQ_ORG_ID` | from `~/.linq/config.json` → `orgId` | no |
| `ANTHROPIC_API_KEY` | from the Anthropic console | **yes** |
| `LINQ_API_KEY` | same as your local `.env` | **yes** |
| `LINQ_WEBHOOK_SECRET` | from `.webhook-secret` (step 4) | **yes** |
| `MASTER_KEY` | 32 random bytes, base64 (Claude generates into a local file for you) | **yes** |
| `ADMIN_TOKEN` | random (same) | **yes** |
| `R2_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | no |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | from the R2 API token | **yes** |
| `R2_BUCKET` | `beast-backups` | no |

`MASTER_KEY` must be the one your data was encrypted with. Moving data from your PC means using the same key,
or re-connecting Canvas after the move.

## 3. Data
First deploy migrates `db.json` if it finds one. To move live data: stop the PC server, upload a backup bundle
(`GET /api/admin/backup` locally), restore it into the volume with `npm run restore -- <file> /app/data`
(Railway shell), then redeploy.

## 4. Linq webhook
1. With `WEB_URL` set in your local `.env`: `npm run register-webhook`. The secret lands in `.webhook-secret`.
2. Paste it into Railway as `LINQ_WEBHOOK_SECRET`, delete the file, redeploy.
3. Delete the old CLI relay subscription (`linq webhooks list`, `linq webhooks delete <id>`) and stop
   `linq webhooks listen` for good.
4. Text Beast. Railway logs should show `[imessage] <- (…)`.

Linq retries failed deliveries for ~30 minutes, and Beast dedupes by message id, so deploy restarts lose
nothing.

## 5. Backups and alerts
- Backups run 5 minutes after start and daily after that (14 kept in R2). Force one:
  `POST /api/admin/backup` with `Authorization: Bearer <ADMIN_TOKEN>`.
- Restore test before inviting anyone: `npm run restore -- latest ./restore-test` locally (with the R2
  variables in `.env`), then point `DATA_DIR` at it and start the server.
- UptimeRobot: new HTTP monitor on `https://<domain>/healthz`, every 5 minutes, email alert. It goes red when a
  background job stops succeeding or Linq has been silent for a day while people are using Beast.
- Railway → Project Settings → Notifications: turn on deploy failure and crash emails.
