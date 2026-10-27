#!/usr/bin/env node
/** Canonical Finding model and GitHub review comment renderer. */

export type FindingCategory =
  | "security" | "quality" | "maintainability" | "performance"
  | "architecture" | "testing" | "documentation" | "compliance";

export type ConfidenceLevel = "high" | "medium" | "low";
export type EvidenceStatus = "found" | "partial" | "not_found" | "missing";

/** Base score for each model-reported confidence level. The final confidence is computed in code (confidence.ts). */
export const LEVEL_BASE: Record<ConfidenceLevel, number> = { high: 0.75, medium: 0.55, low: 0.35 };

export interface ConfidenceBreakdown {
  level: ConfidenceLevel; base: number;
  anchor: "added" | "context" | "none"; anchorDelta: number;
  evidence: EvidenceStatus; evidenceDelta: number;
  agreement: "all" | "partial" | "single" | "n/a"; agreementDelta: number;
}

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
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
  level?: ConfidenceLevel;
  evidence?: string;
  confidenceBreakdown?: ConfidenceBreakdown;
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
const severities: FindingSeverity[] = ["critical", "high", "medium", "low", "info"];
const icons: Record<FindingSeverity, string> = {
  critical: "🚨", high: "⚠️", medium: "🔶", low: "💡", info: "ℹ️",
};

function toInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}
function numberToLevel(n: number): ConfidenceLevel {
  const x = n > 1 ? n / 100 : n;
  return x >= 0.85 ? "high" : x >= 0.6 ? "medium" : "low";
}
function toLevel(value: unknown): ConfidenceLevel {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "high" || v === "medium" || v === "low") return v;
    const n = Number(v.replace(/%\s*$/, ""));
    return Number.isFinite(n) && n >= 0 ? numberToLevel(n) : "low";
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? numberToLevel(value) : "low";
}
function toText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
    return parts.length ? parts.join(" ") : undefined;
  }
  return undefined;
}

export function normalizeFinding(row: Record<string, unknown>, index: number): Finding | null {
  const category = typeof row.category === "string" ? row.category.toLowerCase() : "";
  const severity = typeof row.severity === "string" ? row.severity.toLowerCase() : "";
  const file = toText(row.file), title = toText(row.title), description = toText(row.description), line = toInt(row.line);
  if (!CATEGORIES.has(category) || !SEVERITIES.has(severity) || !file || !title || !description || !line || line < 1) return null;
  const endLine = toInt(row.endLine);
  const level = toLevel(row.confidence);
  const evidence = toText(row.evidence)?.slice(0, 1000);
  const suggestion = typeof row.suggestion === "string" && row.suggestion.trim() ? row.suggestion : undefined;
  const references = Array.isArray(row.references) ? row.references.filter((item): item is string => typeof item === "string") : undefined;
  return {
    id: toText(row.id) ?? `F${index + 1}`,
    category: category as Finding["category"], severity: severity as Finding["severity"],
    level, confidence: LEVEL_BASE[level], evidence,
    file, line, endLine: endLine !== undefined && endLine > line ? endLine : undefined,
    title, description, recommendation: toText(row.recommendation), suggestion,
    ruleId: toText(row.ruleId), references,
  };
}

export interface ParseResult { ok: boolean; findings: Finding[]; dropped: number }

/** ok=false: the reply was not usable JSON. ok=true with no findings: a valid "nothing found". */
export function parseResponse(response: string): ParseResult {
  const text = response.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  let data: unknown;
  try { data = JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, findings: [], dropped: 0 };
    try { data = JSON.parse(match[0]); } catch { return { ok: false, findings: [], dropped: 0 }; }
  }
  const rows = Array.isArray(data) ? data
    : typeof data === "object" && data !== null ? (data as Record<string, unknown>).findings : undefined;
  if (!Array.isArray(rows)) return { ok: false, findings: [], dropped: 0 };
  const findings: Finding[] = [];
  rows.forEach((row, index) => {
    const finding = typeof row === "object" && row !== null && !Array.isArray(row)
      ? normalizeFinding(row as Record<string, unknown>, index) : null;
    if (finding) findings.push(finding);
  });
  return { ok: true, findings, dropped: rows.length - findings.length };
}

export function parseFindings(response: string): Finding[] { return parseResponse(response).findings; }

/** Render one concise, bounded GitHub review comment. */
export function renderFinding(finding: Finding, maxLength = 800): string {
  const header = `${icons[finding.severity]} **${finding.category[0].toUpperCase()}${finding.category.slice(1)} Finding**`;
  let title = finding.title.trim();
  let description = finding.description.trim();
  let recommendation = finding.recommendation?.trim() ?? "";
  const suggestion = finding.suggestion?.trimEnd() ?? "";
  let suggestionNote = "";
  const confidence = `Confidence: ${Math.round(finding.confidence * 100)}%`;
  const lineRange = Number.isInteger(finding.endLine) && (finding.endLine as number) >= finding.line
    ? `${finding.line}-${finding.endLine}` : `${finding.line}`;
  const location = `**Location:** \`${finding.file.replace(/`/g, "\\`")}:${lineRange}\``;
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

export function toReviewComment(finding: Finding, body: string): GitHubReviewComment {
  const range = finding.endLine !== undefined && finding.endLine > finding.line;
  const comment: GitHubReviewComment = {
    path: finding.file, line: range ? (finding.endLine as number) : finding.line, side: "RIGHT", body,
  };
  if (range) { comment.start_line = finding.line; comment.start_side = "RIGHT"; }
  return comment;
}

function findingFingerprint(finding: Finding): string {
  return JSON.stringify([finding.file, finding.line, finding.category, finding.title]);
}

function findingBullet(finding: Finding): string {
  const icon = icons[finding.severity];
  const range = Number.isInteger(finding.endLine) && (finding.endLine as number) > finding.line
    ? `${finding.line}-${finding.endLine}` : `${finding.line}`;
  const title = finding.title.replace(/\s+/g, " ").trim();
  return `- ${icon} **${title}** (\`${finding.file}:${range}\`)`;
}

/** Build the create-review overview body shown above the inline comment threads. */
export function reviewOverviewBody(
  inline: Finding[],
  minimumConfidence: number,
  leftovers: Finding[] = [],
): string {
  const parts = ["## ReviewBrief", ""];
  if (!inline.length) {
    parts.push(
      `No inline findings met the gate (critical/high with confidence ≥ ${minimumConfidence}).`,
      "",
    );
  } else {
    const bySeverity = new Map<FindingSeverity, number>();
    for (const finding of inline) {
      bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + 1);
    }
    const counts = severities
      .filter((severity) => bySeverity.has(severity))
      .map((severity) => `| ${severity} | ${bySeverity.get(severity)} |`);
    parts.push(
      `${inline.length} inline finding${inline.length === 1 ? "" : "s"} (critical/high with confidence ≥ ${minimumConfidence}).`,
      "",
      "| Severity | Count |",
      "|---|---|",
      ...counts,
      "",
      ...inline.map(findingBullet),
      "",
    );
  }
  if (leftovers.length) {
    parts.push(
      "### Also noted (not inline)",
      "",
      ...leftovers.map(findingBullet),
      "",
      "_Below the inline severity/confidence gate, not anchorable on the diff, or beyond the inline comment cap._",
    );
  }
  return parts.join("\n").trimEnd() + "\n";
}

/** De-duplicate (highest confidence wins) and rank findings in a fully deterministic order. */
export function rankFindings(findings: Finding[]): Finding[] {
  const unique = new Map<string, Finding>();
  for (const finding of findings) {
    const fingerprint = findingFingerprint(finding);
    const existing = unique.get(fingerprint);
    if (!existing || finding.confidence > existing.confidence) unique.set(fingerprint, finding);
  }
  return [...unique.values()].sort((a, b) =>
    severities.indexOf(a.severity) - severities.indexOf(b.severity)
    || b.confidence - a.confidence
    || a.file.localeCompare(b.file)
    || a.line - b.line
    || a.title.localeCompare(b.title)
    || a.category.localeCompare(b.category));
}

/**
 * Whether a scored finding is eligible for an inline GitHub review comment.
 * Calibrated against beatbax: only critical/high above the confidence floor post inline;
 * medium/low/info stay in the overview "Also noted" section (medium@0.9 still flooded FPs).
 */
export function qualifiesForInline(finding: Finding, minimumConfidence: number): boolean {
  if (finding.confidence < minimumConfidence) return false;
  return finding.severity === "critical" || finding.severity === "high";
}

/** Split anchored findings into inline comments, below-threshold leftovers, and cap overflow. */
export function partitionInline(
  anchored: Finding[], minimumConfidence: number, maxComments: number,
): { inline: Finding[]; belowConfidence: Finding[]; capped: Finding[] } {
  const belowConfidence = anchored.filter((finding) => !qualifiesForInline(finding, minimumConfidence));
  const ordered = rankFindings(anchored.filter((finding) => qualifiesForInline(finding, minimumConfidence)));
  return {
    inline: maxComments > 0 ? ordered.slice(0, maxComments) : ordered,
    belowConfidence,
    capped: maxComments > 0 ? ordered.slice(maxComments) : [],
  };
}

/** Filter, deduplicate, rank, and build the GitHub create-review payload. */
export function githubReviewPayload(
  anchored: Finding[],
  minimumConfidence = 0.85,
  maxComments = Number.POSITIVE_INFINITY,
  render: (finding: Finding) => string = renderFinding,
  unanchored: Finding[] = [],
): GitHubReviewPayload {
  const { inline, belowConfidence, capped } = partitionInline(anchored, minimumConfidence, maxComments);
  const leftovers = [...unanchored, ...belowConfidence, ...capped];
  return {
    event: "COMMENT",
    body: reviewOverviewBody(inline, minimumConfidence, leftovers),
    comments: inline.map((finding) => toReviewComment(finding, render(finding))),
  };
}

