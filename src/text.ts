// HTML to plain text and link extraction, good enough for syllabi and course sites.
import { createHash } from "node:crypto";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    // Tables keep their shape (schedules and quiz dates usually live in tables): cells " | ", rows on lines.
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e.toLowerCase()] ?? (e.startsWith("#") ? String.fromCharCode(Number(e.slice(1))) : m))
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface Link {
  url: string;
  text: string;
}

/** Absolute http(s) links in an HTML document, with their link text. */
export function extractLinks(html: string, base: string): Link[] {
  const out: Link[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(m[1].replace(/&amp;/g, "&"), base);
      if (!/^https?:$/.test(url.protocol)) continue;
      url.hash = "";
      out.push({ url: url.toString(), text: htmlToText(m[2]).slice(0, 120) });
    } catch {
      // not a URL
    }
  }
  return out;
}

export const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
