#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${FACTORY_TEST_TMPDIR:-$ROOT/.factory}"
mkdir -p "$TMP_ROOT"
TMP="$(mktemp -d "$TMP_ROOT/deploy-cezar.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$TMP/repo/scripts/deploy" "$TMP/repo/cezar" "$TMP/bin" "$TMP/state"
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

echo 'Cezar runtime deployment tests passed.'
