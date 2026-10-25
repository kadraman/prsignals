import { LEVEL_BASE } from "./signals.ts";
import type { ConfidenceBreakdown, EvidenceStatus, Signal } from "./signals.ts";
import { resolvePath } from "./difflines.ts";
import type { FileLines, LineMap } from "./difflines.ts";

/** Every constant that influences confidence lives here. Tune these using the calibration report. */
export const SCORING = {
  base: LEVEL_BASE,
  anchor: { added: 0.10, context: 0.05, none: -0.15 },
  evidence: { found: 0.10, partial: 0.0, not_found: -0.25, missing: -0.10 },
  agreement: { all: 0.10, partial: 0.0, single: -0.10 },
} as const;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
/** The prompt shows lines as "   42 +code"; models sometimes copy that prefix into `evidence`. */
const stripAnnotation = (line: string) => line.replace(/^\s*\d+\s[+ ]/, "");
const stripMarker = (line: string) => line.replace(/^[+-]\s?/, "");

/** Deterministically check that the quoted evidence really appears at (or within 2 lines of) the cited lines. */
export function verifyEvidence(signal: Signal, lines: FileLines | undefined): EvidenceStatus {
  const raw = signal.evidence?.trim();
  if (!raw) return "missing";
  if (!lines) return "not_found";
  const window: string[] = [];
  for (let n = signal.line - 2; n <= (signal.endLine ?? signal.line) + 2; n++) {
    const text = lines.text.get(n);
    if (text !== undefined) window.push(normalize(text));
  }
  const wanted = raw.split("\n").map((line) => normalize(stripAnnotation(line))).filter((line) => line.length >= 3);
  if (!wanted.length) return "missing";
  const joined = window.join(" ");
  if (joined.includes(normalize(wanted.join(" ")))) return "found";
  const hit = (needle: string) => window.some((line) => line.includes(needle) || line.includes(stripMarker(needle)));
  const hits = wanted.filter(hit).length;
  return hits === wanted.length ? "found" : hits > 0 ? "partial" : "not_found";
}

export interface Agreement { found: number; runs: number }

/** Compute the final confidence from the model's level plus facts the code can check. Pure and deterministic. */
export function scoreSignal(signal: Signal, map: LineMap, agreement?: Agreement): Signal {
  const path = resolvePath(map, signal.file);
  const lines = path ? map.get(path) : undefined;
  const level = signal.level ?? "low";
  const base = SCORING.base[level];
  const anchor = lines?.added.has(signal.line) ? "added" : lines?.context.has(signal.line) ? "context" : "none";
  const evidence = verifyEvidence(signal, lines);
  let agree: ConfidenceBreakdown["agreement"] = "n/a";
  if (agreement && agreement.runs > 1) {
    agree = agreement.found >= agreement.runs ? "all" : agreement.found === 1 ? "single" : "partial";
  }
  const anchorDelta = SCORING.anchor[anchor];
  const evidenceDelta = SCORING.evidence[evidence];
  const agreementDelta = agree === "n/a" ? 0 : SCORING.agreement[agree];
  const raw = base + anchorDelta + evidenceDelta + agreementDelta;
  const confidence = Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100;
  return {
    ...signal, level, confidence,
    confidenceBreakdown: { level, base, anchor, anchorDelta, evidence, evidenceDelta, agreement: agree, agreementDelta },
  };
}

const LEVEL_RANK = { high: 3, medium: 2, low: 1 } as const;

/**
 * Group the signals of several independent runs into findings. Two signals are the same finding when they
 * share file and category and their lines are within `tolerance`. A finding counts each run at most once.
 */
export function clusterRuns(runs: Signal[][], tolerance = 3): { signal: Signal; found: number }[] {
  const clusters: { signal: Signal; seen: Set<number> }[] = [];
  runs.forEach((signals, runIndex) => {
    for (const signal of signals) {
      const match = clusters.find((c) => !c.seen.has(runIndex) && c.signal.file === signal.file
        && c.signal.category === signal.category && Math.abs(c.signal.line - signal.line) <= tolerance);
      if (match) {
        match.seen.add(runIndex);
        if (LEVEL_RANK[signal.level ?? "low"] > LEVEL_RANK[match.signal.level ?? "low"]) match.signal = signal;
      } else {
        clusters.push({ signal, seen: new Set([runIndex]) });
      }
    }
  });
  return clusters.map((c) => ({ signal: c.signal, found: c.seen.size }));
}
