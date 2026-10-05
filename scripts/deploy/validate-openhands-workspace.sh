#!/usr/bin/env bash
set -Eeuo pipefail

container="${OPENHANDS_CONTAINER:-cezar-factory-openhands}"
workspace="${OPENHANDS_WORKSPACE:-/projects/cezar-factory}"
require_origin=false

usage() {
  echo "usage: validate-openhands-workspace.sh [--require-origin]" >&2
}

while (($#)); do
  case "$1" in
    --require-origin) require_origin=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

git_exec() {
  podman exec "$container" git -C "$workspace" "$@"
}

git_exec rev-parse --is-inside-work-tree | grep -qx true || {
  echo "OpenHands workspace is not a Git worktree: $workspace" >&2
  exit 1
}

head="$(git_exec rev-parse --verify HEAD 2>/dev/null)" || {
  echo "OpenHands workspace has no valid HEAD: $workspace" >&2
  exit 1
}

if [[ -n "$(git_exec status --porcelain)" ]]; then
  echo "OpenHands base workspace is dirty: $workspace" >&2
  exit 1
fi

if [[ "$require_origin" == true ]]; then
  origin="$(git_exec remote get-url origin 2>/dev/null)" || {
    echo "OpenHands workspace has no origin remote: $workspace" >&2
    exit 1
  }
  printf 'openhands-workspace: container=%s workspace=%s head=%s origin=%s\n' \
    "$container" "$workspace" "$head" "$origin"
else
  printf 'openhands-workspace: container=%s workspace=%s head=%s\n' \
    "$container" "$workspace" "$head"
fi
