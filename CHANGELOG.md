# Changelog

All notable changes to BetterWright are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 1.1.3 predate this file; their notes live on the
[GitHub releases page](https://github.com/BetterWright/betterwright/releases).

## [Unreleased]

### Added

- `chromiumArgs` client option and `BETTERWRIGHT_CHROMIUM_ARGS` for appending
  Chromium switches to the managed launch — `--disable-gpu` on a GPU-less host
  being the motivating case ([#56]). Switches BetterWright owns (proxy
  selection, remote debugging, profile directory, and the `--fingerprint*` /
  `--lang` / `--bw-timezone` / `--headless` identity family) are rejected with a
  `TypeError`. A switch already in the managed list is dropped rather than
  appended, because Chromium resolves duplicate switches last-wins, and the drop
  is reported in the next result's `warnings`.
- `types/agent.d.ts` now declares `sealTranscript`, the `signal` run option, the
  `interrupted` and `no_progress` result reasons, and the `endpointSourceName` /
  `endpointDiscoverySources` / `discoveryTimeoutMs` helpers, all of which the
  runtime already exported.

### Changed

- `import "betterwright/worker"` no longer starts a worker process. The subpath
  resolves to a side-effect-free constants module; `METADATA_RESOLVER_RULES` is
  unchanged.
- `LocalCredentialVault` constructed without `dir` or `home` now honors
  `BETTERWRIGHT_HOME` instead of hard-coding `~/.betterwright`, matching every
  other component. Callers that pass an explicit `home` are unaffected.

### Fixed

- A literal NUL in a skill `autoInject` url pattern was translated into `.*`,
  letting a pattern match paths it did not describe. NULs are now stripped
  before glob translation.
- Host-side secret redaction fails closed: if redaction throws, the result
  envelope is withheld rather than returned unredacted.

[#56]: https://github.com/BetterWright/betterwright/issues/56

## [1.3.1] - 2026-07-24

Credential automation now recovers cleanly when a busy or hostile page
renderer stops answering.

### Fixed

- Explicit credential target document and origin validation is bound to the
  existing credential scan budget, so a wedged renderer cannot stall the call.
- Trusted credential filling no longer runs page-defined element classification
  or `blur()` hooks, closing an avenue for hostile pages to observe the fill.
- Post-fill validation is triggered with bounded trusted keyboard input.
- Failures on busy, blocked, or continuously rendering pages return clearer
  recovery guidance.

No public API or type changes.

## [1.3.0] - 2026-07-24

Released as 1.3.0 rather than 1.2.0: `1.2.0` was published to npm by the
managed-relay release that was later withdrawn, and npm never allows a version
number to be reused.

### Added

- Session daemon protocol 2: every run carries an id, a monotonic `seq`, and a
  bounded replay ring, so a reconnecting client reattaches from its cursor and
  is told plainly when it fell behind.
- `interrupt` op that threads an `AbortSignal` through the agent loop. Ctrl-C
  during `betterwright exec` stops the run and keeps the transcript, so the
  next `exec` on that session resumes from there.
- Orphan detection: a run whose last subscriber leaves is interrupted after a
  grace period (`BETTERWRIGHT_ORPHAN_GRACE_SECONDS`, default 30, `0` disables).
- No-progress guard in the agent loop: three identical consecutive browser
  failures warn the model to change approach; five end the run with
  `reason: "no_progress"`.
- [docs/sessions.md](docs/sessions.md) covering persistence, concurrency,
  interrupting a run, and reconnecting.

### Changed

- Separate sessions now run concurrently (per-session lanes replace the
  client's global queue); calls within one session stay strictly ordered, and
  the browser-wide download permission became a reference-counted gate.
- Credential probes carry a per-frame deadline and an overall scan budget; a
  frame that misses either is named in the failure reason instead of hanging
  the call or being silently absent.
- Transcripts are sealed on interrupt and timeout, so no dangling tool call
  reaches the next provider request.
- Daemon crash hygiene: backpressure drops subscribers that stopped reading,
  oversized request lines are refused, `unhandledRejection` is survived, and
  `uncaughtException` closes gracefully with exit 1.

## [1.1.4] - 2026-07-24

### Removed

- The managed Live View relay and BetterWright account/API-key flows shipped in
  1.2.0, restoring the 1.1.3 local-only Live View behavior. Users on 1.2.0
  should update.

## [1.2.0] - 2026-07-24 [YANKED]

### Added

- A Cloudflare-hosted managed Live View relay with account keys, quotas, and
  billing safeguards. Withdrawn by 1.1.4; the version number is retired on npm.

## [1.1.3] - 2026-07-24

### Added

- Live view and handoff can be opened mid-session, not only at process or task
  start, in every agent mode: `browser_handoff` (MCP), a new `live_view` tool
  and interactive `/live` (standalone), and `betterwright view`, which attaches
  to the session daemon (CLI + skill). Snippets still cannot start the viewer.
- Agent skill sync: `betterwright skill --install` writes the Claude Code and
  Agent Skills directories (`--all` also writes Cursor); `setup` and `update`
  refresh already-installed skill files but never create new ones; `doctor`
  tips when a managed skill is stale.

[1.3.1]: https://github.com/BetterWright/betterwright/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/BetterWright/betterwright/compare/v1.1.4...v1.3.0
[1.1.4]: https://github.com/BetterWright/betterwright/releases/tag/v1.1.4
[1.2.0]: https://github.com/BetterWright/betterwright/releases/tag/v1.2.0
[1.1.3]: https://github.com/BetterWright/betterwright/compare/v1.1.2...v1.1.3
