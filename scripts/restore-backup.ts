// Restores a backup into a data directory. Never overwrites a non-empty directory.
// Usage: npx tsx scripts/restore-backup.ts <latest | YYYY-MM-DD | path/to/file.json.gz> <target dir>
import fs from "node:fs";
import { fetchBackup, unpackBundle, writeBundle } from "../src/backups.js";

const [which = "latest", target] = process.argv.slice(2);
if (!target) {
  console.error("usage: restore-backup.ts <latest | YYYY-MM-DD | file.json.gz> <target dir>");
  process.exit(1);
}
if (fs.existsSync(target) && fs.readdirSync(target).length) {
  console.error(`${target} isn't empty; restore into a fresh directory, then swap it in.`);
  process.exit(1);
}
const bundle = fs.existsSync(which) ? unpackBundle(fs.readFileSync(which)) : await fetchBackup(which);
writeBundle(bundle, target);
console.log(`restored backup from ${bundle.createdAt}: ${Object.keys(bundle.users).length} users -> ${target}`);
