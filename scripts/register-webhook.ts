// Registers <WEB_URL or PUBLIC_URL>/webhooks/linq with Linq. The signing secret is written to
// .webhook-secret (gitignored), never printed, so it doesn't end up in logs or chat.
// Usage: npm run register-webhook
import fs from "node:fs";
import { config } from "../src/config.js";
import { createWebhookSubscription } from "../src/linq.js";

const base = (config.webUrl || config.publicUrl).replace(/\/$/, "");
if (!base) {
  console.error("Set WEB_URL (the Railway domain) in .env first.");
  process.exit(1);
}

const target = `${base}/webhooks/linq`;
const sub = await createWebhookSubscription(target, ["message.received"]);
const secret = sub?.signing_secret ?? sub?.data?.signing_secret;
const id = sub?.id ?? sub?.data?.id;
console.log(`Registered ${target} (subscription ${id ?? "?"}).`);
if (secret) {
  fs.writeFileSync(".webhook-secret", `${secret}\n`, { mode: 0o600 });
  console.log("Signing secret saved to .webhook-secret. Paste it into Railway as LINQ_WEBHOOK_SECRET, then delete the file.");
}
