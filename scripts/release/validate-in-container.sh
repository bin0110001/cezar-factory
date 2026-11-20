#!/usr/bin/env bash
set -Eeuo pipefail

# Runs the full local suite for one candidate SHA in a fresh, init-enabled Cezar container.
# The host-side promotion scheduler calls this as its required check. A separate PID namespace
# prevents test subprocesses from accumulating as zombies in the long-lived server container.
# The disposable container uses the server container's image, mounts, and named network, but it
# does not exec into or share the server's PID/network namespace. Validation can therefore finish
# even if the Cezar server process is stopped or restarts during the suite.
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
IMAGE="$(podman inspect "$CONTAINER" --format '{{.Image}}')"
[[ "$IMAGE" =~ ^[0-9a-f]{64}$ ]] || { echo "validate-in-container: could not resolve image for '$CONTAINER'" >&2; exit 2; }
NETWORKS="$(podman inspect "$CONTAINER" --format '{{range $name, $network := .NetworkSettings.Networks}}{{$name}} {{end}}' | xargs)"
NETWORK="${NETWORKS%% *}"
[[ "$NETWORK" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "validate-in-container: could not resolve a named network for '$CONTAINER'" >&2; exit 2; }

echo "validate-in-container: installing cezar dependencies at ${SHA:0:9}"
echo "validate-in-container: running tests in an init-enabled container at ${SHA:0:9}"
# Reuse the server's image and mounts, but give each suite its own PID namespace, init process,
# and network attachment. The source container may be stopped; its named volumes remain mounted.
podman run --rm --init --volumes-from "$CONTAINER" --network "$NETWORK" \
  --user 10001:10001 --env HOME=/home/cezar --env CEZ_HOME=/home/cezar/.cezar \
  --env FACTORY_RUNTIME_ROOT="$ROOT" --env FACTORY_RUNTIME_SOURCE_ROOT="$ROOT" \
  --workdir "$ROOT" --entrypoint bash "$IMAGE" -lc '
    set -Eeuo pipefail
    sha="$1"; repository="$2"; branch="$3"
    root=/projects/cezar-factory
    base=/projects/.promotion
    work="$base/${sha:0:12}-$$"
    mkdir -p "$base"
    git -C "$root" worktree prune
    # Reap worktrees an interrupted run left behind (older than a day), then prune their Git metadata.
    find "$base" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rm -rf -- {} +
    git -C "$root" worktree prune
    cleanup() {
      git -C "$root" worktree remove --force "$work" >/dev/null 2>&1 || true
      rm -rf "$work" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT
    git -C "$root" fetch -q "https://github.com/$repository.git" "refs/heads/$branch"
    if ! git -C "$root" cat-file -e "$sha^{commit}" 2>/dev/null; then
      git -C "$root" fetch -q "https://github.com/$repository.git" "$sha"
    fi
    git -C "$root" worktree add -q --detach "$work" "$sha"
    cd "$work/cezar"
    npm ci --ignore-scripts --no-audit --no-fund --cache /projects/.promotion/.npm-cache --workspace packages/cezar --include-workspace-root
    cd "$work"
    # Isolate git from the inherited environment and record what git sees (#758).
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*"
    echo "validate-in-container: git $(git --version) toplevel=$(git rev-parse --show-toplevel 2>&1) uid=$(id -u) home=${HOME:-}"
    git check-ignore -q integrations/mcp-gateway/.env && echo "validate-in-container: .env ignored" || echo "validate-in-container: check-ignore exit $?"
    pwsh -NoProfile -File tests/run-tests.ps1
  ' bash "$SHA" "$REPO" "$BRANCH"
