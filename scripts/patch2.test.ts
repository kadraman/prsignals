import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiffLines, resolvePath } from "./difflines.ts";
import { clusterRuns, scoreFinding, verifyEvidence } from "./confidence.ts";
import {
  fixBriefFindings, parseResponse, partitionInline, qualifiesForFixBrief, qualifiesForInline, rankFindings,
} from "./findings.ts";
import { packBatches, splitBatchForRetry, splitDiff } from "./reviewbrief.ts";

const DIFF = [
  "diff --git a/a.py b/a.py", "--- a/a.py", "+++ b/a.py",
  "@@ -1,4 +1,6 @@", " import os", "-old", "+def run(cmd):", "+    os.system(cmd)", "+    return True", " # end", " x = 1",
].join("\n");
const map = parseDiffLines(DIFF);       // a.py: 1 ctx "import os", 2 "def run(cmd):", 3 "    os.system(cmd)", 4 "    return True", 5 ctx, 6 ctx
const sig = (o: any = {}) => ({ id: "S", category: "security", severity: "high", level: "high", confidence: 0.75, file: "a.py", line: 3,
  title: "t", description: "d", evidence: "os.system(cmd)", ...o });

test("normalizeFinding maps confidence levels and numbers; missing is low", () => {
  const level = (c: unknown) => parseResponse(JSON.stringify({ findings: [{ category: "quality", severity: "low", file: "a", line: 1, title: "t", description: "d", confidence: c }] })).findings[0];
  assert.deepEqual(["high", "MEDIUM", 0.9, "70%", 0.2, undefined].map((c) => level(c).level), ["high", "medium", "high", "medium", "low", "low"]);
  assert.equal(level("high").confidence, 0.75);
  assert.equal(parseResponse(JSON.stringify({ findings: [{ category: "quality", severity: "low", file: "a", line: 1, title: "t", description: "d", confidence: "high", evidence: "x = 1" }] })).findings[0].evidence, "x = 1");
});

test("parseDiffLines keeps line text without carriage returns; resolvePath tolerates prefixes", () => {
  const crlf = parseDiffLines(DIFF.replace(/\n/g, "\r\n"));
  assert.equal(crlf.get("a.py")!.text.get(3), "    os.system(cmd)");
  assert.equal(map.get("a.py")!.text.get(1), "import os");
  assert.equal(resolvePath(map, "./a.py"), "a.py");
  assert.equal(resolvePath(map, "b/a.py"), "a.py");
  assert.equal(resolvePath(map, "zzz.py"), undefined);
});

test("verifyEvidence: found, annotation prefix, partial, not found, missing, outside window, trivial lines", () => {
  const lines = map.get("a.py");
  assert.equal(verifyEvidence(sig() as any, lines), "found");
  assert.equal(verifyEvidence(sig({ evidence: "    3 +    os.system(cmd)" }) as any, lines), "found");
  assert.equal(verifyEvidence(sig({ evidence: "def run(cmd):\nsubprocess.call(cmd)" }) as any, lines), "partial");
  assert.equal(verifyEvidence(sig({ evidence: "eval(user_input)" }) as any, lines), "not_found");
  assert.equal(verifyEvidence(sig({ evidence: undefined }) as any, lines), "missing");
  assert.equal(verifyEvidence(sig({ evidence: "}" }) as any, lines), "missing");
  assert.equal(verifyEvidence(sig({ line: 40, evidence: "os.system(cmd)" }) as any, lines), "not_found");
  assert.equal(verifyEvidence(sig({ evidence: "+    os.system(cmd)" }) as any, lines), "found");
});

test("scoreFinding is deterministic and follows the table", () => {
  const score = (o: any, a?: any) => scoreFinding(sig(o) as any, map, a).confidence;
  assert.equal(score({}), 0.95);                                   // high + added + evidence found
  assert.equal(score({ line: 5, evidence: "# end" }), 0.90);        // high + context + found
  assert.equal(score({ evidence: undefined }), 0.75);              // high + added + missing
  assert.equal(score({ evidence: "nothing like this" }), 0.60);     // high + added + not found
  assert.equal(score({ file: "zzz.py" }), 0.35);                   // unanchored: 0.75 - 0.15 - 0.25
  assert.equal(score({ level: "low" }), 0.55);
  assert.equal(score({ level: "medium" }, { found: 2, runs: 2 }), 0.85);   // 0.55+0.10+0.10+0.10 is 0.8500000000000001 before rounding
  assert.equal(score({ level: "medium", line: 5, evidence: "# end" }, { found: 2, runs: 2 }), 0.80); // context line
  assert.equal(score({}, { found: 3, runs: 3 }), 1);               // clamped
  assert.equal(score({}, { found: 1, runs: 2 }), 0.85);
  assert.deepEqual(scoreFinding(sig() as any, map), scoreFinding(sig() as any, map));
  assert.equal(scoreFinding(sig() as any, map).confidenceBreakdown!.agreement, "n/a");
});

test("clusterRuns counts each run once and keeps distinct findings apart", () => {
  const a = sig({ line: 10 }), b = sig({ line: 12 }), other = sig({ category: "quality", line: 10 }), far = sig({ line: 50 });
  const r = clusterRuns([[a, far], [b, other]] as any);
  assert.deepEqual(r.map((c) => [c.finding.line, c.found]), [[10, 2], [50, 1], [10, 1]]);
  const twoInOneRun = clusterRuns([[sig({ line: 10 }), sig({ line: 11 })]] as any);
  assert.equal(twoInOneRun.length, 2);                                  // same run: not merged
  assert.deepEqual(clusterRuns([[a], [b]] as any), clusterRuns([[a], [b]] as any));
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

test("fix brief includes PR-gated findings plus medium at ≥ 0.75; skips low/info", () => {
  const mk = (o: any) => ({ id: "S", category: "quality", severity: "high", confidence: 0.85, file: "a.py", line: 1, title: "t", description: "d", ...o });
  assert.equal(qualifiesForFixBrief(mk({}) as any, 0.85), true);
  assert.equal(qualifiesForFixBrief(mk({ severity: "medium", confidence: 0.75, title: "m" }) as any, 0.85), true);
  assert.equal(qualifiesForFixBrief(mk({ severity: "medium", confidence: 0.74, title: "m-low" }) as any, 0.85), false);
  assert.equal(qualifiesForFixBrief(mk({ severity: "low", confidence: 0.99, title: "low" }) as any, 0.85), false);
  assert.equal(qualifiesForFixBrief(mk({ severity: "info", confidence: 0.99, title: "info" }) as any, 0.85), false);
  assert.equal(qualifiesForFixBrief(mk({ severity: "high", confidence: 0.84, title: "hi-low" }) as any, 0.85), false);
  const brief = fixBriefFindings([
    mk({ line: 1, severity: "high", confidence: 0.9, title: "keep-high" }),
    mk({ line: 2, severity: "medium", confidence: 0.75, title: "keep-med" }),
    mk({ line: 3, severity: "medium", confidence: 0.74, title: "drop-med" }),
    mk({ line: 4, severity: "low", confidence: 0.9, title: "drop-low" }),
  ] as any, 0.85);
  assert.deepEqual(brief.map((s) => s.title), ["keep-high", "keep-med"]);
});

test("splitDiff force-splits files above piece-chars even when under batch-chars", () => {
  const hunk = Array.from({ length: 80 }, (_, i) => `+line_${i}_xxxxxxxxxxxxxxxxxxxxxxxx`).join("\n");
  const file = ["diff --git a/big.ts b/big.ts", "--- a/big.ts", "+++ b/big.ts", "@@ -0,0 +1,80 @@", hunk].join("\n");
  const annotatedLen = file.length; // annotateDiff adds line numbers; still large
  assert.ok(annotatedLen > 2000);
  const underBatch = splitDiff(file, 100000, 1500);
  assert.ok(underBatch.pieces.length >= 2, `expected split, got ${underBatch.pieces.length}`);
  assert.ok(underBatch.pieces.every((p) => / \(part \d+\/\d+\)$/.test(p.label)));
  assert.ok(underBatch.pieces.every((p) => p.text.length <= 1500 + 200)); // header slack
  const noSplit = splitDiff(file, 100000, 100000);
  assert.equal(noSplit.pieces.length, 1);
  assert.equal(noSplit.pieces[0].label, "big.ts");
});

test("packBatches keeps split file parts in solo batches; packs small files together", () => {
  const small = [
    { label: "a.ts", text: "a".repeat(100) },
    { label: "b.ts", text: "b".repeat(100) },
    { label: "big.ts (part 1/2)", text: "x".repeat(500) },
    { label: "big.ts (part 2/2)", text: "y".repeat(500) },
    { label: "c.ts", text: "c".repeat(100) },
  ];
  const batches = packBatches(small, 1000);
  assert.deepEqual(batches.map((b) => b.map((p) => p.label)), [
    ["a.ts", "b.ts"],
    ["big.ts (part 1/2)"],
    ["big.ts (part 2/2)"],
    ["c.ts"],
  ]);
});

test("splitBatchForRetry bisects multi-piece and large solo batches", () => {
  assert.deepEqual(
    splitBatchForRetry([{ label: "a", text: "1" }, { label: "b", text: "2" }])?.map((b) => b[0].label),
    ["a", "b"],
  );
  assert.equal(splitBatchForRetry([{ label: "tiny", text: "short" }]), null);
  const big = "@@ -0,0 +1,800 @@\n" + Array.from({ length: 800 }, (_, i) => `+row${i}_xxxxxxxx\n`).join("");
  assert.ok(big.length >= 4000);
  const parts = splitBatchForRetry([{ label: "big.ts", text: big }]);
  assert.ok(parts && parts.length >= 2);
  assert.ok(parts.every((b) => /big\.ts \(part \d+\/\d+\)$/.test(b[0].label)));
});
