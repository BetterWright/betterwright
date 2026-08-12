#!/usr/bin/env bash
set -euo pipefail
platform="${1:?usage: build.sh <linux|mac|win> /path/to/chromium/src [out-dir]}"
src="${2:?usage: build.sh <linux|mac|win> /path/to/chromium/src [out-dir]}"
out="${3:-out/BetterChromiumStatic}"
repo="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
case "$platform" in
  linux) args="$repo/scripts/chromium/args-linux.gn" ;;
  mac) args="$repo/scripts/chromium/args-mac.gn" ;;
  win) args="$repo/scripts/chromium/args-win.gn" ;;
  *) echo "unsupported platform: $platform" >&2; exit 1 ;;
esac
command -v gn >/dev/null || { echo "gn is required on PATH" >&2; exit 1; }
command -v autoninja >/dev/null || { echo "autoninja is required on PATH" >&2; exit 1; }
mkdir -p "$src/$out"
cp "$args" "$src/$out/args.gn"
(cd "$src" && gn gen "$out" && autoninja -C "$out" chrome inspector-test)
