#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
src="${1:?usage: apply-patches.sh /path/to/chromium/src}"
chromium_base=507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c
v8_base=f343157cebb388bfa416baccb5d35507e6fe8cc7
[[ "$(git -C "$src" rev-parse HEAD)" == "$chromium_base" ]] || { echo "Chromium is not at 153.0.8010.36" >&2; exit 1; }
[[ "$(git -C "$src/v8" rev-parse HEAD)" == "$v8_base" ]] || { echo "V8 is not at the Chromium 153 revision" >&2; exit 1; }
git -C "$src" diff HEAD --quiet && git -C "$src/v8" diff HEAD --quiet || { echo "source checkouts must be clean" >&2; exit 1; }
git -C "$src" apply --check "$root/patches/chromium-153/chromium-betterchromium-153.patch"
git -C "$src/v8" apply --check "$root/patches/chromium-153/v8-betterchromium-15.3.patch"
git -C "$src" apply "$root/patches/chromium-153/chromium-betterchromium-153.patch"
git -C "$src/v8" apply "$root/patches/chromium-153/v8-betterchromium-15.3.patch"
echo "BetterChromium 153 patches applied."
