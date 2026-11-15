#!/usr/bin/env bash

# Emit a stable, per-file manifest of managed Factory content. Git's index is
# the common file set on the host and in Cezar, so ignored/untracked runtime
# artifacts cannot create false parity failures.
factory_content_manifest() {
  local root="$1"
  (
    cd "$root"
    {
      git ls-files -z -- VERSION workflows skills scripts routing automations
      [[ -f config/factory-projects.json ]] && printf '%s\0' config/factory-projects.json
    } | LC_ALL=C sort -zu | while IFS= read -r -d '' path; do
      case "$path" in
        *__pycache__/*|*.pyc|*.pyo|*.pyd|*/artifacts/*) continue ;;
      esac
      if [[ -f "$path" ]]; then
        checksum="$(sha256sum -- "$path")"
        printf '%s %s\n' "${checksum%% *}" "$path"
      else
        printf 'missing %s\n' "$path"
      fi
    done
  )
}
