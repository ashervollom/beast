// Last pass on every outgoing text: iMessage doesn't render markdown, and Beast never uses dashes.

export function cleanText(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ") // em / en dash -> comma
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2") // **bold** / __bold__
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "") // # headers
        .replace(/^\s*[-*•]\s+/, ""), // - * • bullets
    )
    .join("\n")
    .replace(/,\s*,/g, ",") // ", ," left behind by "word, — word"
    .replace(/^, |(\n), /g, "$1") // a dash at the start of a line
    .trim();
}
