#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
src="${1:?usage: apply-patches.sh /path/to/chromium/src}"
chromium_base=4744b886309d987d292e43232776d2206cccb13d
v8_base=20ad8d002c17ccc7ccfbefc6c4dcf1242fe80921
[[ "$(git -C "$src" rev-parse HEAD)" == "$chromium_base" ]] || { echo "Chromium is not at 151.0.7922.108" >&2; exit 1; }
[[ "$(git -C "$src/v8" rev-parse HEAD)" == "$v8_base" ]] || { echo "V8 is not at the Chromium 151 revision" >&2; exit 1; }
git -C "$src" diff --quiet && git -C "$src/v8" diff --quiet || { echo "source checkouts must be clean" >&2; exit 1; }
git -C "$src" apply --check "$root/patches/chromium-151/chromium-betterchromium-151.patch"
git -C "$src/v8" apply --check "$root/patches/chromium-151/v8-betterchromium-15.1.patch"
git -C "$src" apply "$root/patches/chromium-151/chromium-betterchromium-151.patch"
git -C "$src/v8" apply "$root/patches/chromium-151/v8-betterchromium-15.1.patch"
echo "BetterChromium 151 patches applied."
