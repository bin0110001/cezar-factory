#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${FACTORY_TEST_TMPDIR:-$ROOT/.factory}"
mkdir -p "$TMP_ROOT"
TMP="$(mktemp -d "$TMP_ROOT/validate-in-container.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$TMP/bin" "$TMP/factory-source"
cat > "$TMP/bin/podman" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1" in
  inspect)
    case "$4" in
      '{{.Image}}') printf '%s\n' '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' ;;
      '{{range $name, $network := .NetworkSettings.Networks}}{{$name}} {{end}}') printf '%s\n' 'cezar-net ' ;;
      '{{range .Mounts}}{{if and (eq .Type "volume") (eq .Destination "/projects")}}{{.Name}}{{end}}{{end}}') printf '%s\n' 'cezar-projects' ;;
      '{{range .Mounts}}{{if and (eq .Type "bind") (eq .Destination "/projects/cezar-factory")}}{{.Source}}{{end}}{{end}}') printf '%s\n' "$FAKE_FACTORY_SOURCE" ;;
      '{{range .Mounts}}{{if and (eq .Type "volume") (eq .Destination "/projects/cezar-factory/.git")}}{{.Name}}{{end}}{{end}}') printf '%s\n' 'cezar-git-meta' ;;
      *) echo "unexpected podman inspect template: $4" >&2; exit 90 ;;
    esac
    ;;
  run)
    shift
    printf '%s\0' "$@" > "$PODMAN_RUN_ARGS"
    ;;
  *) echo "unexpected podman command: $1" >&2; exit 91 ;;
esac
EOF
chmod +x "$TMP/bin/podman"

export PATH="$TMP/bin:$PATH"
export FAKE_FACTORY_SOURCE="$TMP/factory-source"
export PODMAN_RUN_ARGS="$TMP/podman-run-args"
export FACTORY_CANDIDATE_SHA=0123456789abcdef0123456789abcdef01234567
export FACTORY_GITHUB_REPOSITORY=example/factory

bash "$ROOT/scripts/release/validate-in-container.sh"
mapfile -d '' -t podman_args < "$PODMAN_RUN_ARGS"
has_pair() {
  local wanted_key="$1" wanted_value="$2" i
  for ((i = 0; i + 1 < ${#podman_args[@]}; i++)); do
    if [[ "${podman_args[$i]}" == "$wanted_key" && "${podman_args[$((i + 1))]}" == "$wanted_value" ]]; then
      return 0
    fi
  done
  return 1
}

has_pair --security-opt label=disable || fail 'disposable container must disable SELinux separation'
has_pair --network cezar-net || fail 'disposable container must use the discovered named network'

expected_volumes=(
  'cezar-projects:/projects'
  "$FAKE_FACTORY_SOURCE:/projects/cezar-factory"
  'cezar-git-meta:/projects/cezar-factory/.git'
)
actual_volumes=()
for ((i = 0; i < ${#podman_args[@]}; i++)); do
  if [[ "${podman_args[$i]}" == --volume ]]; then
    (( i + 1 < ${#podman_args[@]} )) || fail '--volume must have a value'
    actual_volumes+=("${podman_args[$((i + 1))]}")
    [[ "${podman_args[$((i + 1))]}" != *:z && "${podman_args[$((i + 1))]}" != *:Z ]] || fail 'shared volumes must not be relabeled'
  fi
done

[[ "${actual_volumes[*]}" == "${expected_volumes[*]}" ]] || fail "unexpected container volume allowlist: ${actual_volumes[*]}"
for arg in "${podman_args[@]}"; do
  [[ "$arg" != --volumes-from* ]] || fail 'validator must not import all Cezar mounts'
done

echo 'validate-in-container shell test passed'
