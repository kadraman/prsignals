#!/usr/bin/env bash
# Compute the two diffs a review needs.
#   pr.diff      what the model reads: the newest commits on a push (incremental) or the whole PR, with extra context lines
#   anchor.diff  GitHub's own view of the whole PR diff; inline comments are only valid on its lines
#
# Inputs (environment): OUT_DIR, BASE_REF, PR_HEAD_SHA (required); PR_ACTION, BEFORE_SHA, DIFF_CONTEXT_LINES, PR_NUMBER (optional).
# Outputs: $OUT_DIR/pr.diff, $OUT_DIR/anchor.diff, $OUT_DIR/scope.txt ("incremental" or "full"), and `scope=` in $GITHUB_OUTPUT.
set -euo pipefail

: "${OUT_DIR:?OUT_DIR is required}" "${BASE_REF:?BASE_REF is required}" "${PR_HEAD_SHA:?PR_HEAD_SHA is required}"
CONTEXT_LINES="${DIFF_CONTEXT_LINES:-10}"
[[ "$CONTEXT_LINES" =~ ^[0-9]+$ ]] || { echo "DIFF_CONTEXT_LINES must be a non-negative integer" >&2; exit 1; }
mkdir -p "$OUT_DIR"

git fetch --no-tags --quiet origin "$BASE_REF" 2>/dev/null || true
base="origin/${BASE_REF}"

# Review only the newest commits when this is a push to an open PR and the previous head is still an ancestor of the
# new head. After a force-push or rebase it is not, and a range from it would drag in unrelated changes: review all.
scope="full"; review_base="$base"
if [ "${PR_ACTION:-}" = "synchronize" ] && [ -n "${BEFORE_SHA:-}" ] \
   && git cat-file -e "${BEFORE_SHA}^{commit}" 2>/dev/null \
   && git merge-base --is-ancestor "$BEFORE_SHA" "$PR_HEAD_SHA" 2>/dev/null; then
  scope="incremental"; review_base="$BEFORE_SHA"
fi

# Use the PR head commit, not HEAD: on pull_request events HEAD is GitHub's synthetic merge of the PR into the base,
# and a range ending there also contains every base-branch change the author did not write.
if git diff --no-color "${base}...${PR_HEAD_SHA}" > "$OUT_DIR/anchor.diff" 2>/dev/null \
   && git diff --no-color -U"$CONTEXT_LINES" "${review_base}...${PR_HEAD_SHA}" > "$OUT_DIR/pr.diff" 2>/dev/null; then
  :
else
  echo "git diff failed (shallow checkout?); falling back to GitHub's API diff for both files." >&2
  gh pr diff "${PR_NUMBER:?PR_NUMBER is required for the fallback}" > "$OUT_DIR/anchor.diff"
  cp "$OUT_DIR/anchor.diff" "$OUT_DIR/pr.diff"
  scope="full"
fi

echo "$scope" > "$OUT_DIR/scope.txt"
[ -z "${GITHUB_OUTPUT:-}" ] || echo "scope=$scope" >> "$GITHUB_OUTPUT"
echo "diff scope: $scope (review $(wc -c < "$OUT_DIR/pr.diff" | tr -d ' ') bytes, anchor $(wc -c < "$OUT_DIR/anchor.diff" | tr -d ' ') bytes)"
