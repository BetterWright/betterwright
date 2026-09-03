# Contributing

Thanks for helping improve BetterWright. This is a small, deliberately-scoped
project; the notes below keep it consistent.

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Repository layout

```
src/                 The Bun runtime (the source of truth)
  worker.ts          The long-lived Playwright worker + sandbox
  client.ts          The TypeScript client
  policy.ts          NetworkPolicy
bin/betterwright.ts  The Bun CLI
dist/                Generated ESM JavaScript (not committed)
tests/node/          Unit and browser tests
docs/                Documentation
examples/typescript/ Runnable TypeScript scripts
scripts/             Build and release scripts
research/            Internal probes and operator tools (not shipped)
```

## Running the tests

The supported Bun version is in [`.bun-version`](.bun-version).

```bash
bun install --frozen-lockfile
bun run release:check
```

For the complete managed-browser integration suite, install the runtime and run
`BETTERWRIGHT_REQUIRE_BROWSER=1 BETTERWRIGHT_CHROMIUM_ROOT=off bun run test`.
The policy, vault, prompt, and challenge suites run anywhere.

One note on running the suite locally: **do not run the tests as root.**
Several tests simulate an unwritable directory with `chmod`, which root
bypasses; they detect this and skip, so a root run reports green while
leaving those paths unexercised.

The unit suite runs and gates on Linux, macOS, and Windows in CI. Windows
filesystem semantics differ in ways that matter here (a directory cannot be
renamed while a handle is open to a file inside it); the recorded evidence
behind the vault's Windows branches lives in `research/windows-fs-probe.mjs`.

## Style

- Runtime and CLI sources are TypeScript 7 ESM compiled to ordinary ESM
  JavaScript in `dist/`; Bun runs the CLI and worker. Keep NodeNext import
  specifiers ending in `.js`, because that is the emitted filename the
  published package loads.
- Runtime dependencies stay exact-pinned. `bun run lint` covers `src`, `bin`,
  `scripts`, `research`, `tests`, `benchmarks`, and `examples`;
  `bun run typecheck` checks implementation sources; `bun run test:types`
  verifies the hand-written published declarations.
- Comments explain *why*, not *what*. Match the surrounding code.

## Scope

BetterWright automates a browser under the user's direction. Changes that would
turn it into a tool primarily for evading anti-bot systems at scale, bulk
account creation, or credential stuffing are out of scope. Features that make
authorized automation safer, clearer, or more reliable are welcome.

## Licensing and attribution

Unless explicitly agreed otherwise in writing, every contribution submitted
for inclusion in BetterWright is licensed under the repository's
[MIT License](LICENSE). By submitting a contribution, you confirm that you have
the right to license it on those terms.

Contributors retain copyright in their contributions. Preserve applicable
copyright, license, and third-party notices, and do not submit code under terms
that conflict with the MIT License. Project identity and fork guidance are in
[NOTICE.md](NOTICE.md) and [TRADEMARKS.md](TRADEMARKS.md).

## Pinned Playwright

The Playwright version is pinned in `package.json`. A bump is tested against
the matching Chromium build.

## Releasing

1. Bump the package version.
2. Record the release's notable changes in `CHANGELOG.md`, in the same commit as
   the version bump.
3. Run `bun install --frozen-lockfile` followed by `bun run release:check`.
4. Merge the release commit, create the matching `vX.Y.Z` tag from `main`, and
   publish a GitHub Release for that tag.
5. `publish-npm.yml` verifies that the release commit belongs to `main`, runs
   the complete suite against the pinned Chromium build, and publishes
   through npm Trusted Publishing with provenance.

The npm Trusted Publisher is configured in the package settings for owner
`BetterWright`, repository `betterwright`, workflow `publish-npm.yml`,
environment `npm`.

The npm tarball intentionally excludes browser binaries, profiles, tests,
documentation images, and repository caches. Browser
installation remains an explicit setup step.
