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
  return findingRejectReason(row) ? null : normalizeFindingUnchecked(row, index);
}

/** Why a raw finding row fails the schema, or null if it would normalize. */
export function findingRejectReason(row: unknown): string | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return "not a JSON object";
  const r = row as Record<string, unknown>;
  const category = typeof r.category === "string" ? r.category.toLowerCase() : "";
  if (!CATEGORIES.has(category)) {
    return `category must be one of ${[...CATEGORIES].join("|")} (got ${JSON.stringify(r.category)})`;
  }
  const severity = typeof r.severity === "string" ? r.severity.toLowerCase() : "";
  if (!SEVERITIES.has(severity)) {
    return `severity must be one of ${[...SEVERITIES].join("|")} (got ${JSON.stringify(r.severity)})`;
  }
  if (!toText(r.file)) return "file is required";
  if (!toText(r.title)) return "title is required";
  if (!toText(r.description)) return "description is required";
  const line = toInt(r.line);
  if (!line || line < 1) return `line must be a positive integer (got ${JSON.stringify(r.line)})`;
  return null;
}

function normalizeFindingUnchecked(row: Record<string, unknown>, index: number): Finding {
  const category = (row.category as string).toLowerCase();
  const severity = (row.severity as string).toLowerCase();
  const file = toText(row.file) as string, title = toText(row.title) as string;
  const description = toText(row.description) as string, line = toInt(row.line) as number;
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

export interface RejectedFinding { index: number; reason: string; row: unknown }
export interface ParseResult {
  ok: boolean; findings: Finding[]; dropped: number; rejected: RejectedFinding[];
}

const emptyParse = (): ParseResult => ({ ok: false, findings: [], dropped: 0, rejected: [] });

/** ok=false: the reply was not usable JSON. ok=true with no findings: a valid "nothing found". */
export function parseResponse(response: string): ParseResult {
  const text = response.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  let data: unknown;
  try { data = JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return emptyParse();
    try { data = JSON.parse(match[0]); } catch { return emptyParse(); }
  }
  const rows = Array.isArray(data) ? data
    : typeof data === "object" && data !== null ? (data as Record<string, unknown>).findings : undefined;
  if (!Array.isArray(rows)) return emptyParse();
  const findings: Finding[] = [];
  const rejected: RejectedFinding[] = [];
  rows.forEach((row, index) => {
    const reason = findingRejectReason(row);
    if (reason) { rejected.push({ index, reason, row }); return; }
    findings.push(normalizeFindingUnchecked(row as Record<string, unknown>, index));
  });
  return { ok: true, findings, dropped: rejected.length, rejected };
}

/** Prompt fragment asking the model to correct rejected finding rows only. */
export function repairFindingsPrompt(rejected: RejectedFinding[]): string {
  const items = rejected.map((item, i) => {
    let serialized: string;
    try { serialized = JSON.stringify(item.row); }
    catch { serialized = "[unserializable]"; }
    if (serialized.length > 800) serialized = `${serialized.slice(0, 797)}...`;
    return `${i + 1}. reason: ${item.reason}\n   item: ${serialized}`;
  }).join("\n");
  return [
    "",
    "Your previous reply included findings that failed validation. Do NOT resend the findings that were already accepted.",
    "Reply with ONLY a JSON object {\"findings\":[...]} containing corrected versions of the rejected items below, or {\"findings\":[]} if they were not real findings.",
    "Each corrected item must include: category (security|quality|maintainability|performance|architecture|testing|documentation|compliance), severity (critical|high|medium|low|info), confidence (\"high\"|\"medium\"|\"low\"), file, line (positive integer), title, description, evidence.",
    "",
    "Rejected items:",
    items,
  ].join("\n");
}

export function parseFindings(response: string): Finding[] { return parseResponse(response).findings; }

/** Render one concise, bounded GitHub review comment. Prefer keeping a GitHub suggestion by shrinking prose first. */
export function renderFinding(finding: Finding, maxLength = 800): string {
  // Compact chrome so more of the budget goes to the suggestion / explanation.
  const header = `${icons[finding.severity]} **${finding.category[0].toUpperCase()}${finding.category.slice(1)}**`;
  const fullTitle = finding.title.trim();
  const fullDescription = finding.description.trim();
  const fullRecommendation = finding.recommendation?.trim() ?? "";
  let title = fullTitle;
  let description = fullDescription;
  let recommendation = fullRecommendation;
  const suggestion = finding.suggestion?.trimEnd() ?? "";
  let suggestionNote = "";
  const confidence = `${Math.round(finding.confidence * 100)}% confidence`;
  const lineRange = Number.isInteger(finding.endLine) && (finding.endLine as number) >= finding.line
    ? `${finding.line}-${finding.endLine}` : `${finding.line}`;
  const location = `\`${finding.file.replace(/`/g, "\\`")}:${lineRange}\``;
  const suggestionFence = fenceFor(suggestion);

  const compose = (includeSuggestion: boolean) => {
    const parts = [header, "", `**${title}**`, "", location, "", description];
    if (recommendation) parts.push("", `**Fix:** ${recommendation}`);
    if (includeSuggestion && suggestion) parts.push("", `${suggestionFence}suggestion`, suggestion, suggestionFence);
    if (suggestionNote) parts.push("", suggestionNote);
    parts.push("", confidence);
    return parts.join("\n");
  };

  const shrinkProse = (includeSuggestion: boolean): string => {
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
    return body;
  };

  let includeSuggestion = Boolean(suggestion);
  let body = shrinkProse(includeSuggestion);
  // Only drop the suggestion when it still cannot fit after prose is exhausted.
  // Never truncate mid-fence — an incomplete suggestion block absorbs following Markdown.
  if (body.length > maxLength && includeSuggestion) {
    includeSuggestion = false;
    suggestionNote = "**Suggestion omitted:** it exceeds the comment length limit.";
    title = fullTitle;
    description = fullDescription;
    recommendation = fullRecommendation;
    body = shrinkProse(false);
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

/** Title, location, description, and recommendation for overview-only (non-inline) findings. */
function summaryFindingBullet(finding: Finding): string {
  const icon = icons[finding.severity];
  const range = Number.isInteger(finding.endLine) && (finding.endLine as number) > finding.line
    ? `${finding.line}-${finding.endLine}` : `${finding.line}`;
  const title = finding.title.replace(/\s+/g, " ").trim();
  const description = finding.description.replace(/\s+/g, " ").trim();
  const recommendation = finding.recommendation?.replace(/\s+/g, " ").trim();
  const lines = [
    `- ${icon} **${title}** (\`${finding.file}:${range}\`)`,
    `  ${description}`,
  ];
  if (recommendation) lines.push(`  **Recommendation:** ${recommendation}`);
  return lines.join("\n");
}

export interface OverviewSections {
  unanchored?: Finding[];
  capped?: Finding[];
}

/** Whether the payload has anything worth posting (inline comments or gated summary sections). */
export function payloadHasContent(payload: GitHubReviewPayload): boolean {
  if (payload.comments.length > 0) return true;
  return /### Could not place inline|### Over the inline cap/.test(payload.body);
}

/** Build the create-review overview body shown above the inline comment threads. */
export function reviewOverviewBody(
  inline: Finding[],
  minimumConfidence: number,
  sections: OverviewSections = {},
): string {
  const unanchored = sections.unanchored ?? [];
  const capped = sections.capped ?? [];
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
  if (unanchored.length) {
    parts.push(
      "### Could not place inline",
      "",
      "_Critical/high findings at or above the confidence floor whose line is not on the reviewed diff._",
      "",
      ...unanchored.map(summaryFindingBullet),
      "",
    );
  }
  if (capped.length) {
    parts.push(
      "### Over the inline cap",
      "",
      "_Critical/high findings at or above the confidence floor that exceeded `max-inline-comments`._",
      "",
      ...capped.map(summaryFindingBullet),
      "",
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

/** True when consistency scoring says the finding appeared in more than one run. */
export function hasMultiRunAgreement(finding: Finding): boolean {
  const agreement = finding.confidenceBreakdown?.agreement;
  return agreement === "all" || agreement === "partial";
}

/**
 * Whether a scored finding is eligible for an inline GitHub review comment.
 * Calibrated against beatbax: only critical/high above the confidence floor post inline;
 * medium/low/info stay off the PR (they remain in findings.json / the job summary).
 * When requireMultiRun is set (consistency runs with agreement scoring), one-off findings stay off the PR.
 */
export function qualifiesForInline(
  finding: Finding, minimumConfidence: number, requireMultiRun = false,
): boolean {
  if (finding.confidence < minimumConfidence) return false;
  if (finding.severity !== "critical" && finding.severity !== "high") return false;
  if (requireMultiRun && !hasMultiRunAgreement(finding)) return false;
  return true;
}

/** Split anchored findings into inline comments, below-threshold leftovers, and cap overflow. */
export function partitionInline(
  anchored: Finding[], minimumConfidence: number, maxComments: number, requireMultiRun = false,
): { inline: Finding[]; belowConfidence: Finding[]; capped: Finding[] } {
  const belowConfidence = anchored.filter((finding) => !qualifiesForInline(finding, minimumConfidence, requireMultiRun));
  const ordered = rankFindings(anchored.filter((finding) => qualifiesForInline(finding, minimumConfidence, requireMultiRun)));
  return {
    inline: maxComments > 0 ? ordered.slice(0, maxComments) : ordered,
    belowConfidence,
    capped: maxComments > 0 ? ordered.slice(maxComments) : [],
  };
}

/** Findings that clear the publish gate: inline threads plus gated overview sections. */
export function publishableFindings(
  anchored: Finding[],
  unanchored: Finding[],
  minimumConfidence: number,
  maxComments: number,
  requireMultiRun = false,
): { inline: Finding[]; unanchored: Finding[]; capped: Finding[]; all: Finding[] } {
  const { inline, capped } = partitionInline(anchored, minimumConfidence, maxComments, requireMultiRun);
  const gatedUnanchored = rankFindings(
    unanchored.filter((finding) => qualifiesForInline(finding, minimumConfidence, requireMultiRun)),
  );
  return { inline, unanchored: gatedUnanchored, capped, all: [...inline, ...gatedUnanchored, ...capped] };
}

/** Default confidence floor for medium findings in the fix brief (PR gate stays stricter). */
export const FIX_BRIEF_MEDIUM_CONFIDENCE = 0.75;

/**
 * Whether a scored finding belongs in fix-brief.md.
 * Always includes the PR publish set (critical/high ≥ minimumConfidence).
 * Also includes medium severity at or above fixBriefMediumConfidence (default 0.75).
 * Low/info stay out of the brief (job summary / findings.json only).
 * When requireMultiRun is set, one-off findings (agreement "single") stay out of the brief too.
 */
export function qualifiesForFixBrief(
  finding: Finding,
  minimumConfidence: number,
  fixBriefMediumConfidence = FIX_BRIEF_MEDIUM_CONFIDENCE,
  requireMultiRun = false,
): boolean {
  if (requireMultiRun && !hasMultiRunAgreement(finding)) return false;
  if (qualifiesForInline(finding, minimumConfidence, false)) return true;
  if (finding.severity !== "medium") return false;
  return finding.confidence >= fixBriefMediumConfidence;
}

/** Ranked findings that should drive the AI fix brief. */
export function fixBriefFindings(
  findings: Finding[],
  minimumConfidence: number,
  fixBriefMediumConfidence = FIX_BRIEF_MEDIUM_CONFIDENCE,
  requireMultiRun = false,
): Finding[] {
  return rankFindings(findings.filter((finding) =>
    qualifiesForFixBrief(finding, minimumConfidence, fixBriefMediumConfidence, requireMultiRun)));
}

/** Filter, deduplicate, rank, and build the GitHub create-review payload. */
export function githubReviewPayload(
  anchored: Finding[],
  minimumConfidence = 0.85,
  maxComments = Number.POSITIVE_INFINITY,
  render: (finding: Finding) => string = renderFinding,
  unanchored: Finding[] = [],
  requireMultiRun = false,
): GitHubReviewPayload {
  const published = publishableFindings(anchored, unanchored, minimumConfidence, maxComments, requireMultiRun);
  return {
    event: "COMMENT",
    body: reviewOverviewBody(published.inline, minimumConfidence, {
      unanchored: published.unanchored,
      capped: published.capped,
    }),
    comments: published.inline.map((finding) => toReviewComment(finding, render(finding))),
  };
}

