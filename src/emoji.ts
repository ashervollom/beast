import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { loadPrompt } from "./prompts.js";

const client = new Anthropic();

const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*/u;
/** Parses the tapback model's answer: one emoji, or null for NONE / anything unusable. */
export function parseTapback(text: string): string | null {
  if (/\bNONE\b/i.test(text)) return null;
  return text.match(EMOJI)?.[0] ?? null;
}

/** Fast, cheap model call that picks a tapback for the message, or null for no reaction (most messages). */
export async function pickEmoji(message: string): Promise<string | null> {
  try {
    const response = await client.messages.create({
      model: config.emojiModel,
      max_tokens: 16,
      system: loadPrompt("emoji"),
      messages: [{ role: "user", content: message.slice(0, 2000) }],
    });
    return parseTapback(response.content.find((b) => b.type === "text")?.text ?? "");
  } catch (err) {
    console.error("[emoji] failed:", err instanceof Error ? err.message : err);
    return null; // no reaction rather than a random one
  }
}
