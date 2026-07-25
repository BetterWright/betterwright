# Contributing

Thanks for helping improve BetterWright. This is a small, deliberately-scoped
project; the notes below keep it consistent.

## Repository layout

```
src/                 The Node runtime (the source of truth)
  worker.mjs         The long-lived Playwright worker + sandbox
  client.mjs         The JavaScript client
  policy.mjs         NetworkPolicy
bin/betterwright.mjs The Node CLI
tests/node/          Node tests
docs/                Documentation
examples/            Runnable JavaScript scripts
scripts/             Maintenance scripts
```

## Running the tests

```bash
npm ci && npm test
```

The browser-integration tests skip automatically unless the runtime is installed
(`betterwright setup`); the policy, vault, prompt, and challenge suites run anywhere.

## Style

- JavaScript: ESM, no build step, and exact runtime dependency pins.
  `npm run lint` runs Biome's lint rules over `src`, `bin`, `scripts`, and
  `tests`, and `npm run test:types` verifies the published declarations.
- Comments explain *why*, not *what*. Match the surrounding code.

## Scope

BetterWright automates a browser under the user's direction. Changes that would
turn it into a tool primarily for evading anti-bot systems at scale, bulk
account creation, or credential stuffing are out of scope. Features that make
authorized automation safer, clearer, or more reliable are welcome.

## Pinned Playwright

The Playwright version is pinned in `package.json`. A bump is tested against
the matching Chromium build.

## Releasing

1. Bump the package version.
2. Record the release's notable changes in `CHANGELOG.md`, in the same commit as
   the version bump.
3. Run `npm ci` followed by `npm run release:check`.
4. Merge the release commit, create the matching `vX.Y.Z` tag from `main`, and
   publish a GitHub Release for that tag.
5. `publish-npm.yml` verifies that the release commit belongs to `main`, runs
   the complete Node suite against the pinned Chromium build, and publishes
   through npm Trusted Publishing with provenance.

The npm Trusted Publisher is configured in the package settings for owner
`BetterWright`, repository `betterwright`, workflow `publish-npm.yml`,
environment `npm`.

The npm tarball intentionally excludes browser binaries, profiles, tests,
documentation images, and repository caches. Browser
installation remains an explicit setup step.
