import { test } from "node:test";
import assert from "node:assert/strict";
import { githubReviewPayload, parseResponse, partitionInline, qualifiesForInline, rankFindings, renderFinding, reviewOverviewBody, toReviewComment } from "../src/findings.ts";

const sig = (o: any) => ({ id: "S", category: "security", severity: "high", confidence: 0.95, file: "a.py", line: 2, title: "t", description: "d", ...o });

test("parseResponse: prose is not ok, empty array is ok, array recommendation survives rendering", () => {
  assert.equal(parseResponse("Looks fine overall.").ok, false);
  assert.deepEqual(parseResponse('{"findings": []}'), { ok: true, findings: [], dropped: 0 });
  const r = parseResponse('```json\n{"findings":[{"id":1,"category":"Security","severity":"HIGH","confidence":"85%","file":"a.py","line":"2","title":"t","description":"d","recommendation":["do A","do B"]},{"bad":true}]}\n```');
  assert.equal(r.ok, true); assert.equal(r.dropped, 1); assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].line, 2); assert.equal(r.findings[0].level, "high"); assert.equal(r.findings[0].confidence, 0.75);
  assert.equal(r.findings[0].recommendation, "do A do B");
  assert.doesNotThrow(() => renderFinding(r.findings[0]));
});

const findingRow = (overrides: Record<string, unknown> = {}) => ({
  category: "security", severity: "high", file: "a.py", line: 2, title: "t", description: "d", ...overrides,
});

test("parseResponse keeps every supported category and severity", () => {
  const categories = ["security", "quality", "maintainability", "performance", "architecture", "testing", "documentation", "compliance"];
  const severities = ["critical", "high", "medium", "low", "info"];
  const parsed = parseResponse(JSON.stringify({
    findings: [
      ...categories.map((category) => findingRow({ category, title: category })),
      ...severities.map((severity) => findingRow({ severity, title: severity })),
    ],
  }));
  assert.equal(parsed.dropped, 0);
  assert.deepEqual(parsed.findings.map((f) => f.category), [...categories, ...severities.map(() => "security")]);
  assert.deepEqual(parsed.findings.slice(categories.length).map((f) => f.severity), severities);
});

test("parseResponse drops findings outside the schema", () => {
  const parsed = parseResponse(JSON.stringify({
    findings: [
      findingRow({ category: "style", title: "rename this" }),
      findingRow({ severity: "nit" }),
      findingRow({ file: "  " }),
      findingRow({ title: "" }),
      findingRow({ description: "" }),
      findingRow({ line: 0 }),
      findingRow({ line: -3 }),
      findingRow(),
    ],
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.dropped, 7);
  assert.equal(parsed.findings[0].title, "t");
});

test("normalizeFinding maps confidence levels and numbers; missing is low", () => {
  const level = (c: unknown) => parseResponse(JSON.stringify({ findings: [{ category: "quality", severity: "low", file: "a", line: 1, title: "t", description: "d", confidence: c }] })).findings[0];
  assert.deepEqual(["high", "MEDIUM", 0.9, "70%", 0.2, undefined].map((c) => level(c).level), ["high", "medium", "high", "medium", "low", "low"]);
  assert.equal(level("high").confidence, 0.75);
  assert.equal(parseResponse(JSON.stringify({ findings: [{ category: "quality", severity: "low", file: "a", line: 1, title: "t", description: "d", confidence: "high", evidence: "x = 1" }] })).findings[0].evidence, "x = 1");
});

test("range comments carry start_line", () => {
  const c = toReviewComment(sig({ line: 2, endLine: 4 }) as any, "b");
  assert.deepEqual([c.start_line, c.line, c.start_side], [2, 4, "RIGHT"]);
  assert.equal("start_line" in toReviewComment(sig({ line: 2 }) as any, "b"), false);
});

test("renderFinding picks a fence longer than any backtick run in the suggestion", () => {
  const body = renderFinding(sig({ suggestion: "use ````code```` here" }) as any, 2000);
  assert.match(body, /\n`````suggestion\n/);
  assert.match(body, /\n`````\n/);
});

test("review overview body summarizes inline findings and leftovers", () => {
  const empty = reviewOverviewBody([], 0.85);
  assert.match(empty, /No inline findings met the gate/);
  const body = reviewOverviewBody([
    sig({ severity: "high", title: "CRLF blank context", file: "src/difflines.ts", line: 34 }),
    sig({ severity: "critical", confidence: 0.95, title: "Fence length", file: "src/findings.ts", line: 128 }),
  ] as any, 0.85, [sig({ confidence: 0.5, title: "Low confidence note", line: 99 }) as any]);
  assert.match(body, /## ReviewBrief/);
  assert.match(body, /2 inline findings \(critical\/high with confidence ≥ 0\.85\)/);
  assert.match(body, /\| critical \| 1 \|/);
  assert.match(body, /\| high \| 1 \|/);
  assert.match(body, /\*\*CRLF blank context\*\* \(`src\/difflines\.ts:34`\)/);
  assert.match(body, /### Also noted \(not inline\)/);
  assert.match(body, /\*\*Low confidence note\*\*/);
  const payload = githubReviewPayload([
    sig({ confidence: 0.9, title: "Keep" }),
    sig({ confidence: 0.5, title: "Drop" }),
    sig({ severity: "low", confidence: 0.95, title: "Low severity drop" }),
    sig({ severity: "medium", confidence: 0.99, title: "Medium never inline" }),
  ] as any, 0.85, undefined, undefined, [sig({ file: "other.py", line: 1, title: "Unanchored", confidence: 0.9 }) as any]);
  assert.match(payload.body, /1 inline finding/);
  assert.match(payload.body, /\*\*Keep\*\*/);
  assert.match(payload.body, /### Also noted \(not inline\)/);
  assert.match(payload.body, /\*\*Drop\*\*/);
  assert.match(payload.body, /\*\*Low severity drop\*\*/);
  assert.match(payload.body, /\*\*Medium never inline\*\*/);
  assert.match(payload.body, /\*\*Unanchored\*\*/);
  assert.equal(payload.comments.length, 1);
});

test("rankFindings/partitionInline: highest-confidence duplicate wins, threshold, cap, input order does not matter", () => {
  const mk = (o: any) => ({ id: "S", category: "security", severity: "high", confidence: 0.9, file: "a.py", line: 3, title: "t", description: "d", ...o });
  const input = [mk({ confidence: 0.86 }), mk({ confidence: 0.95 }), mk({ line: 5, title: "u", severity: "critical" }), mk({ line: 7, title: "v", confidence: 0.5 }), mk({ line: 9, title: "w", confidence: 0.85 })] as any;
  const part = partitionInline(input, 0.85, 0);
  assert.deepEqual(part.inline.map((s) => [s.line, s.confidence]), [[5, 0.9], [3, 0.95], [9, 0.85]]);
  assert.deepEqual(part.belowConfidence.map((s) => s.line), [7]);
  assert.equal(part.capped.length, 0);
  const capped = partitionInline(input, 0.85, 2);
  assert.equal(capped.inline.length, 2);
  assert.deepEqual(capped.capped.map((s) => s.line), [9]);
  assert.deepEqual(partitionInline([...input].reverse(), 0.85, 0), part);
  assert.deepEqual(rankFindings([...input].reverse()), rankFindings(input));
  // equal on every ranking key except category: still a total order
  const a = mk({ category: "quality" }), b = mk({ category: "security" });
  assert.deepEqual(rankFindings([b, a] as any).map((s) => s.category), ["quality", "security"]);
});

test("qualifiesForInline: only critical/high above confidence floor; medium/low/info never inline", () => {
  const mk = (o: any) => ({ id: "S", category: "quality", severity: "high", confidence: 0.85, file: "a.py", line: 1, title: "t", description: "d", ...o });
  assert.equal(qualifiesForInline(mk({}) as any, 0.85), true);
  assert.equal(qualifiesForInline(mk({ severity: "critical", confidence: 0.85 }) as any, 0.85), true);
  assert.equal(qualifiesForInline(mk({ severity: "high", confidence: 0.84 }) as any, 0.85), false);
  assert.equal(qualifiesForInline(mk({ severity: "medium", confidence: 0.99 }) as any, 0.85), false);
  assert.equal(qualifiesForInline(mk({ severity: "low", confidence: 0.99 }) as any, 0.85), false);
  assert.equal(qualifiesForInline(mk({ severity: "info", confidence: 0.99 }) as any, 0.85), false);
  const gated = partitionInline([
    mk({ line: 1, severity: "high", confidence: 0.9 }),
    mk({ line: 2, severity: "critical", confidence: 0.85, title: "crit" }),
    mk({ line: 3, severity: "medium", confidence: 0.99, title: "m-hi" }),
    mk({ line: 4, severity: "low", confidence: 0.99, title: "low" }),
  ] as any, 0.85, 0);
  assert.deepEqual(gated.inline.map((s) => s.line), [2, 1]);
  assert.deepEqual(gated.belowConfidence.map((s) => s.line).sort((a, b) => a - b), [3, 4]);
});
