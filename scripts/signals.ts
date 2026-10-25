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
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export interface GitHubReviewPayload {
  event: "COMMENT";
  body: string;
  comments: GitHubReviewComment[];
}

const CATEGORIES = new Set(["security", "quality", "maintainability", "performance", "architecture", "testing", "documentation", "compliance"]);
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const severities: SignalSeverity[] = ["critical", "high", "medium", "low", "info"];
const icons: Record<SignalSeverity, string> = {
  critical: "🚨", high: "⚠️", medium: "🔶", low: "💡", info: "ℹ️",
};

function toInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}
function toConfidence(value: unknown): number | undefined {
  let n: unknown = typeof value === "string" ? Number(value.replace(/%\s*$/, "")) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  if (n > 1 && n <= 100) n = n / 100;
  return (n as number) <= 1 ? (n as number) : undefined;
}
function toText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
    return parts.length ? parts.join(" ") : undefined;
  }
  return undefined;
}

export function normalizeSignal(row: Record<string, unknown>, index: number): Signal | null {
  const category = typeof row.category === "string" ? row.category.toLowerCase() : "";
  const severity = typeof row.severity === "string" ? row.severity.toLowerCase() : "";
  const file = toText(row.file), title = toText(row.title), description = toText(row.description), line = toInt(row.line);
  if (!CATEGORIES.has(category) || !SEVERITIES.has(severity) || !file || !title || !description || !line || line < 1) return null;
  const endLine = toInt(row.endLine);
  const suggestion = typeof row.suggestion === "string" && row.suggestion.trim() ? row.suggestion : undefined;
  const references = Array.isArray(row.references) ? row.references.filter((item): item is string => typeof item === "string") : undefined;
  return {
    id: toText(row.id) ?? `S${index + 1}`,
    category: category as Signal["category"], severity: severity as Signal["severity"],
    confidence: toConfidence(row.confidence) ?? 0.5,
    file, line, endLine: endLine !== undefined && endLine > line ? endLine : undefined,
    title, description, recommendation: toText(row.recommendation), suggestion,
    ruleId: toText(row.ruleId), references,
  };
}

export interface ParseResult { ok: boolean; signals: Signal[]; dropped: number }

/** ok=false: the reply was not usable JSON. ok=true with no signals: a valid "nothing found". */
export function parseResponse(response: string): ParseResult {
  const text = response.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  let data: unknown;
  try { data = JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, signals: [], dropped: 0 };
    try { data = JSON.parse(match[0]); } catch { return { ok: false, signals: [], dropped: 0 }; }
  }
  const rows = Array.isArray(data) ? data
    : typeof data === "object" && data !== null ? (data as Record<string, unknown>).signals : undefined;
  if (!Array.isArray(rows)) return { ok: false, signals: [], dropped: 0 };
  const signals: Signal[] = [];
  rows.forEach((row, index) => {
    const signal = typeof row === "object" && row !== null && !Array.isArray(row)
      ? normalizeSignal(row as Record<string, unknown>, index) : null;
    if (signal) signals.push(signal);
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
  const suggestionFence = fenceFor(suggestion);

  const compose = (includeSuggestion: boolean) => {
    const parts = [header, "", `**${title}**`, "", location, "", description];
    if (recommendation) parts.push("", `**Recommendation:** ${recommendation}`);
    if (includeSuggestion && suggestion) parts.push("", `${suggestionFence}suggestion`, suggestion, suggestionFence);
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

/** Choose a markdown fence longer than any backtick run inside the suggestion body. */
function fenceFor(text: string): string {
  const runs = text.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  return "`".repeat(Math.max(3, longest + 1));
}

export function toReviewComment(signal: Signal, body: string): GitHubReviewComment {
  const range = signal.endLine !== undefined && signal.endLine > signal.line;
  const comment: GitHubReviewComment = {
    path: signal.file, line: range ? (signal.endLine as number) : signal.line, side: "RIGHT", body,
  };
  if (range) { comment.start_line = signal.line; comment.start_side = "RIGHT"; }
  return comment;
}

function signalFingerprint(signal: Signal): string {
  return JSON.stringify([signal.file, signal.line, signal.category, signal.title]);
}

function signalBullet(signal: Signal): string {
  const icon = icons[signal.severity];
  const range = Number.isInteger(signal.endLine) && (signal.endLine as number) > signal.line
    ? `${signal.line}-${signal.endLine}` : `${signal.line}`;
  const title = signal.title.replace(/\s+/g, " ").trim();
  return `- ${icon} **${title}** (\`${signal.file}:${range}\`)`;
}

/** Build the create-review overview body shown above the inline comment threads. */
export function reviewOverviewBody(
  inline: Signal[],
  minimumConfidence: number,
  leftovers: Signal[] = [],
): string {
  const parts = ["## PRSignals review", ""];
  if (!inline.length) {
    parts.push(`No inline findings met the confidence threshold (≥ ${minimumConfidence}).`, "");
  } else {
    const bySeverity = new Map<SignalSeverity, number>();
    for (const signal of inline) {
      bySeverity.set(signal.severity, (bySeverity.get(signal.severity) ?? 0) + 1);
    }
    const counts = severities
      .filter((severity) => bySeverity.has(severity))
      .map((severity) => `| ${severity} | ${bySeverity.get(severity)} |`);
    parts.push(
      `${inline.length} inline finding${inline.length === 1 ? "" : "s"} (confidence ≥ ${minimumConfidence}).`,
      "",
      "| Severity | Count |",
      "|---|---|",
      ...counts,
      "",
      ...inline.map(signalBullet),
      "",
    );
  }
  if (leftovers.length) {
    parts.push(
      "### Also noted (not inline)",
      "",
      ...leftovers.map(signalBullet),
      "",
      "_Below the inline confidence threshold, not anchorable on the diff, or beyond the inline comment cap._",
    );
  }
  return parts.join("\n").trimEnd() + "\n";
}

/** Filter, deduplicate, rank, and build the GitHub create-review payload. */
export function githubReviewPayload(
  anchored: Signal[],
  minimumConfidence = 0.85,
  maxComments = Number.POSITIVE_INFINITY,
  render: (signal: Signal) => string = renderSignal,
  unanchored: Signal[] = [],
): GitHubReviewPayload {
  const belowConfidence: Signal[] = [];
  const unique = new Map<string, Signal>();
  for (const signal of anchored) {
    if (signal.confidence < minimumConfidence) {
      belowConfidence.push(signal);
      continue;
    }
    const fingerprint = signalFingerprint(signal);
    if (!unique.has(fingerprint)) unique.set(fingerprint, signal);
  }
  const ordered = [...unique.values()].sort((a, b) =>
    severities.indexOf(a.severity) - severities.indexOf(b.severity)
    || b.confidence - a.confidence
    || a.file.localeCompare(b.file)
    || a.line - b.line
    || a.title.localeCompare(b.title));
  const inline = maxComments > 0 ? ordered.slice(0, maxComments) : ordered;
  const capped = maxComments > 0 ? ordered.slice(maxComments) : [];
  const leftovers = [...unanchored, ...belowConfidence, ...capped];
  return {
    event: "COMMENT",
    body: reviewOverviewBody(inline, minimumConfidence, leftovers),
    comments: inline.map((signal) => toReviewComment(signal, render(signal))),
  };
}

