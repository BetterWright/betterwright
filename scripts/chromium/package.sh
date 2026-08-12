#!/usr/bin/env bash
set -euo pipefail
platform="${1:?usage: package.sh <linux|mac|win> /path/to/chromium/src/out/dir /output.zip}"
out="${2:?missing output directory}"
dest="${3:?missing archive path}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
case "$platform" in
  linux)
    mkdir -p "$stage/linux-x64"
    (cd "$out" && cp -a chrome chrome-wrapper chrome-sandbox icudtl.dat libEGL.so libGLESv2.so libvk_swiftshader.so resources.pak snapshot_blob.bin v8_context_snapshot.bin vk_swiftshader_icd.json locales resources "$stage/linux-x64/" 2>/dev/null || true)
    [[ -x "$stage/linux-x64/chrome" ]] || { echo "staged Linux chrome missing" >&2; exit 1; }
    mv "$stage/linux-x64/chrome" "$stage/linux-x64/betterchromium"
    (cd "$stage" && zip -qry "$dest" linux-x64)
    ;;
  mac)
    cp -a "$out/BetterChromium.app" "$stage/BetterChromium.app"
    codesign --force --deep --sign - "$stage/BetterChromium.app"
    mkdir -p "$stage/mac-arm64"
    mv "$stage/BetterChromium.app" "$stage/mac-arm64/BetterChromium.app"
    (cd "$stage" && zip -qry "$dest" mac-arm64)
    ;;
  win)
    mkdir -p "$stage/win-x64"
    cp -a "$out"/. "$stage/win-x64/"
    [[ -f "$stage/win-x64/chrome.exe" ]] || { echo "staged Windows chrome.exe missing" >&2; exit 1; }
    mv "$stage/win-x64/chrome.exe" "$stage/win-x64/betterchromium.exe"
    (cd "$stage" && zip -qry "$dest" win-x64)
    ;;
  *) echo "unsupported platform: $platform" >&2; exit 1 ;;
esac
shasum -a 256 "$dest"
