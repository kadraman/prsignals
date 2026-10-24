#!/usr/bin/env node
/** Canonical Signal model and GitHub review comment renderer. */

export type SignalCategory =
  | "security" | "quality" | "maintainability" | "performance"
  | "architecture" | "testing" | "documentation" | "compliance";

export type SignalSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface Signal {
  id: string;
  category: SignalCategory;
  severity: SignalSeverity;
  confidence: number;
  file: string;
  line: number;
  endLine?: number;
  title: string;
  description: string;
  recommendation?: string;
  suggestion?: string;
  ruleId?: string;
  references?: string[];
}

export interface GitHubReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export interface GitHubReviewPayload {
  event: "COMMENT";
  body: string;
  comments: GitHubReviewComment[];
}

const categories = new Set<SignalCategory>([
  "security", "quality", "maintainability", "performance", "architecture",
  "testing", "documentation", "compliance",
]);
const severities: SignalSeverity[] = ["critical", "high", "medium", "low", "info"];
const icons: Record<SignalSeverity, string> = {
  critical: "🚨", high: "⚠️", medium: "🔶", low: "💡", info: "ℹ️",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ParseResult { ok: boolean; signals: Signal[]; dropped: number }

/** ok=false: the reply was not usable JSON. ok=true with no signals: a valid "nothing found". */
export function parseResponse(response: string): ParseResult {
  const text = response.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, signals: [], dropped: 0 };
    try {
      data = JSON.parse(match[0]);
    } catch {
      return { ok: false, signals: [], dropped: 0 };
    }
  }
  const rows = Array.isArray(data) ? data
    : typeof data === "object" && data !== null ? (data as Record<string, unknown>).signals : undefined;
  if (!Array.isArray(rows)) return { ok: false, signals: [], dropped: 0 };

  const signals: Signal[] = [];
  rows.forEach((row) => {
    if (!isRecord(row)) return;
    const valid = typeof row.id === "string" && !!row.id.trim()
      && typeof row.file === "string" && !!row.file.trim()
      && typeof row.title === "string" && !!row.title.trim()
      && typeof row.description === "string" && !!row.description.trim()
      && categories.has(row.category as SignalCategory)
      && severities.includes(row.severity as SignalSeverity)
      && typeof row.confidence === "number" && Number.isFinite(row.confidence)
      && row.confidence >= 0 && row.confidence <= 1
      && Number.isInteger(row.line) && (row.line as number) > 0;
    if (valid) signals.push({ ...row } as unknown as Signal);
  });
  return { ok: true, signals, dropped: rows.length - signals.length };
}

export function parseSignals(response: string): Signal[] { return parseResponse(response).signals; }

/** Render one concise, bounded GitHub review comment. */
export function renderSignal(signal: Signal, maxLength = 800): string {
  const header = `${icons[signal.severity]} **${signal.category[0].toUpperCase()}${signal.category.slice(1)} Signal**`;
  let title = signal.title.trim();
  let description = signal.description.trim();
  let recommendation = signal.recommendation?.trim() ?? "";
  const suggestion = signal.suggestion?.trimEnd() ?? "";
  let suggestionNote = "";
  const confidence = `Confidence: ${Math.round(signal.confidence * 100)}%`;
  const lineRange = Number.isInteger(signal.endLine) && (signal.endLine as number) >= signal.line
    ? `${signal.line}-${signal.endLine}` : `${signal.line}`;
  const location = `**Location:** \`${signal.file.replace(/`/g, "\\`")}:${lineRange}\``;

  const compose = (includeSuggestion: boolean) => {
    const parts = [header, "", `**${title}**`, "", location, "", description];
    if (recommendation) parts.push("", `**Recommendation:** ${recommendation}`);
    if (includeSuggestion && suggestion) parts.push("", "```suggestion", suggestion, "```");
    if (suggestionNote) parts.push("", suggestionNote);
    parts.push("", confidence);
    return parts.join("\n");
  };

  let includeSuggestion = Boolean(suggestion);
  if (compose(includeSuggestion).length > maxLength && includeSuggestion) {
    // An incomplete GitHub suggestion fence absorbs all following Markdown.
    // Omit an oversized suggestion block instead of returning malformed Markdown.
    includeSuggestion = false;
    suggestionNote = "**Suggestion omitted:** it exceeds the comment length limit.";
  }
  let body = compose(includeSuggestion);
  while (body.length > maxLength) {
    const excess = body.length - maxLength;
    if (description.length) {
      description = shorten(description, Math.max(0, description.length - excess - 1));
    } else if (recommendation.length) {
      recommendation = shorten(recommendation, Math.max(0, recommendation.length - excess - 1));
    } else if (title.length) {
      title = shorten(title, Math.max(0, title.length - excess - 1));
    } else {
      break;
    }
    body = compose(includeSuggestion);
  }
  return body.length <= maxLength ? body : `${body.slice(0, maxLength - 1)}…`;
}

function shorten(value: string, length: number): string {
  if (length <= 0) return "";
  if (value.length <= length) return value;
  return `${value.slice(0, length - 1).trimEnd()}…`;
}

/** Filter, deduplicate, rank, and build the GitHub create-review payload. */
export function githubReviewPayload(
  signals: Signal[], minimumConfidence = 0.85, maxComments = Number.POSITIVE_INFINITY,
): GitHubReviewPayload {
  const unique = new Map<string, Signal>();
  for (const signal of signals) {
    if (signal.confidence < minimumConfidence) continue;
    const fingerprint = JSON.stringify([
      signal.file, signal.line, signal.category, signal.title,
    ]);
    if (!unique.has(fingerprint)) unique.set(fingerprint, signal);
  }
  const ordered = [...unique.values()].sort((a, b) =>
    severities.indexOf(a.severity) - severities.indexOf(b.severity)
    || b.confidence - a.confidence
    || a.file.localeCompare(b.file)
    || a.line - b.line
    || a.title.localeCompare(b.title));
  return {
    event: "COMMENT",
    body: "PRSignals review findings.",
    comments: (maxComments > 0 ? ordered.slice(0, maxComments) : ordered).map((signal) => ({
      path: signal.file, line: signal.line, side: "RIGHT", body: renderSignal(signal),
    })),
  };
}

