# Contributing

Thanks for helping improve BetterWright. This is a small, deliberately-scoped
project; the notes below keep it consistent.

## Repository layout

```
src/                 The Node runtime (the source of truth)
  worker.mjs         The long-lived Playwright worker + sandbox
  client.mjs         The JavaScript client
  policy.mjs         NetworkPolicy (JS)
bin/betterwright.mjs The Node CLI
python/              The Python package
  src/betterwright/  client, bridge, policy, vault, prompt, cli
    integrations/    host adapters (MCP server)
  tests/
tests/node/          Node tests
docs/                Documentation
examples/            Runnable Python and JavaScript scripts
scripts/             Maintenance scripts (worker sync)
```

## The worker is shared — keep the copies in sync

`src/worker.mjs` is the single source of truth for the runtime. The Python
package ships a byte-identical copy at
`python/src/betterwright/_worker/worker.mjs` so a pip-only install is
self-contained. After editing the worker:

```bash
node scripts/sync-worker.mjs          # copy src/ -> python package
node scripts/sync-worker.mjs --check  # what CI runs; fails if they drift
```

CI fails if the two copies differ, so never edit the Python copy directly.

## The two clients must agree

`NetworkPolicy` exists in both `src/policy.mjs` and
`python/src/betterwright/policy.py`, and they must make identical decisions —
the test suites in both languages cover the same cases. If you change one, change
the other and update both suites.

## Running the tests

```bash
# Python
cd python && pip install -e '.[dev]' && pytest

# Node
npm install && npm test
```

The browser-integration tests skip automatically unless the runtime is installed
(`betterwright setup`); the policy, vault, prompt, and challenge suites run anywhere.

## Style

- Python: `ruff` (config in `pyproject.toml`). Type hints on public functions.
- JavaScript: ESM, no build step, no runtime dependencies beyond
  `playwright-core`. `npm run lint` syntax-checks the sources.
- Comments explain *why*, not *what*. Match the surrounding code.

## Scope

BetterWright automates a browser under the user's direction. Changes that would
turn it into a tool primarily for evading anti-bot systems at scale, bulk
account creation, or credential stuffing are out of scope. Features that make
authorized automation safer, clearer, or more reliable are welcome.

## Pinned Playwright

The Playwright version is pinned in three places: `package.json`,
`python/src/betterwright/runtime.py` (`PINNED_PLAYWRIGHT_VERSION`), and
`bin/betterwright.mjs`. A bump changes all three and is tested against the
matching Chromium build.
