#!/usr/bin/env bash
# Install one Godot release into the shared versions directory and print the binary path.
#
#   godot-install 4.7-stable
#
# Idempotent and safe to run concurrently (flock). The download is verified against the
# SHA512-SUMS.txt published with the release, and the binary only appears at its final path
# after it has run `--version`. GODOT_VERSIONS_DIR is a persistent volume in the compose
# files, so installing a new version never needs an image rebuild or a container restart.
set -Eeuo pipefail

tag="${1:?usage: godot-install <version-tag, e.g. 4.7-stable>}"
[[ "$tag" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?-[a-z0-9.]+$ ]] || { echo "invalid Godot version tag '$tag'" >&2; exit 2; }

root="${GODOT_VERSIONS_DIR:-/opt/godot-versions}"
dest="$root/$tag"
if [ -x "$dest/godot" ]; then echo "$dest/godot"; exit 0; fi

mkdir -p "$root"
exec 9>"$root/.install.lock"
flock 9
if [ -x "$dest/godot" ]; then echo "$dest/godot"; exit 0; fi

case "$(uname -m)" in
  x86_64) arch=x86_64 ;;
  aarch64) arch=arm64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
zip="Godot_v${tag}_linux.${arch}.zip"
base="${GODOT_DOWNLOAD_BASE:-https://github.com/godotengine/godot/releases/download}/${tag}"

tmp="$(mktemp -d "$root/.tmp.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
echo "Installing Godot $tag ($arch)..." >&2
curl -fsSL -o "$tmp/$zip" "$base/$zip"
curl -fsSL -o "$tmp/SHA512-SUMS.txt" "$base/SHA512-SUMS.txt"
(cd "$tmp" && grep " ${zip}\$" SHA512-SUMS.txt | sha512sum -c - >&2)
unzip -q "$tmp/$zip" -d "$tmp/unzipped"
mkdir "$tmp/out"
mv "$tmp/unzipped/Godot_v${tag}_linux.${arch}" "$tmp/out/godot"
chmod +x "$tmp/out/godot"
"$tmp/out/godot" --headless --version >&2
mv "$tmp/out" "$dest"
echo "$dest/godot"
