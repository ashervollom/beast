// Registers this server's /webhooks/linq endpoint with Linq and prints the signing secret.
// Usage: npm run register-webhook
import { config } from "../src/config.js";
import { createWebhookSubscription } from "../src/linq.js";

if (!config.publicUrl) {
  console.error("Set PUBLIC_URL in .env (e.g. your ngrok / cloudflared https URL) first.");
  process.exit(1);
}

const target = `${config.publicUrl.replace(/\/$/, "")}/webhooks/linq`;
const sub = await createWebhookSubscription(target, ["message.received"]);
console.log(JSON.stringify(sub, null, 2));
const secret = sub?.signing_secret ?? sub?.data?.signing_secret;
if (secret) {
  console.log(`\nAdd this to .env (it can't be retrieved again):\nLINQ_WEBHOOK_SECRET=${secret}`);
}
