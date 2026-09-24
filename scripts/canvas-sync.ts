// Triggers a Canvas sync on the running server (so only one process writes the data file).
// Usage: npm run canvas:sync             -> .ics import + planner enrichment
//        npm run canvas:sync -- planner  -> planner only ("ics" also works)
import { config } from "../src/config.js";

const what = process.argv[2] ?? "all";
const headers: Record<string, string> = { "Content-Type": "application/json" };
if (config.dashboardPassword) {
  headers.Authorization = `Basic ${Buffer.from(`sync:${config.dashboardPassword}`).toString("base64")}`;
}

try {
  const res = await fetch(`http://localhost:${config.port}/api/canvas/sync`, {
    method: "POST",
    headers,
    body: JSON.stringify({ what }),
  });
  console.log(res.status, JSON.stringify(await res.json(), null, 2));
} catch {
  console.error(`Couldn't reach the server on port ${config.port}. Start it first with: npm run dev`);
  process.exit(1);
}
