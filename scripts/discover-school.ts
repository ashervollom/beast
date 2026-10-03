// Runs school discovery for one school and prints what Beast learned.
// Usage: npx tsx scripts/discover-school.ts "UC Berkeley" [canvas host]
import { discoverSchool } from "../src/schoolDiscovery.js";

const [name, canvasHost] = process.argv.slice(2);
if (!name) throw new Error('usage: discover-school.ts "<school name>" [canvas host]');
const started = Date.now();
const profile = await discoverSchool(name, { canvasHost: canvasHost ?? null });
console.log(JSON.stringify(profile, null, 2));
console.log(`took ${Math.round((Date.now() - started) / 1000)}s`);
