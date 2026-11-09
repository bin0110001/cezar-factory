#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${FACTORY_TEST_TMPDIR:-$ROOT/.factory}"
mkdir -p "$TMP_ROOT"
TMP="$(mktemp -d "$TMP_ROOT/deploy-cezar.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$TMP/repo/scripts/deploy" "$TMP/repo/cezar" "$TMP/bin" "$TMP/state"
# Hermetic: never depend on a writable $HOME (the Cezar container that validates candidates has none).
export FACTORY_AUTODEPLOY_STATE_DIR="$TMP/autodeploy-state"
cp "$ROOT/scripts/deploy/deploy-cezar-runtime.sh" "$TMP/repo/scripts/deploy/"
printf 'FROM scratch\n' > "$TMP/repo/cezar/Dockerfile"
git -C "$TMP/repo" init -b stable >/dev/null
git -C "$TMP/repo" config user.name test
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" add .
git -C "$TMP/repo" commit -m initial >/dev/null
BASE_SHA="$(git -C "$TMP/repo" rev-parse HEAD)"

printf '%s\n' "$BASE_SHA" > "$TMP/state/revision"
printf 'sha256:old\n' > "$TMP/state/image-id"
printf 'sha256:old\n' > "$TMP/state/running-id"
printf 'active\n' > "$TMP/state/service"
printf '0\n' > "$TMP/state/builds"
printf '0\n' > "$TMP/state/restarts"

cat > "$TMP/bin/podman" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1" in
  image)
    case "$2" in
      exists) [[ -f "$FAKE_STATE/image-id" ]] ;;
      inspect)
        if [[ "$5" == *'.Labels'* ]]; then cat "$FAKE_STATE/revision"
        else cat "$FAKE_STATE/image-id"
        fi
        ;;
      *) exit 90 ;;
    esac
    ;;
  inspect) cat "$FAKE_STATE/running-id" ;;
  build)
    previous="$(cat "$FAKE_STATE/image-id")"
    printf '%s\n' "$previous" > "$FAKE_STATE/previous-id"
    printf '%s\n' "$(cat "$FAKE_STATE/revision")" > "$FAKE_STATE/previous-revision"
    for arg in "$@"; do
      case "$arg" in org.opencontainers.image.revision=*) printf '%s\n' "${arg#*=}" > "$FAKE_STATE/revision" ;; esac
    done
    sha="$(cat "$FAKE_STATE/revision")"
    printf 'sha256:built-%s\n' "${sha:0:8}" > "$FAKE_STATE/image-id"
    echo "$(( $(cat "$FAKE_STATE/builds") + 1 ))" > "$FAKE_STATE/builds"
    ;;
  tag)
    printf '%s\n' "$2" > "$FAKE_STATE/image-id"
    if [[ -f "$FAKE_STATE/previous-id" && "$2" == "$(cat "$FAKE_STATE/previous-id")" ]]; then
      cat "$FAKE_STATE/previous-revision" > "$FAKE_STATE/revision"
    fi
    ;;
  *) exit 91 ;;
esac
EOF
chmod +x "$TMP/bin/podman"
cat > "$TMP/bin/systemctl" <<'EOF'
#!/usr/bin/env sh
[ "$1" = --user ] || exit 92
case "$2" in
  is-active) cat "$FAKE_STATE/service" ;;
  restart)
    echo "$(( $(cat "$FAKE_STATE/restarts") + 1 ))" > "$FAKE_STATE/restarts"
    cp "$FAKE_STATE/image-id" "$FAKE_STATE/running-id"
    ;;
  *) exit 93 ;;
esac
EOF
chmod +x "$TMP/bin/systemctl"
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env sh
case "$*" in
  *factory-release*) [ "${FAKE_RELEASE_FAIL:-0}" = 0 ] ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$TMP/bin/curl"
cat > "$TMP/bin/sleep" <<'EOF'
#!/usr/bin/env sh
exit 0
EOF
chmod +x "$TMP/bin/sleep"

export PATH="$TMP/bin:$PATH"
export FAKE_STATE="$TMP/state"
SCRIPT="$TMP/repo/scripts/deploy/deploy-cezar-runtime.sh"
bash -n "$SCRIPT"

bash "$SCRIPT" "$BASE_SHA"
[[ "$(cat "$TMP/state/builds")" == 0 ]] || fail 'matching image revision rebuilt unnecessarily'
[[ "$(cat "$TMP/state/restarts")" == 0 ]] || fail 'healthy matching image restarted unnecessarily'

printf 'RUN new\n' >> "$TMP/repo/cezar/Dockerfile"
git -C "$TMP/repo" add cezar/Dockerfile
git -C "$TMP/repo" commit -m 'change Cezar source' >/dev/null
CEZAR_SHA="$(git -C "$TMP/repo" rev-parse HEAD)"
bash "$SCRIPT" "$CEZAR_SHA"
[[ "$(cat "$TMP/state/builds")" == 1 ]] || fail 'Cezar source change did not rebuild the image'
[[ "$(cat "$TMP/state/restarts")" == 1 ]] || fail 'new image did not restart the service'
[[ "$(cat "$TMP/state/revision")" == "$CEZAR_SHA" ]] || fail 'image revision label does not match Cezar source commit'
[[ "$(cat "$TMP/state/running-id")" == "$(cat "$TMP/state/image-id")" ]] || fail 'service is not using the newly built image'

printf 'docs-only\n' > "$TMP/repo/release-note"
git -C "$TMP/repo" add release-note
git -C "$TMP/repo" commit -m 'Factory-only change' >/dev/null
FACTORY_SHA="$(git -C "$TMP/repo" rev-parse HEAD)"
bash "$SCRIPT" "$FACTORY_SHA"
[[ "$(cat "$TMP/state/builds")" == 1 ]] || fail 'Factory-only change rebuilt the Cezar image'
[[ "$(cat "$TMP/state/restarts")" == 1 ]] || fail 'Factory-only change restarted Cezar unnecessarily'

previous_id="$(cat "$TMP/state/image-id")"
previous_revision="$(cat "$TMP/state/revision")"
printf 'RUN change\n' >> "$TMP/repo/cezar/Dockerfile"
git -C "$TMP/repo" add cezar/Dockerfile
git -C "$TMP/repo" commit -m 'change Cezar source with unhealthy endpoint' >/dev/null
FAILED_SHA="$(git -C "$TMP/repo" rev-parse HEAD)"
set +e
FAKE_RELEASE_FAIL=1 bash "$SCRIPT" "$FAILED_SHA" > "$TMP/failed-deploy.log" 2>&1
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'unhealthy Factory API endpoint was accepted'
[[ "$(cat "$TMP/state/image-id")" == "$previous_id" ]] || fail 'failed deployment did not restore the prior image tag'
[[ "$(cat "$TMP/state/revision")" == "$previous_revision" ]] || fail 'rollback left the failed image revision active'
[[ "$(cat "$TMP/state/running-id")" == "$previous_id" ]] || fail 'service was not restarted with the prior image after failure'
[[ "$(cat "$TMP/state/restarts")" == 3 ]] || fail 'failed deployment did not restart new and prior image exactly once each'

# A restart must wait for an idle Cezar: busy defers (exit 25) without restarting, idle proceeds, and a deferral
# older than the limit restarts anyway so a permanently busy queue cannot starve a deploy.
printf 'RUN idle-gate\n' >> "$TMP/repo/cezar/Dockerfile"
git -C "$TMP/repo" add cezar/Dockerfile
git -C "$TMP/repo" commit -m 'change Cezar source for idle gate' >/dev/null
IDLE_SHA="$(git -C "$TMP/repo" rev-parse HEAD)"
restarts_before="$(cat "$TMP/state/restarts")"
export FACTORY_AUTODEPLOY_STATE_DIR="$TMP/idle-state"
mkdir -p "$TMP/idle-state"
set +e
FACTORY_ACTIVE_RUNS_COMMAND='echo 2' FACTORY_DEPLOY_IDLE_WAIT_SECONDS=0 bash "$SCRIPT" "$IDLE_SHA" > "$TMP/deferred.log" 2>&1
code=$?
set -e
[[ "$code" == 25 ]] || fail "busy Cezar did not defer with exit 25 (got $code)"
grep -q 'DEFERRED' "$TMP/deferred.log" || fail 'deferral was not logged'
[[ "$(cat "$TMP/state/restarts")" == "$restarts_before" ]] || fail 'busy Cezar was restarted anyway'
[[ -f "$TMP/idle-state/runtime-deferred-since" ]] || fail 'deferral did not record when it started'

FACTORY_ACTIVE_RUNS_COMMAND='echo 0' bash "$SCRIPT" "$IDLE_SHA" > "$TMP/idle.log" 2>&1 || fail 'idle Cezar deploy failed'
[[ "$(cat "$TMP/state/restarts")" -gt "$restarts_before" ]] || fail 'idle Cezar was not restarted'
[[ ! -f "$TMP/idle-state/runtime-deferred-since" ]] || fail 'successful idle restart left the deferral marker'

printf 'RUN starved\n' >> "$TMP/repo/cezar/Dockerfile"
git -C "$TMP/repo" add cezar/Dockerfile
git -C "$TMP/repo" commit -m 'change Cezar source for starvation guard' >/dev/null
STARVED_SHA="$(git -C "$TMP/repo" rev-parse HEAD)"
mkdir -p "$TMP/idle-state"
echo $(( $(date +%s) - 100000 )) > "$TMP/idle-state/runtime-deferred-since"
restarts_before="$(cat "$TMP/state/restarts")"
FACTORY_ACTIVE_RUNS_COMMAND='echo 5' FACTORY_DEPLOY_MAX_DEFER_SECONDS=7200 bash "$SCRIPT" "$STARVED_SHA" > "$TMP/starved.log" 2>&1 || fail 'starvation guard did not let the deploy through'
grep -q 'restarting despite' "$TMP/starved.log" || fail 'starvation guard did not log why it restarted a busy Cezar'
[[ "$(cat "$TMP/state/restarts")" -gt "$restarts_before" ]] || fail 'starvation guard did not restart'
export FACTORY_AUTODEPLOY_STATE_DIR="$TMP/autodeploy-state"

# An unwritable state directory only disables the starvation timer; the deploy itself must still go through.
printf 'RUN unwritable-state\n' >> "$TMP/repo/cezar/Dockerfile"
git -C "$TMP/repo" add cezar/Dockerfile
git -C "$TMP/repo" commit -m 'change Cezar source for unwritable state dir' >/dev/null
UNWRITABLE_SHA="$(git -C "$TMP/repo" rev-parse HEAD)"
touch "$TMP/not-a-dir"
restarts_before="$(cat "$TMP/state/restarts")"
FACTORY_AUTODEPLOY_STATE_DIR="$TMP/not-a-dir/state" FACTORY_ACTIVE_RUNS_COMMAND='echo 0' bash "$SCRIPT" "$UNWRITABLE_SHA" > "$TMP/unwritable.log" 2>&1 || fail 'an unwritable state directory aborted the deploy'
[[ "$(cat "$TMP/state/restarts")" -gt "$restarts_before" ]] || fail 'an unwritable state directory prevented the restart'

echo 'Cezar runtime deployment tests passed.'
