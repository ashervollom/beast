// Debug helper: shows how a saved HTML page reads after htmlToText, around a search word.
// Usage: npx tsx scripts/peek-text.ts <file.html> <word>
import fs from "node:fs";
import { htmlToText } from "../src/text.js";

const [file, word = "Quiz"] = process.argv.slice(2);
const text = htmlToText(fs.readFileSync(file, "utf8"));
const at = text.indexOf(word);
console.log(`${text.length} chars; "${word}" at ${at}`);
console.log(text.slice(Math.max(0, at), at + 900));
