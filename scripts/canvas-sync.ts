// Triggers a Canvas sync for one user on the running server (so only one process writes the data files).
// Usage: npm run canvas:sync                       -> the owner, .ics import + planner enrichment
//        npm run canvas:sync -- planner            -> the owner, planner only ("ics" also works)
//        npm run canvas:sync -- all <userId>       -> someone else
import { config } from "../src/config.js";

const what = process.argv[2] ?? "all";
const headers: Record<string, string> = { "Content-Type": "application/json" };
if (config.adminToken) headers.Authorization = `Bearer ${config.adminToken}`;
const base = `http://localhost:${config.port}/api/admin`;

try {
  let userId = process.argv[3];
  if (!userId) {
    const users = (await (await fetch(`${base}/users`, { headers })).json()) as { id: string; role: string }[];
    userId = users.find((u) => u.role === "owner")?.id ?? "";
  }
  const res = await fetch(`${base}/users/${userId}/canvas/sync`, { method: "POST", headers, body: JSON.stringify({ what }) });
  console.log(res.status, JSON.stringify(await res.json(), null, 2));
} catch {
  console.error(`Couldn't reach the server on port ${config.port}. Start it first with: npm run dev`);
  process.exit(1);
}
