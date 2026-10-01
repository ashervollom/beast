// Creates or updates Beast's iMessage contact card (the name and photo people see).
// Usage: npm run contact-card -- +1XXXXXXXXXX            (Beast's Linq number)
// The photo is public/beast.jpg, served from PUBLIC_URL (or set CARD_IMAGE_URL).
import { config } from "../src/config.js";
import { getContactCard, setContactCard } from "../src/linq.js";

const phone = process.argv[2];
if (!phone?.startsWith("+")) {
  console.error("Pass Beast's Linq number in E.164 form, e.g. npm run contact-card -- +15555550123");
  process.exit(1);
}
const image = process.env.CARD_IMAGE_URL || `${config.publicUrl}/beast.jpg`;
const check = await fetch(image);
if (!check.ok || !check.headers.get("content-type")?.startsWith("image/")) {
  console.error(`The photo isn't reachable at ${image} (${check.status} ${check.headers.get("content-type")}). Deploy it first.`);
  process.exit(1);
}
console.log(JSON.stringify(await setContactCard(phone, "Beast", image), null, 2));
console.log(JSON.stringify(await getContactCard(), null, 2));
