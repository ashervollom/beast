import * as linq from "./linq.js";
import { cleanText } from "./sanitize.js";
import * as store from "./store.js";

/**
 * Sends a system-initiated text (brief, nudge, notice, error apology) and saves it in that chat's
 * conversation history, so the agent sees it like any other message it sent. Throws if sending fails.
 */
export async function sendToChat(chatId: string, text: string) {
  const clean = cleanText(text);
  await linq.sendText(chatId, clean);
  store.appendTurn(`imessage:${chatId}`, { role: "assistant", text: clean });
}
