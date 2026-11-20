#!/usr/bin/env bash
set -Eeuo pipefail

# Runs the full local suite for one candidate SHA in a fresh, init-enabled Cezar container.
# The long-lived Cezar server has pwsh, node, python and git; the host-side promotion scheduler
# calls this as its required check. A separate PID namespace prevents test subprocesses from
# accumulating as zombies in the server container across validation runs.
#
# Needs: FACTORY_CANDIDATE_SHA, FACTORY_GITHUB_REPOSITORY (owner/name). Optional: CEZAR_CONTAINER, FACTORY_CANDIDATE_BRANCH.

SHA="${FACTORY_CANDIDATE_SHA:?FACTORY_CANDIDATE_SHA is required}"
REPO="${FACTORY_GITHUB_REPOSITORY:?FACTORY_GITHUB_REPOSITORY is required}"
BRANCH="${FACTORY_CANDIDATE_BRANCH:-dev}"
CONTAINER="${CEZAR_CONTAINER:-cezar}"

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "validate-in-container: expected a full SHA, got '$SHA'" >&2; exit 2; }
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "validate-in-container: bad repository '$REPO'" >&2; exit 2; }
command -v podman >/dev/null || { echo 'validate-in-container: podman is required' >&2; exit 2; }
ROOT=/projects/cezar-factory
BASE=/projects/.promotion
WORK="$BASE/${SHA:0:12}-$$"
IMAGE="$(podman inspect "$CONTAINER" --format '{{.Image}}')"
[[ "$IMAGE" =~ ^[0-9a-f]{64}$ ]] || { echo "validate-in-container: could not resolve image for '$CONTAINER'" >&2; exit 2; }

podman exec "$CONTAINER" mkdir -p "$BASE"
podman exec "$CONTAINER" git -C "$ROOT" worktree prune
# Reap worktrees an interrupted run left behind (older than a day).
podman exec "$CONTAINER" find "$BASE" -mindepth 1 -maxdepth 1 -type d -mmin +1440 \
  -exec sh -c 'git -C "$0" worktree remove --force "$1" 2>/dev/null; rm -rf "$1"' "$ROOT" {} \;

cleanup() {
  podman exec "$CONTAINER" git -C "$ROOT" worktree remove --force "$WORK" >/dev/null 2>&1 || true
  podman exec "$CONTAINER" rm -rf "$WORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

podman exec "$CONTAINER" git -C "$ROOT" fetch -q "https://github.com/$REPO.git" "refs/heads/$BRANCH"
if ! podman exec "$CONTAINER" git -C "$ROOT" cat-file -e "$SHA^{commit}" 2>/dev/null; then
  podman exec "$CONTAINER" git -C "$ROOT" fetch -q "https://github.com/$REPO.git" "$SHA"
fi
podman exec "$CONTAINER" git -C "$ROOT" worktree add -q --detach "$WORK" "$SHA"

echo "validate-in-container: installing cezar dependencies at ${SHA:0:9}"
echo "validate-in-container: running tests in an init-enabled container at ${SHA:0:9}"
# Reuse the server's toolchain and mounts, but give each full suite its own PID namespace and
# init process. `--init` reaps orphaned children; `--volumes-from` keeps the exact-SHA worktree,
# shared Git metadata and npm cache available at their existing paths.
podman run --rm --init --volumes-from "$CONTAINER" --network "container:$CONTAINER" \
  --user 10001:10001 --workdir "$WORK" --entrypoint bash "$IMAGE" -lc '
    set -Eeuo pipefail
    sha="$1"; work="$2"
    cd "$work/cezar"
    npm ci --ignore-scripts --no-audit --no-fund --cache /projects/.promotion/.npm-cache --workspace packages/cezar --include-workspace-root
    cd "$work"
    pwsh -NoProfile -File tests/run-tests.ps1
  ' bash "$SHA" "$WORK"
