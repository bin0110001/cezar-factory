#!/usr/bin/env bash
set -Eeuo pipefail

# Runs the full local suite for one candidate SHA in a fresh, init-enabled Cezar container.
# The host-side promotion scheduler calls this as its required check. A separate PID namespace
# prevents test subprocesses from accumulating as zombies in the long-lived server container.
# The disposable container uses the server's image and network, plus only the Factory source,
# Git metadata, and shared projects volume. It does not import private home/runtime volumes or
# share the server process. SELinux separation is disabled only for this disposable container:
# mounting Cezar's private MCS-labeled volumes under a new label can break the live service.
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
PROJECTS_VOLUME="$(podman inspect "$CONTAINER" --format '{{range .Mounts}}{{if and (eq .Type "volume") (eq .Destination "/projects")}}{{.Name}}{{end}}{{end}}')"
PROJECT_SOURCE="$(podman inspect "$CONTAINER" --format '{{range .Mounts}}{{if and (eq .Type "bind") (eq .Destination "/projects/cezar-factory")}}{{.Source}}{{end}}{{end}}')"
GIT_META_VOLUME="$(podman inspect "$CONTAINER" --format '{{range .Mounts}}{{if and (eq .Type "volume") (eq .Destination "/projects/cezar-factory/.git")}}{{.Name}}{{end}}{{end}}')"
[[ "$PROJECTS_VOLUME" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "validate-in-container: could not resolve the shared projects volume for '$CONTAINER'" >&2; exit 2; }
[[ "$GIT_META_VOLUME" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "validate-in-container: could not resolve the Factory Git metadata volume for '$CONTAINER'" >&2; exit 2; }
if [[ -z "$PROJECT_SOURCE" ]] || [[ ! -d "$PROJECT_SOURCE" ]]; then
  echo "validate-in-container: could not resolve the Factory source bind mount for '$CONTAINER'" >&2
  exit 2
fi

echo "validate-in-container: installing cezar dependencies at ${SHA:0:9}"
echo "validate-in-container: running tests in an init-enabled container at ${SHA:0:9}"
# Reuse only the source, Git metadata, and projects volumes. Do not use --volumes-from: it
# imports private runtime/home volumes, and a new container label can relabel those shared with
# Cezar. The /projects mount keeps validation worktrees visible while preserving volume labels.
podman run --rm --init --security-opt label=disable \
  --volume "$PROJECTS_VOLUME:/projects" \
  --volume "$PROJECT_SOURCE:$ROOT" \
  --volume "$GIT_META_VOLUME:$ROOT/.git" \
  --network "$NETWORK" \
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
    pwsh -NoProfile -File tests/run-tests.ps1
  ' bash "$SHA" "$REPO" "$BRANCH"
