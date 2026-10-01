// Prompts live as Markdown in /prompts so they can be edited without touching code.
// Files are re-read on every message, so edits apply immediately (no restart).
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve("prompts");

/**
 * The reply model's system prompt, in this order. It's the same for every user (and cached); what Beast
 * knows about the person it's talking to goes in the per-message context note instead.
 */
const REPLY_PROMPT_FILES = ["persona", "voice", "rules", "crew", "examples", "mechanics", "owner"];
const OPTIONAL = new Set(["examples", "owner"]);

/**
 * Reads prompts/<name>.md. HTML comments are stripped, and unfilled template placeholders like
 * "[fill in]" are removed (a "- Label: [fill in]" line disappears entirely until it's filled in).
 */
export function loadPrompt(name: string, { optional = false } = {}): string {
  const file = path.join(DIR, `${name}.md`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (optional) return "";
    throw new Error(`Missing prompt file ${file}`, { cause: err });
  }
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s*\[(?:fill in|add)[^\]]*\]/gi, "")
    .split("\n")
    .filter((line) => !/^\s*-\s*[^:]+:\s*$/.test(line)) // "- Goals this term:" with nothing left
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function replySystemPrompt(): string {
  return REPLY_PROMPT_FILES.map((name) => loadPrompt(name, { optional: OPTIONAL.has(name) }))
    .filter(Boolean)
    .join("\n\n");
}
