#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${FACTORY_TEST_TMPDIR:-$ROOT/.factory}"
mkdir -p "$TMP_ROOT"
TMP="$(mktemp -d "$TMP_ROOT/boot-order.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

SCRIPT="$ROOT/scripts/deploy/install-boot-order.sh"
bash -n "$SCRIPT"

# The user manager is faked: the test only needs to know that it was reloaded when something changed.
mkdir -p "$TMP/bin" "$TMP/home"
cat > "$TMP/bin/systemctl" <<'EOF'
#!/usr/bin/env sh
echo "$*" >> "$FAKE_SYSTEMCTL_LOG"
EOF
chmod +x "$TMP/bin/systemctl"
export PATH="$TMP/bin:$PATH" HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/home/.config" FAKE_SYSTEMCTL_LOG="$TMP/systemctl.log"
: > "$FAKE_SYSTEMCTL_LOG"
DROPIN=".config/systemd/user"

# check before installing: not ordered, non-zero
set +e; bash "$SCRIPT" check > "$TMP/check0.log" 2>&1; code=$?; set -e
[[ "$code" -ne 0 ]] || fail 'check passed before anything was installed'
grep -q 'container-cezar.service: NOT ordered' "$TMP/check0.log" || fail 'check did not name the unit that lacks the ordering'

# install: the three default units get the drop-in, and the user manager is reloaded once
bash "$SCRIPT" install > "$TMP/install1.log" 2>&1 || { cat "$TMP/install1.log" >&2; fail 'install failed'; }
for unit in container-cezar.service podman-restart.service 'podman-compose@.service'; do
  file="$TMP/home/$DROPIN/$unit.d/10-factory-wait-online.conf"
  [[ -f "$file" ]] || fail "no drop-in installed for $unit"
  grep -q '^Wants=podman-user-wait-network-online.service$' "$file" || fail "$unit drop-in does not want the wait unit"
  grep -q '^After=podman-user-wait-network-online.service$' "$file" || fail "$unit drop-in is not ordered after the wait unit"
done
[[ "$(grep -c 'daemon-reload' "$FAKE_SYSTEMCTL_LOG")" == 1 ]] || fail 'the user manager was not reloaded exactly once after installing'
bash "$SCRIPT" check > "$TMP/check1.log" 2>&1 || fail 'check failed after installing'

# idempotent: a second install changes nothing and does not reload
: > "$FAKE_SYSTEMCTL_LOG"
bash "$SCRIPT" install > "$TMP/install2.log" 2>&1 || fail 'second install failed'
grep -q 'already ordered' "$TMP/install2.log" || fail 'second install did not say it was already in place'
[[ ! -s "$FAKE_SYSTEMCTL_LOG" ]] || fail 'second install reloaded the user manager although nothing changed'

# a drop-in that was edited by hand is put back
printf 'tampered\n' > "$TMP/home/$DROPIN/container-cezar.service.d/10-factory-wait-online.conf"
bash "$SCRIPT" install > "$TMP/install3.log" 2>&1 || fail 'repairing install failed'
grep -q '^After=podman-user-wait-network-online.service$' "$TMP/home/$DROPIN/container-cezar.service.d/10-factory-wait-online.conf" || fail 'a hand-edited drop-in was not restored'

# a unit someone else configured is left alone: only our own file is touched
mkdir -p "$TMP/home/$DROPIN/podman-restart.service.d"
printf '[Service]\nRestart=always\n' > "$TMP/home/$DROPIN/podman-restart.service.d/20-local.conf"

# remove: our drop-ins go, the other file stays
bash "$SCRIPT" remove > "$TMP/remove.log" 2>&1 || fail 'remove failed'
[[ ! -e "$TMP/home/$DROPIN/container-cezar.service.d" ]] || fail 'an emptied drop-in directory was left behind'
[[ -f "$TMP/home/$DROPIN/podman-restart.service.d/20-local.conf" ]] || fail 'remove deleted a drop-in it does not own'
[[ ! -e "$TMP/home/$DROPIN/podman-restart.service.d/10-factory-wait-online.conf" ]] || fail 'remove left our drop-in behind'

# explicit unit names are honoured
bash "$SCRIPT" install only-this.service > "$TMP/install4.log" 2>&1 || fail 'install with an explicit unit failed'
[[ -f "$TMP/home/$DROPIN/only-this.service.d/10-factory-wait-online.conf" && ! -e "$TMP/home/$DROPIN/container-cezar.service.d" ]] || fail 'explicit unit names were not honoured'

# usage and validation: --help prints usage; a name that is not a unit name is refused before anything is written
bash "$SCRIPT" --help > "$TMP/help.log" 2>&1 || fail '--help failed'
grep -q '^Usage: install-boot-order.sh' "$TMP/help.log" || fail '--help did not print the usage line'
for bad in '../escape.service' 'not-a-unit' '/etc/passwd' 'a b.service' '.hidden.service'; do
  set +e; bash "$SCRIPT" install "$bad" > "$TMP/bad.log" 2>&1; code=$?; set -e
  [[ "$code" == 2 ]] || fail "'$bad' was not refused with exit 2 (got $code)"
  grep -q 'is not a systemd unit name' "$TMP/bad.log" || fail "'$bad' was refused without saying why"
done
[[ ! -e "$TMP/home/.config/systemd/user/../escape.service.d" && ! -e "$TMP/home/.config/systemd/escape.service.d" ]] || fail 'a refused name still wrote a file'

echo 'Boot-order drop-in installer tests passed.'
