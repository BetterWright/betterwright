#!/usr/bin/env bash
# Cloud Agent bootstrap for BetterWright. Idempotent: safe to re-run against a
# warm checkout or a fresh pod. Prepares the exact toolchain, dependencies, and
# managed browser the runtime, CLI, and test harness expect.
set -euo pipefail

# 1. Node. package.json pins engines >=22.18.0 and .nvmrc records the exact
#    version; the default image ships nvm, so install/select that version and
#    make it the default so later terminals inherit it.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install
nvm use
nvm alias default "$(tr -d '[:space:]' < .nvmrc)"

# 2. Dependencies, exactly as locked.
npm ci

# 3. Compile the TypeScript runtime + CLI into dist/ and the test/benchmark
#    harness (tsconfig.harness.json), so `node dist/bin/betterwright.js` and the
#    unit suite are ready without a separate build step.
npm run build:harness

# 4. Download the pinned, checksum-verified BetterChromium backend into
#    ~/.betterwright/chromium. Skips the ~200 MB download when already present,
#    so this stays cheap on re-runs and bakes the browser into the build image.
node dist/bin/betterwright.js setup
