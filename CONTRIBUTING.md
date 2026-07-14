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
npm ci && npm test
```

The browser-integration tests skip automatically unless the runtime is installed
(`betterwright setup`); the policy, vault, prompt, and challenge suites run anywhere.

## Style

- Python: `ruff` (config in `pyproject.toml`). Type hints on public functions.
- JavaScript: ESM, no build step, and exact runtime dependency pins.
  `npm run lint` syntax-checks the sources and `npm run test:types` verifies the
  published declarations.
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

## Releasing

### One-time npm bootstrap

Trusted Publishing can only be attached after the package exists. For the first
release only:

1. Merge the release commit to `main`, run `npm ci` and
   `npm run release:check`, then sign in with `npm login`.
2. Claim the package with `npm publish --access public` before creating the
   GitHub release.
3. In the npm package settings, add the GitHub Trusted Publisher for owner
   `CuriosityOS`, repository `betterwright`, workflow `publish-npm.yml`, and
   environment `npm`.
4. Protect release tags and the repository's `npm` environment before enabling
   future maintainers to create releases.

### Normal releases

1. Update `CHANGELOG.md` and keep the npm/Python versions aligned.
2. Run `npm ci` followed by `npm run release:check`.
3. Merge the release commit, create the matching `vX.Y.Z` tag from `main`, and
   publish a GitHub Release for that tag.
4. `publish-npm.yml` verifies that the release commit belongs to `main`, runs
   the complete Node suite against the pinned Chromium build, and publishes
   through npm Trusted Publishing with provenance.

The npm tarball intentionally excludes browser binaries, profiles, Python
artifacts, tests, documentation images, and repository caches. Browser
installation remains an explicit setup step.
