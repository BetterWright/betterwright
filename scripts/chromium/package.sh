#!/usr/bin/env bash
set -euo pipefail
platform="${1:?usage: package.sh <linux|mac|win> /path/to/chromium/src/out/dir /output.zip}"
out="${2:?missing output directory}"
dest="${3:?missing archive path}"
root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
chromium_version="153.0.8010.36"
stage="$(mktemp -d)"
archive_stage=""
trap 'rm -rf "$stage"; if [[ -n "$archive_stage" ]]; then rm -rf "$archive_stage"; fi' EXIT
case "$platform" in
  linux)
    python3 "$root/scripts/chromium/package-runtime.py" linux "$out" "$dest"
    exit
    ;;
  mac)
    if [[ ! -x "$out/BetterChromium.app/Contents/MacOS/BetterChromium" ]]; then
      echo "Browser runtime dependency missing: BetterChromium.app/Contents/MacOS/BetterChromium" >&2
      exit 1
    fi
    cp -a "$out/BetterChromium.app" "$stage/BetterChromium.app"
    # Finder and synced-folder metadata can make codesign reject a valid build.
    # Strip it from the staged copy before signing the distribution bundle.
    xattr -cr "$stage/BetterChromium.app"
    codesign --force --deep --sign - "$stage/BetterChromium.app"
    mkdir -p "$stage/mac-arm64"
    mv "$stage/BetterChromium.app" "$stage/mac-arm64/BetterChromium.app"
    mkdir -p "$(dirname -- "$dest")"
    dest_parent="$(CDPATH= cd -- "$(dirname -- "$dest")" && pwd)"
    dest="$dest_parent/$(basename -- "$dest")"
    archive_stage="$(mktemp -d "$dest_parent/.bw-archive.XXXXXX")"
    # zip updates existing archives and retains removed files. Build a fresh zip
    # beside the destination, then atomically replace it only after success.
    (cd "$stage" && zip -qry "$archive_stage/browser.zip" mac-arm64)
    mv "$archive_stage/browser.zip" "$dest"
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
