#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_ROOT="${FACTORY_TEST_TMPDIR:-$ROOT/.factory}"
mkdir -p "$TEMP_ROOT"
TMP="$(mktemp -d "$TEMP_ROOT/autodeploy.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
assert() { "$@" || fail "$*"; }
assert_text() { grep -Fq -- "$2" "$1" || fail "expected '$2' in $1"; }
receipt_field() { sed -n "s/^[[:space:]]*\"$2\": \"\\([^\"]*\\)\",\?$/\\1/p" "$1"; }
validate_receipt() { node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$1"; }

mkdir -p "$TMP/seed/scripts/deploy" "$TMP/seed/config" "$TMP/seed/workflows" "$TMP/seed/skills/demo" \
  "$TMP/seed/scripts" "$TMP/seed/routing" "$TMP/seed/automations" "$TMP/seed/cezar" "$TMP/bin"
cp "$ROOT/scripts/deploy/factory-autodeploy.sh" "$TMP/seed/scripts/deploy/"
cp "$ROOT/scripts/deploy/lib-topology.sh" "$TMP/seed/scripts/deploy/"
cat > "$TMP/seed/scripts/deploy/deploy-cezar-runtime.sh" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' "$1" >> "$FAKE_DEPLOY_LOG"
EOF
chmod +x "$TMP/seed/scripts/deploy/deploy-cezar-runtime.sh"
printf '0.1.0\n' > "$TMP/seed/VERSION"
printf 'FROM scratch\n' > "$TMP/seed/cezar/Dockerfile"
printf 'name: demo\n' > "$TMP/seed/workflows/demo.yaml"
printf 'name: demo\n' > "$TMP/seed/skills/demo/SKILL.md"
printf '{"jobs":[]}\n' > "$TMP/seed/routing/automation-catalog.json"
printf '{"targets":[{"projectId":"demo"}]}\n' > "$TMP/seed/config/factory-projects.json"
printf '{"name":"[factory] demo"}\n' > "$TMP/seed/automations/demo.json"
cat > "$TMP/topology.env" <<'EOF'
FACTORY_CONTROL_PLANE_ID=test
FACTORY_CONTROL_PLANE_SSH_TARGET=test
FACTORY_CONTROL_PLANE_ADDRESS=127.0.0.1
FACTORY_CONTROL_PLANE_PODMAN_CONNECTION=test
FACTORY_CONTROL_PLANE_SERVICES="cezar"
FACTORY_MODEL_HOST_ID=test-model
FACTORY_MODEL_HOST_SSH_TARGET=test-model
FACTORY_MODEL_HOST_ADDRESS=127.0.0.1
FACTORY_MODEL_HOST_SERVICES="vllm"
FACTORY_VLLM_BASE_URL=http://127.0.0.1:8000/v1
FACTORY_VLLM_METRICS_TARGET=127.0.0.1:8000
FACTORY_VLLM_ALLOWED_CLIENTS=127.0.0.1/32
EOF

cat > "$TMP/bin/podman" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1" in
  image)
    case "$2" in
      exists) [[ "$3" == localhost/cezar:local ]] || exit 95 ;;
      inspect)
        if [[ "$5" == *'.Labels'* ]]; then git -C "$FAKE_FACTORY_DIR" rev-parse HEAD
        else echo sha256:runtime-image
        fi
        ;;
      *) exit 95 ;;
    esac
    ;;
  inspect) echo sha256:runtime-image ;;
  exec)
    shift 2
    case "$1" in
      bash)
        [[ "$2" == *reconcile-container-git-metadata.sh ]] || exit 98
        printf '%s\n' "$3" > "$FAKE_CONTAINER_SHA_FILE"
        printf '%s\n' "$3" >> "$FAKE_METADATA_LOG"
        ;;
      printenv)
        [[ "$2" == CEZ_FACTORY_RELEASE_STORE ]] || exit 98
        if [[ -n "${FAKE_CEZ_FACTORY_RELEASE_STORE:-}" ]]; then
          printf '%s\n' "$FAKE_CEZ_FACTORY_RELEASE_STORE"
        else
          exit 1
        fi
        ;;
      test)
        [[ "$2" == -f && "$3" == "${FAKE_CEZ_FACTORY_RELEASE_STORE:-}/channels/stable.json" ]] || exit 98
        [[ "${FAKE_CHANNEL_POINTER_PRESENT:-0}" == 1 ]]
        ;;
      git)
        shift
        [[ "$1" == -C ]] || exit 91
        shift 2
        if [[ "$1" == rev-parse && -f "$FAKE_CONTAINER_SHA_FILE" ]]; then
          cat "$FAKE_CONTAINER_SHA_FILE"
          exit 0
        fi
        exec git -C "$FAKE_FACTORY_DIR" "$@"
        ;;
      sh)
        [[ "$2" == -c ]] || exit 92
        command="$3"
        if [[ "$command" == *"set -- VERSION workflows"* ]]; then
          if [[ "${FAKE_CONTAINER_STALE:-0}" == 1 ]]; then echo stale-content-digest; exit 0; fi
          exec sh -c "$command" sh "$FAKE_FACTORY_DIR"
        fi
        if [[ "$command" == *"tr -d"*"VERSION"* ]]; then
          tr -d '\r\n' < "$FAKE_FACTORY_DIR/VERSION"
          exit 0
        fi
        exit 93
        ;;
      pwsh)
        [[ "$2" == -NoProfile && "$4" == *sync-all-automations.ps1 ]] || exit 99
        printf 'sync\n' >> "$FAKE_SYNC_LOG"
        echo 'Synchronized automations for demo'
        exit "${FAKE_SYNC_EXIT:-0}"
        ;;
      *) exit 94 ;;
    esac
    ;;
  *) exit 90 ;;
esac
EOF
chmod +x "$TMP/bin/podman"
cat > "$TMP/bin/python3" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1##*/}" == factory_activation.py && "${2:-}" == activate ]]; then
  printf 'activate\n' >> "$FAKE_ACTIVATION_LOG"
  echo 'Synchronized automations for demo'
  exit "${FAKE_SYNC_EXIT:-0}"
fi
exec /usr/bin/python3 "$@"
EOF
chmod +x "$TMP/bin/python3"
cat > "$TMP/bin/flock" <<'EOF'
#!/usr/bin/env bash
# The harness is serial; emulate a successfully acquired non-blocking lock.
exit 0
EOF
chmod +x "$TMP/bin/flock"
cat > "$TMP/bin/systemctl" <<'EOF'
#!/usr/bin/env sh
[ "${1:-}" = --user ] || exit 96
case "${2:-}" in
  is-active) echo active ;;
  restart) printf 'restart\n' >> "$FAKE_DEPLOY_LOG" ;;
  *) exit 97 ;;
esac
EOF
chmod +x "$TMP/bin/systemctl"
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env sh
exit 0
EOF
chmod +x "$TMP/bin/curl"
cat > "$TMP/bin/sleep" <<'EOF'
#!/usr/bin/env sh
exit 0
EOF
chmod +x "$TMP/bin/sleep"

git init --bare "$TMP/remote.git" >/dev/null
git -C "$TMP/seed" init -b stable >/dev/null
git -C "$TMP/seed" config user.name test
git -C "$TMP/seed" config user.email test@example.invalid
git -C "$TMP/seed" add .
git -C "$TMP/seed" commit -m initial >/dev/null
git -C "$TMP/seed" remote add origin "$TMP/remote.git"
git -C "$TMP/seed" push -u origin stable >/dev/null
git clone --branch stable "$TMP/remote.git" "$TMP/checkout" >/dev/null 2>&1

export PATH="$TMP/bin:$PATH"
export FACTORY_TOPOLOGY_FILE="$TMP/topology.env"
export FACTORY_DIR="$TMP/checkout"
export FAKE_FACTORY_DIR="$TMP/checkout"
export FACTORY_AUTODEPLOY_STATE_DIR="$TMP/state"
export FACTORY_AUTODEPLOY_LOCK="$TMP/autodeploy.lock"
export FAKE_SYNC_LOG="$TMP/sync.log"
export FAKE_ACTIVATION_LOG="$TMP/activation.log"
export FAKE_DEPLOY_LOG="$TMP/deploy.log"
export FAKE_METADATA_LOG="$TMP/metadata.log"
export FAKE_CONTAINER_SHA_FILE="$TMP/container-sha"
printf '1eac4bf6d0bb726db87b4a8b472cee4da1339edf\n' > "$FAKE_CONTAINER_SHA_FILE"
export FACTORY_RUNTIME_ROOT=/projects/cezar-factory
AUTO="$TMP/checkout/scripts/deploy/factory-autodeploy.sh"

run_auto() {
  local expected="$1"
  set +e
  if [[ "${DEBUG_AUTODEPLOY:-0}" == 1 ]]; then
    bash -x "$AUTO"
  else
    bash "$AUTO" >/dev/null 2>&1
  fi
  local actual=$?
  set -e
  [[ "$actual" == "$expected" ]] || fail "expected exit $expected, got $actual"
}

bash -n "$AUTO"
run_auto 0
assert_text "$TMP/state/last-success.json" '"status": "success"'
assert_text "$TMP/state/last-success.json" '"targetReceipts": "Synchronized automations for demo'
assert_text "$TMP/state/last-success.json" '"containerSha":'
assert_text "$TMP/state/last-success.json" '"registryDigest":'
assert_text "$TMP/state/last-success.json" '"schemaVersion": 1'
assert_text "$TMP/state/last-success.json" '"error": ""'
validate_receipt "$TMP/state/last-success.json"
initial_sha="$(receipt_field "$TMP/state/last-success.json" sourceSha)"
[[ -n "$initial_sha" ]] || fail 'success receipt has no source SHA'
[[ "$(wc -l < "$FAKE_DEPLOY_LOG")" -eq 1 ]] || fail 'autodeploy did not invoke the Cezar runtime deployment check'
assert_text "$TMP/state/last-success.json" "\"containerSha\": \"$initial_sha\""
[[ "$(wc -l < "$FAKE_METADATA_LOG")" -eq 1 ]] || fail 'autodeploy did not invoke the safe container Git-metadata reconciliation'
[[ "$(wc -l < "$FAKE_SYNC_LOG")" -eq 1 ]] || fail 'initial healthy tick did not sync exactly once'
[[ ! -f "$FAKE_ACTIVATION_LOG" ]] || fail 'legacy deployment unexpectedly invoked channel activation'

# Advance origin, then fail after checkout advancement. The next unchanged tick must retry.
printf 'next\n' > "$TMP/seed/release-note"
git -C "$TMP/seed" add release-note
git -C "$TMP/seed" commit -m advance >/dev/null
git -C "$TMP/seed" push origin stable >/dev/null
export FAKE_SYNC_EXIT=7
run_auto 24
advanced_sha="$(git -C "$TMP/checkout" rev-parse HEAD)"
[[ "$advanced_sha" == "$(git -C "$TMP/seed" rev-parse HEAD)" ]] || fail 'checkout did not advance before injected sync failure'
assert_text "$TMP/state/last-attempt.json" '"status": "failure"'
[[ "$(receipt_field "$TMP/state/last-success.json" sourceSha)" == "$initial_sha" ]] || fail 'failed run replaced last success receipt'

unset FAKE_SYNC_EXIT
run_auto 0
assert_text "$TMP/state/last-success.json" '"status": "success"'
[[ "$(receipt_field "$TMP/state/last-success.json" sourceSha)" == "$advanced_sha" ]] || fail 'retry receipt is not bound to the advanced SHA'
run_auto 0
[[ "$(wc -l < "$FAKE_SYNC_LOG")" -eq 4 ]] || fail 'unchanged healthy tick did not reconcile again'
[[ "$(wc -l < "$FAKE_DEPLOY_LOG")" -eq 4 ]] || fail 'unchanged healthy ticks did not retry runtime verification'
[[ "$(wc -l < "$FAKE_METADATA_LOG")" -eq 4 ]] || fail 'unchanged healthy ticks did not verify container Git metadata'

# A configured channel store uses journaled activation. Missing pointers fail
# closed and never fall back to legacy automation sync.
export FAKE_CEZ_FACTORY_RELEASE_STORE=/var/lib/cezar-factory/release-store
run_auto 24
[[ "$(wc -l < "$FAKE_SYNC_LOG")" -eq 4 ]] || fail 'missing channel pointer fell back to legacy synchronization'
export FAKE_CHANNEL_POINTER_PRESENT=1
run_auto 0
[[ "$(wc -l < "$FAKE_ACTIVATION_LOG")" -eq 1 ]] || fail 'configured verified channel did not invoke activation exactly once'
unset FAKE_CEZ_FACTORY_RELEASE_STORE FAKE_CHANNEL_POINTER_PRESENT

# The same Git SHA and VERSION with stale mounted content must not sync or replace success.
last_success="$(sha256sum "$TMP/state/last-success.json" | cut -d' ' -f1)"
export FAKE_CONTAINER_STALE=1
sync_count="$(wc -l < "$FAKE_SYNC_LOG")"
run_auto 22
[[ "$(wc -l < "$FAKE_SYNC_LOG")" == "$sync_count" ]] || fail 'container drift still triggered sync'
[[ "$(sha256sum "$TMP/state/last-success.json" | cut -d' ' -f1)" == "$last_success" ]] || fail 'parity failure replaced last success'
unset FAKE_CONTAINER_STALE

# Dirty and divergent checkouts are refused without any checkout rewrite or sync.
touch "$TMP/checkout/untracked-marker"
run_auto 20
rm "$TMP/checkout/untracked-marker"
git -C "$TMP/checkout" config user.name test
git -C "$TMP/checkout" config user.email test@example.invalid
printf 'local\n' > "$TMP/checkout/local-only"
git -C "$TMP/checkout" add local-only
git -C "$TMP/checkout" commit -m divergent >/dev/null
divergent_sha="$(git -C "$TMP/checkout" rev-parse HEAD)"
sync_count="$(wc -l < "$FAKE_SYNC_LOG")"
run_auto 21
[[ "$(git -C "$TMP/checkout" rev-parse HEAD)" == "$divergent_sha" ]] || fail 'divergent checkout was overwritten'
[[ "$(wc -l < "$FAKE_SYNC_LOG")" == "$sync_count" ]] || fail 'dirty/divergent checkout triggered sync'

echo 'All factory-autodeploy recovery tests passed.'
