// Safety checks for per-user data. Run: DATA_DIR=<temp dir> npx tsx scripts/test-isolation.ts
// 1. Touching user data without a user context throws.
// 2. User A never sees user B's data.
// 3. 50 overlapping writes from "pollers", "webhooks" and "cron" lose nothing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import * as global from "../src/globalStore.js";
import * as store from "../src/store.js";
import { withUser } from "../src/userContext.js";

assert.ok(config.dataDir.includes("test"), "point DATA_DIR at a throwaway test directory");
fs.rmSync(config.dataDir, { recursive: true, force: true });

// 1
assert.throws(() => store.listAssignments(), /without a user context/);

// 2
const a = global.createUser({ handle: "+15550000001", name: "A", status: "active" });
const b = global.createUser({ handle: "+15550000002", name: "B", status: "active" });
withUser(a.id, () => store.addAssignment({ title: "A's secret essay" }));
withUser(b.id, () => assert.equal(store.listAssignments({ status: "all" }).length, 0));
assert.equal(withUser(a.id, () => store.listAssignments({ status: "all" })).length, 1);

// 3: interleave async "jobs" that each await between operations.
const sleep = () => new Promise((r) => setTimeout(r, Math.random() * 5));
await Promise.all(
  Array.from({ length: 50 }, (_, i) =>
    withUser(i % 2 ? a.id : b.id, async () => {
      await sleep();
      store.addAssignment({ title: `job ${i}` });
      await sleep();
      store.appendTurn("imessage:x", { role: "user", text: `msg ${i}` });
      await sleep();
      store.bumpMetric("2026-01-01", "test");
    }),
  ),
);
// Read back from disk, not memory.
const onDisk = (id: string) => JSON.parse(fs.readFileSync(path.join(config.dataDir, "users", `${id}.json`), "utf8"));
const da = onDisk(a.id);
const db = onDisk(b.id);
assert.equal(da.assignments.length, 1 + 25);
assert.equal(db.assignments.length, 25);
assert.equal(da.metrics["2026-01-01"].test + db.metrics["2026-01-01"].test, 50);
assert.ok(!JSON.stringify(db).includes("A's secret essay"));

fs.rmSync(config.dataDir, { recursive: true, force: true });
console.log("isolation tests passed");
