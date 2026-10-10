#!/usr/bin/env bash
# GODOT_BIN: runs the Godot version the current project is pinned to.
#
# The pin is the first `.godot-version` file found walking up from the working directory
# (contents like `4.7-stable`), so a task in a worktree uses whatever its branch pins. With no
# pin, GODOT_DEFAULT_VERSION (the image baseline) is used. A version that is not installed yet
# is downloaded on demand into GODOT_VERSIONS_DIR (see godot-install).
# GODOT_VERSION_OVERRIDE forces a version for one invocation.
set -Eeuo pipefail

tag="${GODOT_VERSION_OVERRIDE:-}"
if [ -z "$tag" ]; then
  dir="$PWD"
  while :; do
    if [ -f "$dir/.godot-version" ]; then tag="$(tr -d ' \r\n\t' < "$dir/.godot-version")"; break; fi
    [ "$dir" = / ] && break
    dir="$(dirname "$dir")"
  done
fi
tag="${tag:-${GODOT_DEFAULT_VERSION:?GODOT_DEFAULT_VERSION is not set}}"

bin="$(godot-install "$tag")"
exec "$bin" "$@"
