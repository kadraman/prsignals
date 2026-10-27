import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(ROOT, "reviewbrief.ts");

const THREE_FILE_DIFF = [
  "diff --git a/one.py b/one.py", "index 111..222 100644", "--- a/one.py", "+++ b/one.py",
  "@@ -1,1 +1,2 @@", " keep", "+added-one",
  "diff --git a/two.py b/two.py", "index 111..222 100644", "--- a/two.py", "+++ b/two.py",
  "@@ -1,1 +1,2 @@", " keep", "+added-two",
  "diff --git a/three.py b/three.py", "index 111..222 100644", "--- a/three.py", "+++ b/three.py",
  "@@ -1,1 +1,2 @@", " keep", "+added-three",
].join("\n");

type Mode = "partial-fail" | "all-prose";

function partNumber(body: string): number {
  const match = /This is part (\d+) of/.exec(body);
  return match ? Number(match[1]) : 0;
}

function openaiJson(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

async function withMockServer(mode: Mode, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let user = "";
      try {
        const parsed = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
        user = parsed.messages?.find((m) => m.role === "user")?.content ?? "";
      } catch { /* ignore */ }
      const part = partNumber(user);
      if (mode === "all-prose") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(openaiJson("Looks fine overall."));
        return;
      }
      if (part === 3) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad request" } }));
        return;
      }
      if (part === 2) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(openaiJson("Looks fine overall."));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(openaiJson('{"findings": []}'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

function runReview(baseUrl: string, outDir: string, diffPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", SCRIPT,
      "--diff", diffPath, "--out-dir", outDir, "--no-fix-brief"], {
      env: {
        ...process.env,
        LLM_API_KEY: "test-key",
        LLM_MODEL: "mock-model",
        LLM_PROVIDER: "openai",
        LLM_BASE_URL: baseUrl,
        LLM_RETRY_DELAY: "0",
        BATCH_CHARS: "1",
        MAX_BATCHES: "40",
        WORKERS: "1",
        FIX_BRIEF: "false",
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

test("e2e: partial batch failures stay visible and exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reviewbrief-e2e-"));
  const diffPath = join(dir, "pr.diff");
  writeFileSync(diffPath, THREE_FILE_DIFF);
  try {
    await withMockServer("partial-fail", async (baseUrl) => {
      const { code, stdout, stderr } = await runReview(baseUrl, dir, diffPath);
      const review = readFileSync(join(dir, "review.md"), "utf8");
      assert.equal(code, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);
      assert.match(review, /Not reviewed \(2 of 3 parts failed\):/);
      assert.match(review, /two\.py/);
      assert.match(review, /three\.py/);
      assert.match(review, /No actionable findings found in the parts that were reviewed\./);
      assert.match(`${stdout}\n${stderr}`, /::warning::2 of 3 review parts failed/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: every batch invalid exits 1 without false empty finding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reviewbrief-e2e-"));
  const diffPath = join(dir, "pr.diff");
  writeFileSync(diffPath, THREE_FILE_DIFF);
  try {
    await withMockServer("all-prose", async (baseUrl) => {
      const { code, stdout, stderr } = await runReview(baseUrl, dir, diffPath);
      const review = readFileSync(join(dir, "review.md"), "utf8");
      assert.equal(code, 1, `stdout:\n${stdout}\nstderr:\n${stderr}`);
      assert.doesNotMatch(review, /No actionable findings found\./);
      assert.match(review, /model did not return valid JSON/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
