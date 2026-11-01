#!/usr/bin/env bash
# Pushes the current branch, opens its pull request, waits for CI and merges it
# with a merge commit, so the atomic commits stay in main's history.
# Usage: scripts/pr.sh "<title>" [body-file]
set -euo pipefail

title=${1:?usage: scripts/pr.sh "<title>" [body-file]}
body=${2:-}
branch=$(git branch --show-current)
[[ $branch != main ]] || { echo "Run it from a feature branch, not main." >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "Commit or stash your changes first." >&2; exit 1; }

git push -u origin "$branch"
if [[ -n $body ]]; then
  gh pr create --base main --head "$branch" --title "$title" --body-file "$body"
else
  gh pr create --base main --head "$branch" --title "$title" --fill-verbose
fi

# Checks take a few seconds to register after the PR opens.
sleep 15
gh pr checks "$branch" --watch --fail-fast
gh pr merge "$branch" --merge --delete-branch

git switch main
git pull --ff-only
