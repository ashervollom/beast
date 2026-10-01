// What testers actually use, and what it costs. Counts and token usage are stored per user per local day.
import { MODELS } from "./config.js";
import * as store from "./store.js";
import { localDay } from "./snapshot.js";

/** One line wherever a feature runs: track("tool:find_course_info"), track("dashboard_open"), ... */
export function track(feature: string) {
  try {
    store.bumpMetric(localDay(new Date()), feature);
  } catch (err) {
    // Metrics must never break the feature being measured.
    console.warn("[metrics] not recorded:", err instanceof Error ? err.message : err);
  }
}

// $ per million tokens. Cache writes are 1.25x input (5-minute TTL), cache reads 0.1x.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costOf(model: string, u: Usage): number {
  const p = PRICES[model] ?? PRICES[MODELS.replyStrong] ?? { input: 5, output: 25 };
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  return (u.input_tokens * p.input + write * p.input * 1.25 + read * p.input * 0.1 + u.output_tokens * p.output) / 1e6;
}

/** Records one model call against the current user. */
export function recordUsage(model: string, u: Usage | null | undefined) {
  if (!u) return;
  try {
    store.recordUsage(localDay(new Date()), {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      costUsd: costOf(model, u),
    });
  } catch (err) {
    console.warn("[metrics] usage not recorded:", err instanceof Error ? err.message : err);
  }
}

/** Sums metrics and spend for the current user over the last `days` local days. */
export function summarize(days = 7, now = new Date()) {
  const dates = new Set(Array.from({ length: days }, (_, i) => localDay(new Date(now.getTime() - i * 864e5))));
  const features: Record<string, number> = {};
  for (const [date, counts] of Object.entries(store.getMetrics())) {
    if (!dates.has(date)) continue;
    for (const [k, v] of Object.entries(counts)) features[k] = (features[k] ?? 0) + v;
  }
  let cost = 0;
  let calls = 0;
  for (const [date, day] of Object.entries(store.getUsage())) {
    if (!dates.has(date)) continue;
    cost += day.costUsd;
    calls += day.calls;
  }
  return { features, cost, calls };
}
