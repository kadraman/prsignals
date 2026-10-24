import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiffLines, annotateDiff, anchorSignals } from "./difflines.ts";
import { parseResponse, renderSignal, toReviewComment } from "./signals.ts";

const DIFF = [
  "diff --git a/a.py b/a.py", "index 111..222 100644", "--- a/a.py", "+++ b/a.py",
  "@@ -1,4 +1,5 @@", " line1", "-old2", "+new2", "+new3", " line3", " line4",
  "@@ -20,2 +21,2 @@", " ctx20", "-gone", "+++ looks like header",
  "diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt",
  "@@ -0,0 +1,2 @@", "+hello", "+world", "\\ No newline at end of file",
  "diff --git a/del.txt b/del.txt", "deleted file mode 100644", "--- a/del.txt", "+++ /dev/null",
  "@@ -1,2 +0,0 @@", "-x", "-y", "",
].join("\n");

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
const sig = (o: any) => ({ id: "S", category: "security", severity: "high", confidence: 0.95, file: "a.py", line: 2, title: "t", description: "d", ...o });

test("parseDiffLines maps new-side lines, ignores deletions and '+++' content lines", () => {
  const m = parseDiffLines(DIFF);
  assert.deepEqual(sorted(m.get("a.py")!.added), [2, 3, 22]);
  assert.deepEqual(sorted(m.get("a.py")!.context), [1, 4, 5, 21]);
  assert.deepEqual(sorted(m.get("new.txt")!.added), [1, 2]);
  assert.equal(m.has("del.txt"), false);
});

test("annotateDiff numbers only added/context lines", () => {
  const out = annotateDiff(DIFF.split("diff --git a/new.txt")[0]).split("\n");
  assert.ok(out.includes("    1  line1"));
  assert.ok(out.includes("      -old2"));
  assert.ok(out.includes("    2 +new2"));
  assert.ok(out.some((l) => l.startsWith("   22 +")));
});

test("anchorSignals: valid, invalid line, valid range, cross-hunk range drops suggestion", () => {
  const m = parseDiffLines(DIFF);
  const r = anchorSignals([
    sig({ line: 2 }), sig({ line: 99 }), sig({ file: "nope.py" }),
    sig({ line: 2, endLine: 4, suggestion: "x" }), sig({ line: 5, endLine: 21, suggestion: "y" }), sig({ file: "./a.py", line: 22 }),
  ] as any, m);
  assert.equal(r.anchored.length, 4);
  assert.equal(r.unanchored.length, 2);
  assert.equal(r.anchored[1].endLine, 4);
  assert.equal(r.anchored[2].endLine, undefined);
  assert.equal(r.anchored[2].suggestion, undefined);
  assert.equal(r.anchored[3].file, "a.py");
});

test("range comments carry start_line", () => {
  const c = toReviewComment(sig({ line: 2, endLine: 4 }) as any, "b");
  assert.deepEqual([c.start_line, c.line, c.start_side], [2, 4, "RIGHT"]);
  assert.equal("start_line" in toReviewComment(sig({ line: 2 }) as any, "b"), false);
});

test("parseResponse: prose is not ok, empty array is ok, array recommendation survives rendering", () => {
  assert.equal(parseResponse("Looks fine overall.").ok, false);
  assert.deepEqual(parseResponse('{"signals": []}'), { ok: true, signals: [], dropped: 0 });
  const r = parseResponse('```json\n{"signals":[{"id":1,"category":"Security","severity":"HIGH","confidence":"85%","file":"a.py","line":"2","title":"t","description":"d","recommendation":["do A","do B"]},{"bad":true}]}\n```');
  assert.equal(r.ok, true); assert.equal(r.dropped, 1); assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].line, 2); assert.equal(r.signals[0].confidence, 0.85);
  assert.equal(r.signals[0].recommendation, "do A do B");
  assert.doesNotThrow(() => renderSignal(r.signals[0]));
});
