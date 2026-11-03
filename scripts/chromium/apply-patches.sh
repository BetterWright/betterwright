#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
src="${1:?usage: apply-patches.sh /path/to/chromium/src}"
chromium_base=23b0e24adfceff6d8e3344ff2641f879bfb314f7
v8_base=d72e817d59894a332093c48beae5749fde6f320f
[[ "$(git -C "$src" rev-parse HEAD)" == "$chromium_base" ]] || { echo "Chromium is not at 156.0.8078.90" >&2; exit 1; }
[[ "$(git -C "$src/v8" rev-parse HEAD)" == "$v8_base" ]] || { echo "V8 is not at the Chromium 156 revision" >&2; exit 1; }
git -C "$src" diff HEAD --quiet && git -C "$src/v8" diff HEAD --quiet || { echo "source checkouts must be clean" >&2; exit 1; }
git -C "$src" apply --check "$root/patches/chromium-156/chromium-betterchromium-156.patch"
git -C "$src/v8" apply --check "$root/patches/chromium-156/v8-betterchromium-15.6.patch"
git -C "$src" apply "$root/patches/chromium-156/chromium-betterchromium-156.patch"
git -C "$src/v8" apply "$root/patches/chromium-156/v8-betterchromium-15.6.patch"
echo "BetterChromium 156 patches applied."
