import type { Signal } from "./types.js"

// ──────────────────────────────────────────────────
// Tokenizer
// ──────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "is",
  "it",
  "this",
  "that",
  "be",
  "as",
  "are",
  "was",
  "were",
  "from",
  "has",
  "had",
  "have",
  "not",
  "no",
])

/**
 * Tokenize text into a set of meaningful lowercase words.
 * Strips punctuation, filters stop words and short tokens.
 */
export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))

  return new Set(words)
}

// ──────────────────────────────────────────────────
// Cross-signal correlation
// ──────────────────────────────────────────────────

/**
 * Cross-correlate signals from different sources to detect patterns.
 *
 * Currently implements:
 * - Calendar + Email overlap detection (meeting prep signals)
 *
 * Returns new cross_signal entries. Does not modify input signals.
 */
export function correlateSignals(signals: Signal[], minOverlap = 2): Signal[] {
  const out: Signal[] = []

  const calendar = signals.filter((s) => s.source === "calendar")
  const email = signals.filter((s) => s.source === "email")
  const portfolio = signals.filter((s) => s.source === "portfolio")
  const behavioral = signals.filter((s) => s.source === "behavioral")

  // Calendar + Email correlation
  for (const c of calendar) {
    const cTokens = tokenize(c.title + " " + c.summary)
    if (cTokens.size === 0) continue

    for (const e of email) {
      const eTokens = tokenize(e.title + " " + e.summary)
      const overlap = new Set([...cTokens].filter((t) => eTokens.has(t)))

      if (overlap.size >= minOverlap) {
        const conf = Math.round(Math.min(0.93, 0.68 + 0.04 * overlap.size) * 100) / 100
        const overlapTerms = [...overlap].sort().slice(0, 5)
        out.push({
          source: "cross_signal",
          signalType: "calendar_email_correlation",
          title: "Meeting prep likely needed from email context",
          summary: `Calendar + email overlap: ${overlapTerms.join(", ")}`,
          confidence: conf,
          severity: conf >= 0.8 ? "high" : "medium",
          opportunity: false,
          fingerprint: `cal_email:${overlapTerms.join(":")}`,
          detectedAt: new Date().toISOString(),
        })
      }
    }
  }

  // Portfolio + Behavioral correlation (e.g., portfolio alert + recent activity pattern)
  for (const p of portfolio) {
    const pTokens = tokenize(p.title + " " + p.summary)
    if (pTokens.size === 0) continue

    for (const b of behavioral) {
      const bTokens = tokenize(b.title + " " + b.summary)
      const overlap = new Set([...pTokens].filter((t) => bTokens.has(t)))

      if (overlap.size >= minOverlap) {
        const conf = Math.round(Math.min(0.9, 0.6 + 0.05 * overlap.size) * 100) / 100
        const overlapTerms = [...overlap].sort().slice(0, 5)
        out.push({
          source: "cross_signal",
          signalType: "portfolio_behavior_correlation",
          title: "Portfolio signal aligns with behavioral pattern",
          summary: `Portfolio + behavioral overlap: ${overlapTerms.join(", ")}`,
          confidence: conf,
          severity: conf >= 0.8 ? "high" : "medium",
          opportunity: true,
          fingerprint: `port_behav:${overlapTerms.join(":")}`,
          detectedAt: new Date().toISOString(),
        })
      }
    }
  }

  return out
}
