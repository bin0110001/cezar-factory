#!/usr/bin/env bash
set -Eeuo pipefail

# Advance only the root stable branch/index in Cezar's private .git volume.
# The source checkout is a read-only bind mount; task worktrees live elsewhere
# in the same Git metadata store and must remain untouched.
ROOT="${FACTORY_RUNTIME_ROOT:-/projects/cezar-factory}"
SOURCE_SHA="${1:-}"
die() { echo "reconcile-container-git-metadata: $*" >&2; exit 1; }

[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'expected the promoted source SHA'
[[ -d "$ROOT/.git" ]] || die "expected writable repository metadata at $ROOT/.git"
command -v git >/dev/null || die 'git is required'
command -v flock >/dev/null || die 'flock is required'

git_dir="$(git -C "$ROOT" rev-parse --absolute-git-dir)"
exec 9>"$git_dir/factory-runtime-sync.lock"
flock -n 9 || die 'another Factory metadata reconciliation is running'

git -C "$ROOT" remote get-url origin >/dev/null 2>&1 || die 'origin remote is not configured'
git -C "$ROOT" fetch --quiet --no-tags origin stable || die 'could not fetch stable into the metadata volume'
fetched_sha="$(git -C "$ROOT" rev-parse FETCH_HEAD)"
[[ "$fetched_sha" == "$SOURCE_SHA" ]] || die "origin/stable advanced to $fetched_sha while host requested $SOURCE_SHA; retry from the latest stable SHA"
git -C "$ROOT" cat-file -e "$SOURCE_SHA^{commit}" 2>/dev/null || die "source commit $SOURCE_SHA is unavailable in the metadata volume"

head_ref="$(git -C "$ROOT" symbolic-ref -q HEAD || true)"
[[ "$head_ref" == refs/heads/stable ]] || die "root worktree is on '${head_ref:-detached HEAD}', expected refs/heads/stable"
stable_worktrees="$(git -C "$ROOT" worktree list --porcelain | grep -c '^branch refs/heads/stable$' || true)"
[[ "$stable_worktrees" == 1 ]] || die "expected exactly one worktree on refs/heads/stable, found $stable_worktrees"
current_sha="$(git -C "$ROOT" rev-parse HEAD)"
if [[ "$current_sha" == "$SOURCE_SHA" ]]; then
  echo "reconcile-container-git-metadata: already at $SOURCE_SHA"
  exit 0
fi
git -C "$ROOT" merge-base --is-ancestor "$current_sha" "$SOURCE_SHA" || die "refusing non-fast-forward metadata change $current_sha -> $SOURCE_SHA"
git -C "$ROOT" cat-file -e "$current_sha^{commit}" 2>/dev/null || die "current root commit $current_sha is unavailable"

# Never discard staged root-worktree data. Unstaged differences from the old
# root commit are expected after the host bind mount advances; the exact target
# tree check below proves the new mounted files match the promoted commit.
git -C "$ROOT" diff-index --cached --quiet HEAD -- || die 'root Git index has staged changes; preserving it'
[[ -z "$(git -C "$ROOT" ls-files -u)" ]] || die 'root Git index has unresolved entries'

verify_mounted_tree() {
  local target_sha="$1" checked=0 entry metadata path mode rest object_type object_sha actual_sha
  while IFS= read -r -d '' entry; do
    metadata="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    mode="${metadata%% *}"
    rest="${metadata#* }"
    object_type="${rest%% *}"
    object_sha="${rest##* }"

    case "$object_type" in
      blob)
        actual_sha=''
        if [[ "$mode" == 120000 ]]; then
          [[ -L "$ROOT/$path" ]] || { echo "mounted symlink is missing: $path" >&2; return 1; }
          actual_sha="$(readlink -- "$ROOT/$path" | git -C "$ROOT" hash-object --stdin)"
        else
          [[ -f "$ROOT/$path" && ! -L "$ROOT/$path" ]] || { echo "mounted file is missing or changed type: $path" >&2; return 1; }
          actual_sha="$(git -C "$ROOT" hash-object --path="$path" "$ROOT/$path")"
          if [[ "$mode" == 100755 ]]; then
            [[ -x "$ROOT/$path" ]] || { echo "mounted executable bit is missing: $path" >&2; return 1; }
          fi
        fi
        [[ "$actual_sha" == "$object_sha" ]] || { echo "mounted content differs from promoted commit at $path" >&2; return 1; }
        ;;
      commit)
        [[ -d "$ROOT/$path" ]] || { echo "mounted submodule is missing: $path" >&2; return 1; }
        [[ "$(git -C "$ROOT/$path" rev-parse HEAD)" == "$object_sha" ]] || { echo "mounted submodule differs from promoted commit at $path" >&2; return 1; }
        ;;
      *) echo "unsupported Git tree entry at $path ($object_type)" >&2; return 1 ;;
    esac
    checked=$((checked + 1))
  done < <(git -C "$ROOT" ls-tree -r -z "$target_sha")

  (( checked > 0 )) || { echo 'promoted tree is empty' >&2; return 1; }
  printf '%s' "$checked"
}

checked="$(verify_mounted_tree "$SOURCE_SHA")" || die 'mounted tree does not match the promoted source commit'

# A concurrent root ref movement is rejected by update-ref's expected-old
# value. If it races after read-tree, restore only the old root index.
git -C "$ROOT" read-tree "$SOURCE_SHA" || die 'could not prepare the root index for the promoted tree'
if ! git -C "$ROOT" update-ref refs/heads/stable "$SOURCE_SHA" "$current_sha"; then
  git -C "$ROOT" read-tree "$current_sha" || true
  die 'stable ref changed concurrently; restored the prior root index'
fi

post_head="$(git -C "$ROOT" rev-parse HEAD)"
post_index_clean=1
git -C "$ROOT" diff-index --cached --quiet HEAD -- || post_index_clean=0
post_tree_verified=1
if ! verify_mounted_tree "$SOURCE_SHA" >/dev/null; then post_tree_verified=0; fi
if [[ "$post_head" != "$SOURCE_SHA" || "$post_index_clean" != 1 || "$post_tree_verified" != 1 ]]; then
  git -C "$ROOT" update-ref refs/heads/stable "$current_sha" "$SOURCE_SHA" || true
  git -C "$ROOT" read-tree "$current_sha" || true
  die "post-update verification failed (head=$post_head indexClean=$post_index_clean treeVerified=$post_tree_verified); restored root ref and index where possible"
fi

echo "reconcile-container-git-metadata: advanced root stable metadata $current_sha -> $SOURCE_SHA; verified $checked tree entries; preserved linked worktrees and untracked data"
