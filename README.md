# ReviewBrief

AI-powered pull request review for GitHub that works with **any model** (OpenAI, Claude, DeepSeek, OpenRouter, Ollama, anything OpenAI-compatible), **doesn't truncate large PRs**, and writes a **fix brief**: a markdown prompt you can hand to an AI coding assistant to apply the fixes.

- **Large PRs:** the diff is split per file (and per hunk for huge files), reviewed in batches, then merged into one review. Skipped files and failed batches are listed in the comment, never silently dropped.
- **Structured findings:** the model returns canonical Findings, which ReviewBrief renders into concise inline comments and GitHub suggestions.
- **Any provider:** two protocols cover nearly everything: `openai` (OpenAI-compatible) and `anthropic`.
- **Fix brief:** `fix-brief.md` lists each actionable finding with file, problem, suggested fix and a "done when" check, plus rules that tell the assistant to verify each finding before changing anything.
- **TypeScript runtime:** the review pipeline, canonical Finding model, and renderers run on Node.js 22 without third-party packages.

## What's in the box

```
action.yml                 composite GitHub Action
src/reviewbrief.ts         review engine (also runs standalone)
src/findings.ts            canonical Finding types and GitHub renderer
scripts/review-pr.sh       run it against an existing PR from your machine
scripts/calibrate.ts       confidence calibration harness
test/                      unit and end-to-end tests
examples/reviewbrief.yml   workflow that uses the action
.env.example               config template for local runs
```

---

## 1. Try it on an existing PR (no workflow needed)

You need the [GitHub CLI](https://cli.github.com) (`gh auth login` done), Node.js 22.6+, and an API key.

```bash
cp .env.example .env        # then fill in LLM_API_KEY and LLM_MODEL (and LLM_PROVIDER if not openai)

# See how the diff would be split, without calling any LLM (no key needed):
scripts/review-pr.sh 123 --repo OWNER/NAME --dry-run

# Run the review. Prints it and saves it; does NOT post to GitHub:
scripts/review-pr.sh 123 --repo OWNER/NAME

# Same, from a PR URL:
scripts/review-pr.sh https://github.com/OWNER/NAME/pull/123

# Post the result as a PR comment once you're happy with it:
scripts/review-pr.sh 123 --repo OWNER/NAME --post

# Try a different model without editing .env:
scripts/review-pr.sh 123 --repo OWNER/NAME --provider anthropic --model <model-name>
```

Output goes to `./reviewbrief-out/pr-123/`: `review.md`, `fix-brief.md` (if anything was actionable), and the raw `pr.diff`.
The renderer also writes `review-payload.json` (confidence-filtered inline GitHub review comments) and `findings.json` (every scored finding with its confidence breakdown).

Notes:
- Inside a clone of the repo you can omit `--repo`.
- `gh pr diff` is limited by GitHub's API (about 300 files). If it fails and you're inside a clone whose `origin` is that repo, the script falls back to a local `git diff` automatically.
- Variables already exported in your shell win over `.env`.

You can also call the engine directly on any diff:

```bash
git diff main...HEAD | node --experimental-strip-types src/reviewbrief.ts --out-dir out
node --experimental-strip-types src/reviewbrief.ts --diff my.diff --dry-run
```

---

## 2. Run it on every PR (GitHub Actions)

Call the action that already lives in [kadraman/reviewbrief](https://github.com/kadraman/reviewbrief). Once it is listed on the GitHub Marketplace, install it from that listing. Either way the workflow line is:

```yaml
uses: kadraman/reviewbrief@v1
```

Pin `@v1`, or a commit SHA, so a moving branch cannot change the review.

1. In the repo you want reviewed, add **Settings → Secrets and variables → Actions**:

   | Name | Type | Notes |
   |---|---|---|
   | `LLM_API_KEY` | Secret | your provider's API key |
   | `LLM_MODEL` | Variable | required; model name as your provider expects it |
   | `LLM_PROVIDER` | Variable | `openai` (default) or `anthropic` |
   | `LLM_BASE_URL` | Variable | optional API root override |

2. Copy [`examples/reviewbrief.yml`](examples/reviewbrief.yml) to `.github/workflows/reviewbrief.yml` in that repo. It already uses `kadraman/reviewbrief@v1`.

Use `actions/checkout` with `fetch-depth: 0` (the example does) so very large diffs aren't limited by GitHub's API.

### Provider examples

| Provider | `LLM_PROVIDER` | `LLM_BASE_URL` |
|---|---|---|
| Claude | `anthropic` | *(blank)* |
| OpenAI | `openai` | *(blank)* |
| DeepSeek | `openai` | `https://api.deepseek.com` |
| OpenRouter | `openai` | `https://openrouter.ai/api/v1` |
| Ollama (self-hosted runner) | `openai` | `http://localhost:11434/v1` |

Model names change often. Check your provider's docs for the current ones.

### Action inputs

| Input | Default | Meaning |
|---|---|---|
| `api-key` | required | provider API key |
| `model` | required | model name |
| `provider` | `openai` | `openai` or `anthropic` |
| `base-url` | | API root override |
| `temperature` | `0` | sampling temperature; set to `none` to omit the parameter (some models reject it) |
| `consistency-runs` | `1` | independent review passes (1–5); later runs use `CONSISTENCY_TEMPERATURE` (default `0.4`) for agreement scoring |
| `max-output-tokens` | `8192` | required by the Anthropic API |
| `batch-chars` | `100000` | max diff characters packed per API call (~25k tokens); lower it for small-context models |
| `piece-chars` | `20000` | max characters per file piece before hunk-splitting; large files are split even when under `batch-chars` |
| `max-batches` | `40` | cost guard; extra batches are listed as "not reviewed" |
| `minimum-confidence` | `0.85` | confidence floor for inline comments; inline also requires severity `critical` or `high` (`medium`/`low`/`info` stay overview-only) |
| `max-inline-comments` | `0` (all) | optional cap on inline comments; `0` means no cap |
| `workers` | `3` | parallel API calls |
| `fix-brief` | `true` | also produce `fix-brief.md` |
| `post-comment` | `true` | post the review as a PR comment |
| `github-token` | `github.token` | needs `pull-requests: write` |

Outputs: `review-path`, `fix-brief-path`, `fix-brief-url`, `findings-path`, `findings-url`.

---

## Using the results

The action uploads two artifacts and keeps each for 14 days. The pull request comment links to whichever of them exist.

| Artifact | File | Contents |
|---|---|---|
| `fix-brief-pr-<number>` | `fix-brief.md` | Prompt for an assistant. Uploaded when something actionable was found. |
| `findings-pr-<number>` | `findings.json` | Every scored finding: file, line range, severity, evidence quote, suggestion, and confidence breakdown. |

`fix-brief.md` is what you hand to an assistant that should re-read the code and decide what to change. `findings.json` is what an agent needs to apply a suggestion or to skip a finding whose evidence did not check out. The workflow token needs `actions: write` so these uploads succeed; `examples/reviewbrief.yml` sets that.

Download them on a machine where `gh` is authenticated against the repo. `RUN_ID` is the Actions run that reviewed the pull request. A later push starts a new run and a new pair of artifacts with the same names, so download that run.

```bash
gh run download RUN_ID --repo OWNER/NAME --name fix-brief-pr-123
gh run download RUN_ID --repo OWNER/NAME --name findings-pr-123
```

Check out the pull request branch and give the brief to your assistant. For example, with Claude Code:

```bash
claude -p "$(cat fix-brief.md)"
```

or paste/attach it in Copilot, Cursor, or a chat session. The brief tells the assistant to verify each finding first, keep changes minimal, run the tests, and report what it fixed and skipped. The findings come from an LLM reading diffs in separate batches, so **read the brief before running it** and review the resulting changes like any other PR.

---

## How large diffs are handled

1. Split the diff by file; lockfiles, minified files and binaries are skipped (and listed).
2. A file larger than `piece-chars` (capped by `batch-chars`) is split on hunk boundaries (and on line boundaries inside giant hunks); every part keeps the file header. Split parts are reviewed alone so they are not packed back into one oversized call.
3. Other pieces are packed into batches up to `batch-chars`.
4. Each batch is reviewed in its own call (retrying 429/5xx/529 with backoff). If the model still returns invalid JSON (or the request fails), the batch is split further and retried up to two times.
5. Each response is parsed into the canonical Finding schema. Confidence is computed in code from the model's high/medium/low level plus checked evidence (and optional agreement across consistency runs). Inline comments are deduplicated with highest confidence winning, then gated to severity `critical`/`high` above `minimum-confidence` (medium and below are overview-only) and ranked deterministically by severity, confidence, file, line, title, and category. The prompt asks the model to skip style, typing, and docs nits so fewer low-value findings are emitted.

Limitations: batches are reviewed independently, so problems that span files in different batches can be missed. Cost scales with PR size; `max-batches` caps it. If **every** batch fails (bad key, wrong model name), the run fails instead of posting an error comment.

---

## Security notes

- The diff is sent to your LLM provider. Check that's acceptable for private code.
- Don't wire this to `pull_request_target` with a checkout of the PR head; that would run an untrusted PR with your secrets in reach. The provided workflow uses `pull_request` and skips fork PRs (GitHub withholds secrets from them anyway).
- PR title/body are passed through environment variables, never interpolated into shell code, and the model is told the diff is untrusted data. A determined prompt injection can still skew a review, so treat output as advice.
- Pin the action to a release tag or commit SHA in your workflow.
- Keep `.env` out of git (it's in `.gitignore`).

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `LLM_API_KEY is not set` | Secret missing, or the PR is from a fork (secrets aren't available) |
| `LLM_MODEL is not set` | Add the `LLM_MODEL` repository variable |
| `HTTP 404` / `model not found` | Wrong model name or `LLM_BASE_URL` |
| `HTTP 400` mentioning `temperature` | The engine retries once without it; set `temperature` to `none` to omit it from the start |
| `HTTP 429` repeatedly | Lower `workers`, or raise your provider's rate limit |
| `Review failed for this part` in the comment | That batch errored after retries; the files are named in the message |
| Context-length errors | Lower `batch-chars` |
| `git diff failed` in the action log | Shallow checkout; use `fetch-depth: 0` |

Releasing and Marketplace publishing are in [DEVELOPMENT.md](DEVELOPMENT.md).
