#!/usr/bin/env bash
set -euo pipefail
platform="${1:?usage: package.sh <linux|mac|win> /path/to/chromium/src/out/dir /output.zip}"
out="${2:?missing output directory}"
dest="${3:?missing archive path}"
root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
chromium_version="153.0.8010.36"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
case "$platform" in
  linux)
    python3 "$root/scripts/chromium/package-runtime.py" linux "$out" "$dest"
    exit
    ;;
  mac)
    cp -a "$out/BetterChromium.app" "$stage/BetterChromium.app"
    codesign --force --deep --sign - "$stage/BetterChromium.app"
    mkdir -p "$stage/mac-arm64"
    mv "$stage/BetterChromium.app" "$stage/mac-arm64/BetterChromium.app"
    (cd "$stage" && zip -qry "$dest" mac-arm64)
    ;;
  win)
    # The matching manifest supplies chrome_elf.dll's version-named assembly.
    python3 "$root/scripts/chromium/package-runtime.py" win "$out" "$dest" \
      --manifest "$root/scripts/chromium/$chromium_version.manifest"
    exit
    ;;
  *) echo "unsupported platform: $platform" >&2; exit 1 ;;
esac
shasum -a 256 "$dest"
