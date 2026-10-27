import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../src/reviewbrief.ts");

const THREE_FILE_DIFF = [
  "diff --git a/one.py b/one.py", "index 111..222 100644", "--- a/one.py", "+++ b/one.py",
  "@@ -1,1 +1,2 @@", " keep", "+added-one",
  "diff --git a/two.py b/two.py", "index 111..222 100644", "--- a/two.py", "+++ b/two.py",
  "@@ -1,1 +1,2 @@", " keep", "+added-two",
  "diff --git a/three.py b/three.py", "index 111..222 100644", "--- a/three.py", "+++ b/three.py",
  "@@ -1,1 +1,2 @@", " keep", "+added-three",
].join("\n");

// a.py new-file lines: 1 context "import os", 2 "def run(cmd):", 3 "    os.system(cmd)", 4 "    return True", 5 context "# end"
const DIFF = [
  "diff --git a/a.py b/a.py", "index 111..222 100644", "--- a/a.py", "+++ b/a.py",
  "@@ -1,2 +1,5 @@", " import os", "+def run(cmd):", "+    os.system(cmd)", "+    return True", " # end",
].join("\n");
const LOCKFILE_DIFF = ["diff --git a/package-lock.json b/package-lock.json", "--- a/package-lock.json", "+++ b/package-lock.json", "@@ -1 +1 @@", "-a", "+b"].join("\n");

const finding = (o: Record<string, unknown> = {}) => ({
  id: "S", category: "security", severity: "high", confidence: "high", file: "a.py", line: 3,
  title: "t", description: "d", evidence: "os.system(cmd)", ...o,
});
const findingsJson = (...findings: unknown[]) => JSON.stringify({ findings });

type Reply = { status: number; content?: string; message?: string };
type RequestBody = { temperature?: number; messages?: { role: string; content: string }[] };

function partNumber(body: RequestBody): number {
  const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
  const match = /This is part (\d+) of/.exec(user);
  return match ? Number(match[1]) : 0;
}

async function withMock(handler: (call: number, body: RequestBody) => Reply, run: (baseUrl: string, seen: RequestBody[]) => Promise<void>): Promise<void> {
  const seen: RequestBody[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
      seen.push(body);
      const reply = handler(seen.length, body);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.status === 200
        ? JSON.stringify({ choices: [{ message: { content: reply.content } }] })
        : JSON.stringify({ error: { message: reply.message ?? "error" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  try { await run(`http://127.0.0.1:${address.port}/v1`, seen); }
  finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
}

function runReview(baseUrl: string, outDir: string, diffPath: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", SCRIPT, "--diff", diffPath, "--out-dir", outDir, "--no-fix-brief"], {
      env: {
        ...process.env, LLM_API_KEY: "test-key", LLM_MODEL: "mock-model", LLM_PROVIDER: "openai", LLM_BASE_URL: baseUrl,
        LLM_RETRY_DELAY: "0", WORKERS: "1", FIX_BRIEF: "false", LLM_TEMPERATURE: "", CONSISTENCY_RUNS: "", ...extraEnv,
      },
      windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function scenario(diff: string, handler: Parameters<typeof withMock>[0], extraEnv: Record<string, string>,
  check: (r: { code: number; stdout: string; stderr: string }, out: string, seen: RequestBody[]) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "reviewbrief-e2e-"));
  const diffPath = join(dir, "pr.diff");
  writeFileSync(diffPath, diff);
  try {
    await withMock(handler, async (baseUrl, seen) => {
      const result = await runReview(baseUrl, dir, diffPath, extraEnv);
      await check(result, dir, seen);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const readFindings = (dir: string) => JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));

test("partial batch failures stay visible and exit 0", async () => {
  await scenario(THREE_FILE_DIFF, (_call, body) => {
    const part = partNumber(body);
    if (part === 3) return { status: 400, message: "bad request" };
    if (part === 2) return { status: 200, content: "Looks fine overall." };
    return { status: 200, content: '{"findings": []}' };
  }, { BATCH_CHARS: "1", MAX_BATCHES: "40" }, (r, out) => {
    const review = readFileSync(join(out, "review.md"), "utf8");
    assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(review, /Not reviewed \(2 of 3 parts failed\):/);
    assert.match(review, /two\.py/);
    assert.match(review, /three\.py/);
    assert.match(review, /No actionable findings found in the parts that were reviewed\./);
    assert.match(`${r.stdout}\n${r.stderr}`, /::warning::2 of 3 review parts failed/);
  });
});

test("every batch invalid exits 1 without false empty finding", async () => {
  await scenario(THREE_FILE_DIFF, () => ({ status: 200, content: "Looks fine overall." }),
    { BATCH_CHARS: "1", MAX_BATCHES: "40" }, (r, out) => {
      const review = readFileSync(join(out, "review.md"), "utf8");
      assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
      assert.doesNotMatch(review, /No actionable findings found\./);
      assert.match(review, /model did not return valid JSON/);
    });
});

test("invented evidence is penalised, verified evidence is rewarded, and output is reproducible", async () => {
  const reply = (): Reply => ({ status: 200, content: findingsJson(
    finding({ title: "real" }),
    finding({ id: "S2", line: 2, title: "invented", evidence: "eval(user_input)" })) });
  let first = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    await scenario(DIFF, reply, {}, (r, out) => {
      assert.equal(r.code, 0, r.stderr);
      const file = readFindings(out);
      const real = file.findings.find((s: any) => s.title === "real");
      const invented = file.findings.find((s: any) => s.title === "invented");
      assert.equal(real.confidence, 0.95);
      assert.equal(real.confidenceBreakdown.evidence, "found");
      assert.equal(real.inline, true);
      assert.equal(invented.confidence, 0.6);
      assert.equal(invented.confidenceBreakdown.evidence, "not_found");
      assert.equal(invented.inline, false);
      assert.equal(JSON.parse(readFileSync(join(out, "review-payload.json"), "utf8")).comments.length, 1);
      const text = JSON.stringify(file.findings);
      if (attempt === 0) first = text; else assert.equal(text, first);
    });
  }
});

test("two consistency runs reward agreement, penalise one-run findings, and vary only the temperature", async () => {
  const a = finding({ title: "A", confidence: "medium" });
  const b = finding({ id: "S2", title: "B", category: "quality", line: 4, confidence: "medium", evidence: "return True" });
  await scenario(DIFF, (call) => ({ status: 200, content: call === 1 ? findingsJson(a, b) : findingsJson(a) }),
    { CONSISTENCY_RUNS: "2" }, (r, out, seen) => {
      assert.equal(r.code, 0, r.stderr);
      const file = readFindings(out);
      assert.equal(file.runs, 2);
      assert.equal(file.agreementScoring, true);
      assert.equal(file.findings.find((s: any) => s.title === "A").confidence, 0.85);
      assert.equal(file.findings.find((s: any) => s.title === "B").confidence, 0.65);
      assert.deepEqual(seen.map((body) => body.temperature), [0, 0.4]);
    });
});

test("a model that rejects 'temperature' is retried once without it", async () => {
  await scenario(DIFF, (_call, body) => body.temperature !== undefined
    ? { status: 400, message: "temperature is not supported for this model" }
    : { status: 200, content: findingsJson(finding()) }, {}, (r, out, seen) => {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].temperature, 0);
    assert.equal(seen[1].temperature, undefined);
    assert.match(r.stderr, /retrying without it/);
    assert.equal(readFindings(out).findings.length, 1);
  });
});

test("LLM_TEMPERATURE=none omits the parameter entirely", async () => {
  await scenario(DIFF, () => ({ status: 200, content: findingsJson(finding()) }), { LLM_TEMPERATURE: "none" }, (r, _out, seen) => {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen[0].temperature, undefined);
  });
});

test("a failed extra run disables agreement scoring visibly", async () => {
  await scenario(DIFF, (call) => call === 1
    ? { status: 200, content: findingsJson(finding({ confidence: "medium" })) }
    : { status: 400, message: "bad request" }, { CONSISTENCY_RUNS: "2" }, (r, out) => {
    assert.equal(r.code, 0, r.stderr);
    const file = readFindings(out);
    assert.equal(file.agreementScoring, false);
    assert.equal(file.findings[0].confidenceBreakdown.agreement, "n/a");
    assert.equal(file.findings[0].confidence, 0.75);
    assert.match(r.stdout, /::warning::A batch failed in a consistency run/);
    assert.match(readFileSync(join(out, "review.md"), "utf8"), /agreement scoring was not applied/);
  });
});

test("a diff with only skipped files still writes an empty findings.json", async () => {
  await scenario(LOCKFILE_DIFF, () => ({ status: 500 }), {}, (r, out) => {
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readFindings(out).findings, []);
  });
});
