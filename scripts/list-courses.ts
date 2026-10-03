// Prints which Canvas courses the scan treats as current classes for a user (default: the owner).
// Usage: npx tsx scripts/list-courses.ts [userId]
import { canvasCreds } from "../src/connections.js";
import { currentCourses } from "../src/courseScan.js";
import * as global from "../src/globalStore.js";
import { withUser } from "../src/userContext.js";

const userId = process.argv[2] ?? global.owner()?.id;
if (!userId) throw new Error("no user");
await withUser(userId, async () => {
  const creds = canvasCreds();
  if (!creds) return console.log("Canvas not connected");
  for (const c of await currentCourses(creds)) console.log(`- ${c.name}`);
});
