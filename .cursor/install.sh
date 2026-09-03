#!/usr/bin/env bash
# Cloud Agent bootstrap for BetterWright. Idempotent: safe to re-run against a
# warm checkout or a fresh pod. Prepares the exact toolchain, dependencies, and
# managed browser the runtime, CLI, and test harness expect.
set -euo pipefail

# 1. Bun. package.json pins engines bun >=1.4.0 and .bun-version records the
#    exact patch. The official installer is the only supported fetch: npm
#    tarballs named bun@1.4.1+ have been malware, so never `npm i -g bun`.
BUN_VERSION="$(tr -d '[:space:]' < .bun-version)"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
if ! command -v bun >/dev/null 2>&1 || [[ "$(bun --version)" != "$BUN_VERSION" ]]; then
  curl -fsSL https://bun.com/install | bash -s "bun-v${BUN_VERSION}"
fi
hash -r
bun --version

# 2. Dependencies, exactly as locked.
bun install --frozen-lockfile

# 3. Compile the TypeScript runtime + CLI into dist/ and type-check the
#    test/benchmark harness (tsconfig.harness.json), so
#    `bun dist/bin/betterwright.js` and the unit suite are ready without a
#    separate build step.
bun run build:harness

# 4. Download the pinned, checksum-verified BetterChromium backend into
#    ~/.betterwright/chromium. Skips the ~200 MB download when already present,
#    so this stays cheap on re-runs and bakes the browser into the build image.
bun dist/bin/betterwright.js setup
