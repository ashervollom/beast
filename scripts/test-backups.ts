// Backup round trip without R2: bundle -> gzip -> strip a deleted user -> restore -> data still loads.
// Run: DATA_DIR=data-test npx tsx scripts/test-backups.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { packBundle, snapshotBundle, stripUser, unpackBundle, writeBundle } from "../src/backups.js";
import { config } from "../src/config.js";
import * as global from "../src/globalStore.js";
import * as store from "../src/store.js";
import { withUser } from "../src/userContext.js";

assert.ok(config.dataDir.includes("test"), "point DATA_DIR at a throwaway test directory");
fs.rmSync(config.dataDir, { recursive: true, force: true });

const keep = global.createUser({ handle: "+15550000011", name: "Keep", status: "active" });
const gone = global.createUser({ handle: "+15550000022", name: "Gone", status: "active" });
withUser(keep.id, () => store.addAssignment({ title: "keep me" }));
withUser(gone.id, () => store.addAssignment({ title: "delete me" }));
global.setGroupOwner("grp", gone.id);
global.addFeedback(gone.id, "bye", "command");

const bundle = unpackBundle(packBundle(snapshotBundle()));
assert.equal(Object.keys(bundle.users).length, 2);

assert.ok(stripUser(bundle, gone.id));
const text = JSON.stringify(bundle);
assert.ok(!text.includes(gone.id), "no trace of the deleted user's id");
assert.ok(!text.includes("delete me") && !text.includes("+15550000022"));
assert.ok(text.includes("keep me"));

const restored = `${config.dataDir}-restored`;
fs.rmSync(restored, { recursive: true, force: true });
writeBundle(bundle, restored);
const g = JSON.parse(fs.readFileSync(path.join(restored, "global.json"), "utf8"));
assert.deepEqual(Object.keys(g.users), [keep.id]);
assert.equal(JSON.parse(fs.readFileSync(path.join(restored, "users", `${keep.id}.json`), "utf8")).assignments[0].title, "keep me");

fs.rmSync(config.dataDir, { recursive: true, force: true });
fs.rmSync(restored, { recursive: true, force: true });
console.log("backup tests passed");
