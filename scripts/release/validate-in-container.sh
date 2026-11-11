#!/usr/bin/env bash
set -Eeuo pipefail

# Runs the full local suite for one candidate SHA inside the Cezar container, which has pwsh, node, python,
# git and an authenticated gh (the Bazzite host has none of them). The host-side promotion scheduler calls this
# as its required check; the exit code is the suite's.
#
# Needs: FACTORY_CANDIDATE_SHA, FACTORY_GITHUB_REPOSITORY (owner/name). Optional: CEZAR_CONTAINER, FACTORY_CANDIDATE_BRANCH.

SHA="${FACTORY_CANDIDATE_SHA:?FACTORY_CANDIDATE_SHA is required}"
REPO="${FACTORY_GITHUB_REPOSITORY:?FACTORY_GITHUB_REPOSITORY is required}"
BRANCH="${FACTORY_CANDIDATE_BRANCH:-dev}"
CONTAINER="${CEZAR_CONTAINER:-cezar}"

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "validate-in-container: expected a full SHA, got '$SHA'" >&2; exit 2; }
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "validate-in-container: bad repository '$REPO'" >&2; exit 2; }
command -v podman >/dev/null || { echo 'validate-in-container: podman is required' >&2; exit 2; }

exec podman exec -i "$CONTAINER" bash -s -- "$SHA" "$REPO" "$BRANCH" <<'IN_CONTAINER'
set -Eeuo pipefail
sha="$1"; repo="$2"; branch="$3"
root=/projects/cezar-factory
base=/projects/.promotion
work="$base/${sha:0:12}-$$"

mkdir -p "$base"
git -C "$root" worktree prune
# Reap worktrees an interrupted run left behind (older than a day).
find "$base" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec sh -c 'git -C "$0" worktree remove --force "$1" 2>/dev/null; rm -rf "$1"' "$root" {} \;

cleanup() { git -C "$root" worktree remove --force "$work" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

git -C "$root" fetch -q "https://github.com/$repo.git" "refs/heads/$branch"
if ! git -C "$root" cat-file -e "$sha^{commit}" 2>/dev/null; then
  git -C "$root" fetch -q "https://github.com/$repo.git" "$sha"
fi
git -C "$root" worktree add -q --detach "$work" "$sha"
cd "$work"
# A fresh detached worktree has no node_modules, but the suite runs TypeScript helpers through tsx (for example the
# verification-manifest adapter behind scripts/collect-impact.ps1). Install only the cezar package's dependencies.
echo "validate-in-container: installing cezar dependencies at ${sha:0:9}"
(cd cezar && npm ci --ignore-scripts --no-audit --no-fund --workspace packages/cezar --include-workspace-root)
echo "validate-in-container: running tests/run-tests.ps1 at ${sha:0:9}"
pwsh -NoProfile -File tests/run-tests.ps1
IN_CONTAINER
