// Runs the course scan for one user and prints a summary (counts and link kinds, no secrets).
// Usage: npx tsx scripts/scan-once.ts [userId] [--force] [--only <course text>]
import { scanCourses } from "../src/courseScan.js";
import * as global from "../src/globalStore.js";
import * as store from "../src/store.js";
import { withUser } from "../src/userContext.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const userId = args.find((a) => !a.startsWith("--") && a !== only) ?? global.owner()?.id;
if (!userId) throw new Error("no user");

await withUser(userId, async () => {
  const results = await scanCourses({ force, only });
  console.log(JSON.stringify(results, null, 2));
  for (const p of Object.values(store.getCourseProfiles())) {
    const kinds = p.links.reduce<Record<string, number>>((m, l) => ((m[l.kind] = (m[l.kind] ?? 0) + 1), m), {});
    console.log(`\n== ${p.course} (${p.dept} ${p.number}, section ${p.sectionCode}) ${p.title ?? ""}`);
    console.log(`meetings: ${p.meetings.map((m) => `${m.kind} ${m.section} ${m.days} ${m.start}-${m.end} @ ${m.location}`).join(" | ") || "none"}`);
    console.log(`final: ${p.final ? `${p.final.date} ${p.final.start}-${p.final.end} @ ${p.final.location}` : "none"}`);
    console.log(`website: ${p.website ?? "none"} | links: ${JSON.stringify(kinds)}`);
    console.log(`sources: ${p.sources.join(", ")}`);
    console.log(`gaps: ${p.gaps.join("; ") || "none"}`);
    console.log(`section choice: ${p.sectionChoice ? p.sectionChoice.options.map((o) => o.label).join(" / ") : "none"}`);
    const f = p.facts;
    if (f) {
      console.log(`summary: ${f.summary}`);
      console.log(`office hours: ${f.officeHours.map((o) => `${o.who}: ${o.when} @ ${o.where}`).join(" | ") || "none"}`);
      console.log(`grading: ${f.grading.map((g) => `${g.item} ${g.weight}`).join(", ") || "none"}`);
      console.log(`exams: ${f.exams.map((e) => `${e.title} ${e.date ?? "?"} (${e.confidence})`).join(" | ") || "none"}`);
      console.log(`key dates: ${f.keyDates.map((k) => `${k.title} ${k.date}`).join(" | ") || "none"}`);
    }
  }
  const scanned = store.listAssignments({ status: "all" }).filter((a) => a.scanKey);
  console.log(`\nboard items from the scan: ${scanned.map((a) => `${a.title} (${a.dueAt?.slice(0, 10) ?? "no date"}${a.tentative ? ", tentative" : ""})`).join(" | ") || "none"}`);
});
