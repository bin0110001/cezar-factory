#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${FACTORY_TEST_TMPDIR:-$ROOT/.factory}"
mkdir -p "$TMP_ROOT"
TMP="$(mktemp -d "$TMP_ROOT/reconcile-container-git.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$TMP/repo/scripts/deploy" "$TMP/bin"
git init --bare "$TMP/origin.git" >/dev/null
cp "$ROOT/scripts/deploy/reconcile-container-git-metadata.sh" "$TMP/repo/scripts/deploy/"
chmod +x "$TMP/repo/scripts/deploy/reconcile-container-git-metadata.sh"
git -C "$TMP/repo" init -b stable >/dev/null
git -C "$TMP/repo" config user.name test
git -C "$TMP/repo" config user.email test@example.invalid
case "$(uname -s)" in
  MINGW*|MSYS*) git -C "$TMP/repo" config core.filemode false ;;
  *) git -C "$TMP/repo" config core.filemode true ;;
esac
git -C "$TMP/repo" config core.autocrlf false
printf 'base\n' > "$TMP/repo/tracked.txt"
git -C "$TMP/repo" add .
git -C "$TMP/repo" commit -m initial >/dev/null
OLD_SHA="$(git -C "$TMP/repo" rev-parse HEAD)"

git -C "$TMP/repo" worktree add -b task-preserved "$TMP/task-worktree" "$OLD_SHA" >/dev/null
printf 'stable source\n' > "$TMP/repo/tracked.txt"
printf 'new stable file\n' > "$TMP/repo/new-source.txt"
git -C "$TMP/repo" add tracked.txt new-source.txt
git -C "$TMP/repo" commit -m promoted >/dev/null
TARGET_SHA="$(git -C "$TMP/repo" rev-parse HEAD)"
git -C "$TMP/repo" remote add origin "$TMP/origin.git"
git -C "$TMP/repo" push -u origin stable >/dev/null

# Simulate the host checkout advancing files while the container's private
# .git volume still points to the old root commit and index.
git -C "$TMP/repo" reset --mixed "$OLD_SHA" >/dev/null
printf 'preserve this operator data\n' > "$TMP/repo/operator-note.txt"
printf '#!/usr/bin/env sh\nexit 0\n' > "$TMP/bin/flock"
chmod +x "$TMP/bin/flock"
export PATH="$TMP/bin:$PATH"
export FACTORY_RUNTIME_ROOT="$TMP/repo"
SCRIPT="$TMP/repo/scripts/deploy/reconcile-container-git-metadata.sh"
bash -n "$SCRIPT"
bash "$SCRIPT" "$TARGET_SHA"

[[ "$(git -C "$TMP/repo" rev-parse HEAD)" == "$TARGET_SHA" ]] || fail 'root stable metadata did not advance to the promoted SHA'
git -C "$TMP/repo" diff-index --cached --quiet HEAD -- || fail 'root index does not match the promoted SHA'
[[ "$(cat "$TMP/repo/tracked.txt")" == 'stable source' ]] || fail 'tracked source file changed during metadata reconciliation'
[[ "$(cat "$TMP/repo/new-source.txt")" == 'new stable file' ]] || fail 'new promoted file changed during metadata reconciliation'
[[ "$(cat "$TMP/repo/operator-note.txt")" == 'preserve this operator data' ]] || fail 'untracked operator data was changed'
[[ "$(git -C "$TMP/task-worktree" rev-parse HEAD)" == "$OLD_SHA" ]] || fail 'linked task worktree was moved'
[[ "$(git -C "$TMP/repo" rev-parse refs/heads/task-preserved)" == "$OLD_SHA" ]] || fail 'task branch ref was changed'
[[ "$(git -C "$TMP/repo" branch --show-current)" == stable ]] || fail 'root branch identity changed'

# A real file conflict must refuse before changing the root branch or index.
printf 'future source\n' > "$TMP/repo/tracked.txt"
git -C "$TMP/repo" add tracked.txt
git -C "$TMP/repo" commit -m next-source >/dev/null
CONFLICT_SHA="$(git -C "$TMP/repo" rev-parse HEAD)"
git -C "$TMP/repo" push origin stable >/dev/null
git -C "$TMP/repo" reset --mixed "$TARGET_SHA" >/dev/null
printf 'local conflicting data\n' > "$TMP/repo/tracked.txt"
set +e
bash "$SCRIPT" "$CONFLICT_SHA" > "$TMP/conflict.log" 2>&1
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'conflicting mounted file was accepted'
[[ "$(git -C "$TMP/repo" rev-parse HEAD)" == "$TARGET_SHA" ]] || fail 'failed reconciliation moved the root branch'
[[ "$(cat "$TMP/repo/tracked.txt")" == 'local conflicting data' ]] || fail 'failed reconciliation changed conflicting file data'

echo 'Container Git metadata reconciliation tests passed.'
