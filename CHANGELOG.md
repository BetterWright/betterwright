# Changelog

All notable changes to BetterWright are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 1.1.3 predate this file; their notes live on the
[GitHub releases page](https://github.com/BetterWright/betterwright/releases).

## [Unreleased]

### Added

- Headless sessions now use checksum-pinned Obscura 0.1.11 for resident DOM,
  JavaScript, storage, and network execution. Screenshots preserve the public
  API by launching the existing Chromium/Cloak renderer only for the capture
  and transferring URL, cookies, storage, controls, scroll, and canvas state.
- Added the frozen, same-origin `site` surface for inspecting application
  assets and request metadata, reading bounded text excerpts, and issuing
  cookie-bearing JSON requests. This provides general client-app tooling
  without embedding site-specific endpoints or puzzle instructions.

### Changed

- `betterwright setup` installs Obscura plus the pixel renderer; `update`
  refreshes the pinned Obscura release. Headed and explicit `--cloak-only`
  sessions retain the Chromium/Cloak compatibility backend.

## [1.6.3] - 2026-08-03

A performance release, continuing 1.6.2. No API changes: 1.6.3 is a drop-in
replacement for 1.6.2. The theme is round trips — between the worker and the
client, and between the worker and the browser.

### Added

- `benchmarks/perf`, a regression harness for this work: per-action latency
  with an adjacent late-session control so per-session drift is not charged to
  the thing being measured, guard RPCs counted at the client boundary and
  bucketed by origin, and the challenge-scan tax at 10 and 24 genuinely
  cross-site frames. Fixture servers count their own requests and the run fails
  if a load is not exactly the expected size, so a browser-cache artifact cannot
  be mistaken for a win.

### Changed

- Guard decisions are cached in the worker. Every browser connection previously
  cost a full RPC to the client process per policy check — one per HTTP request,
  plus one per hostname and one *serial* RPC per resolved IP in the SOCKS guard.
  For a stock `NetworkPolicy` the verdict is a pure function of scheme, host and
  port, so those answers are now cached (5 s, 2048 entries). On a 50-subresource
  page load: **95 guard RPCs to 1**.

  The client, which is the only process the policy lives in, decides per
  response whether it may be cached at all — a `custom` hook, a subclass, an
  instance-patched `check` or any other object is never eligible, checked per
  RPC rather than once at construction. Full-URL checks (navigations, documents,
  downloads, websockets) are never cached in either direction, and a failed
  check is never cached, so the transport still fails closed on retry.
  Mutating `allowHosts`/`blockHosts` mid-session takes up to 5 s to apply to a
  host already contacted; installing a `custom` hook empties the cache instead,
  so it governs hosts already seen. See "Decision caching" in
  `docs/network-policy.md`.

- Resolved addresses are validated in one parallel wave rather than serially.
  Every address is still decided before any connect, and failures are reported
  in address order rather than settle order, so which error a caller sees does
  not depend on guard timing.

- Challenge detection is now staged. Every `run()` still reads the main frame's
  title, text and provider response tokens, but the per-frame walk — one round
  trip per frame, previously paid on every action — runs only when something
  already points at a challenge: a provider URL, matching main or same-origin
  frame text, a recent 403/429/503 document response, a challenge left
  unresolved by the previous action, or an unreadable cross-origin frame.
  Benign iframes no longer tax every agent action. `captcha.solve()` and
  `captcha.detect()` are unchanged and always read every frame. See
  "When detection runs" in `docs/captcha.md`, including the one accepted
  limitation: a page with more than three opaque cross-origin frames where the
  challenge is identifiable only by the text inside one of them.

  On the benchmark fixture the per-action iframe tax falls from **+27–30 ms to
  +1.5–1.7 ms at 10 cross-site frames**, and from **+54–60 ms to +2.4–4.1 ms at
  24**. Stage 2 also dropped from about five round trips per frame to two, and
  now reads frame text and checked state through utility-world locators, so page
  script cannot shape what the detector sees — detection is harder to fool than
  it was before, not just cheaper.

- The sandbox no longer recompiles its constant realm factory on every execute;
  the `vm.Script` is built once at module load. Snippet compilation moved to
  `src/compile-code.ts`, which tries the statement form first for snippets that
  cannot begin an expression. Which form runs is unchanged — including the
  sloppy-mode cases where `let` is an identifier (`let.x`, `let in o`,
  `let instanceof X`), which must stay expression-first — and a seeded
  differential corpus evaluates both orders to prove it.

  This shows up on trivial snippets rather than real ones: on a quiet page,
  per-action latency is unchanged within noise, because a snippet that touches
  the page is dominated by its round trip rather than by compilation.

## [1.6.2] - 2026-08-02

A performance release. No API changes: 1.6.2 is a drop-in replacement for
1.6.1.

### Changed

- `NetworkPolicy.check` — the per-request hot path behind the guard proxy —
  no longer re-parses its private/loopback CIDR literals on every call: the
  ranges are parsed once at module load. Allow/block host entries are parsed
  (lowercase, trim, port split, bracket strip) once and cached in a bounded
  map instead of on every host check, and the scheme test uses a `Set` rather
  than allocating an array per call. Measured at 300k checks: 409 ms → 311 ms.
- `filterInteractive` replaces its backwards ancestor scan — quadratic on
  large snapshots, because every interactive line rescanned toward the root —
  with parent links from a single monotonic-stack pass, stopping early on
  ancestors already kept. Indents and property-line tests are computed once
  per line instead of inside two inner loops. A 3000-line snapshot filters in
  0.3 ms instead of 22 ms; output is unchanged, verified line for line against
  the previous implementation by a randomized differential suite.

## [1.6.1] - 2026-07-31

A performance release. No API removals and no behavior flags to set: 1.6.1 is a
drop-in replacement for 1.6.0.

### Added

- **Idle sessions no longer burn CPU.** A headless Chromium target never becomes
  hidden — `document.visibilityState` stays `"visible"` for the life of the page
  — so every open page kept its frame loop running at the host refresh rate
  (measured at ~120 fps) whether or not anything was driving it. A session with
  five ordinary animated tabs burned **~110% CPU while completely idle**, and
  four agents made that four times over. BetterWright now parks a session's
  pages once its last execution unwinds — page script is disabled and animation
  timelines are set to rate zero — and restores them before the next execution
  begins, so the quiet window is exactly the model's thinking time.

  Measured on the pinned fork (150.0.7871.129), idling with tabs open:

  | scenario | 1.6.0 | 1.6.1 |
  | --- | --- | --- |
  | 1 session, 5 tabs | 97% CPU, 1845 MB | **25% CPU, 1709 MB** |
  | 4 sessions, 3 tabs each | 129% CPU, 3805 MB | **53% CPU, 3529 MB** |

  Parking never applies in headed mode or while a live view is streaming — a
  frozen page is a bug when a human is watching one — and it waits for the
  session to be genuinely idle (750 ms), so an agent's back-to-back calls never
  pay for it. Pages with credential capture in flight are left running, because
  the vault sensor lives in an isolated world and script execution is disabled
  per renderer, not per world. Turn it off with `parkBackgroundPages: false` or
  `BETTERWRIGHT_PARK_BACKGROUND_PAGES=0`.

  The one behavior change: a page animated by a `requestAnimationFrame` chain
  does not resume that chain after being parked, because the pending callback
  never fires and so nothing re-registers it. Everything else — in-page state,
  `setInterval`/`setTimeout`, CSS and Web Animations, clicks, typing,
  navigation, screenshots, network, newly registered `requestAnimationFrame`
  callbacks — resumes normally.

### Changed

- `diffSnapshots` interns snapshot lines before building its LCS table, so the
  inner loop compares integers instead of strings, and stores the table as
  `Uint16Array` rather than `Uint32Array` — subsequence lengths are bounded by
  the 3000-line cap, so the wider type was never needed. A one-sided change
  (everything added, or everything removed) now skips the table entirely. At
  the size cap the transient allocation drops from 34 MB to 17 MB per call.
  Output is unchanged: a randomized suite checks it line for line, tie-breaks
  included, against the 1.6.0 implementation.

### Fixed

- Parking exposed, and this release fixes, an ordering hazard in how the worker
  brackets executions: work queued as one execution unwinds could land after
  the next one had already started. Park/wake now reconcile toward a recorded
  intent rather than deciding from the state at call time, so whoever asks last
  wins regardless of the order the CDP traffic lands in.

## [1.6.0] - 2026-07-31

### Added

- `CODE_OF_CONDUCT.md`, GitHub issue forms, a pull-request template, and
  `CODEOWNERS`.
- A cross-platform CI job covering Linux, macOS, and Windows on Node 22 and 24,
  an advisory dependency-audit job, per-job timeouts, and cancellation of
  superseded pull-request runs. All six platform legs gate merges.
- `.nvmrc` and `.gitattributes`, the latter pinning LF so the byte-exact
  `SKILL.md` test passes in a Windows working tree.

### Changed

- `engines.node` is now `>=22.18.0`, the version the shipped TypeScript
  examples already required. CI and the publish workflow build on that same
  version, which previously differed from each other.
- Documented benchmark results now carry their methodology: the Online-Mind2Web
  figure is labelled self-judged and best-validated rather than one-shot, and
  the unsubstantiated observation-token claim was replaced with a description
  of what the snapshot compressor actually prunes.
- Operator and research tooling moved from `scripts/` to `research/`, which is
  documented as unsupported and is not part of the build.
- Documentation images are referenced by absolute URL so they render from the
  published npm tarball, which does not ship them.

### Fixed

- The credential vault's multi-process lock now works on Windows, where a
  directory cannot be renamed while any handle is open to a file inside it and
  a file cannot be renamed over a destination another process holds open. The
  lease opens after the publish rename there (ownership is re-proven by token
  and file identity), lock retirement and vault writes briefly outlast
  concurrent readers pinning their destination, and a quarantine blocked by a
  live owner's open lease keeps waiting instead of crashing. The recorded
  filesystem evidence lives in `research/windows-fs-probe.mjs`, and the entire
  unit suite that surfaced this — 49 failing tests at first contact — now
  passes and gates on Windows.
- `human.type` actually clears the field before typing on the default
  BetterWright Chromium fork. Its clear step pressed `Control+A` and trusted
  the browser to select-all, but the fork does not run the select-all editing
  command for synthesized keyboard events, so typed text landed in front of
  the old value. The clear now selects through the element itself, which works
  on every browser build, inside iframes, and for contenteditables.
- The live view no longer delivers the same frame to the same viewer twice
  when a visibility repaint races the broadcast; every delivery path now goes
  through one per-client gate.
- `mkdirPrivate` tightens permissions only on directories it actually creates.
  It previously re-chmodded a pre-existing directory to `0700` — for the
  profile lock, that directory is wherever the user pointed the profile,
  silently revoking access the user had deliberately granted.
- The JWT payload decoder names `base64url` explicitly instead of relying on
  Node's lenient `base64` decoder accepting the URL-safe alphabet.
- `NetworkPolicy.checkHost`, `downloadPolicyFromEnv`, and the daemon's identity
  platform are typed against the published declarations, so an implementation
  that drifts from `types/` now fails the build.

## [1.5.2] - 2026-07-30

### Changed

- The Linux x64 Chromium fork now uses file-backed FontDataService transport
  and a four-renderer soft limit. These reduce summed Chromium PSS by at least
  25% at 1, 5, 10, and 20 same-site tabs in the validated four-vCPU workload,
  while preserving full Site Isolation, process locks, fingerprint output,
  and an explicit `--renderer-process-limit` override.

### Fixed

- Chromium-only GitHub Releases no longer start the npm publishing job; only
  package release tags beginning with `v` may enter Trusted Publishing.

## [1.5.1] - 2026-07-28

### Fixed

- Managed Cloak sessions now allow native service-worker registration, matching
  the Chromium-fork path and ordinary Chrome behavior while keeping all worker
  traffic behind the policy guard proxy.
- Dormant CAPTCHA providers preloaded in hidden or zero-size iframes no longer
  appear as active challenges. A visible widget or blocking verification prompt
  is still detected and follows the existing solve/handoff flow.

### Changed

- Completed the repository-wide TypeScript migration for build and release
  scripts, tests, benchmarks, and shipped examples. Published examples now live
  under `examples/typescript/*.ts` and are type-checked against the public
  declarations; runtime package exports remain ordinary JavaScript.

### Added

- The pinned BetterWright Chromium 150 fork now ships for Windows x64 in
  addition to macOS arm64 and Linux x64. `betterwright setup` and
  `betterwright update` verify and install the Windows artifact using the
  built-in `tar.exe`, then select it as the zero-configuration default.
  CloakBrowser remains the explicit or automatic fallback when the fork is
  disabled or absent. Windows doctor output also avoids the Linux-only
  fontconfig warning because Windows uses DirectWrite.
- Named browser profiles: `profile` on the `BetterWright` constructor,
  `--profile <name>` on the CLI, and `BETTERWRIGHT_PROFILE` for the MCP server
  and any shell (the flag wins). A
  profile is a separate identity inside one home — its own cookie jar at
  `browser/profiles/<name>`, its own profile lock, its own session daemon
  (`daemon-<name>.sock`), and its own `exec` transcripts — so two identities
  run at the same time and both stay signed in. `--session` remains the way to
  run parallel work as the *same* identity. `betterwright sessions` now lists
  every profile's daemon and `close --all` stops all of them; anything narrower
  acts only on the selected profile.
- Omitting `profile` changes nothing on disk: the same `browser/profile`
  directory, the same lock, the same `daemon.sock`, and the same
  `sessions/<name>/` transcripts. There is no migration. Upgrading while a
  daemon is running restarts that daemon once (its config signature now
  records the profile), as any flag change does.

## [1.5.0] - 2026-07-25

### Changed

- Migrated all runtime and CLI source files to TypeScript 7.0.2. The package
  now compiles NodeNext ESM into `dist/` and publishes ordinary JavaScript, so
  consumers need no TypeScript loader and existing imports, CLI commands, and
  public type declarations remain compatible.
- Tests, benchmarks, the Pi extension manifest, CI, and the npm release
  workflow now exercise the compiled artifacts instead of bypassing the build.
- Refreshed CloakBrowser's compatible `tar` transitive dependency to 7.5.22,
  including the fix for crafted-archive stack exhaustion.

### Added

- A no-emit typecheck and fail-closed TypeScript build with missing-import,
  switch-fallthrough, unreachable-code, and incomplete-return checks.
- Build-layout and package-contract gates that prove every TypeScript source
  emits JavaScript, every package export resolves, relative runtime imports are
  complete, CLI/worker entrypoints are executable, and no TypeScript source is
  included in the npm tarball.

No direct runtime dependency or public API changes.

## [1.4.0] - 2026-07-25

Getting started is one command, and the vault is no longer a one-way door.

### Added

- **`betterwright init`** — guided first-time setup. Checks Node, downloads the
  managed browser if it is missing, installs the agent skill into whichever
  hosts it detects (`~/.claude`, `~/.agents`, `~/.cursor`, and `~/.codex`'s
  `AGENTS.md` between managed markers), offers MCP registration when the Claude
  CLI is present, and finishes by loading a real page — because "installed" and
  "working" are different claims. Idempotent; `--yes` for scripts, plus
  `--skip-browser` / `--skip-agents`.
- **`betterwright vault`** — the human-facing view of the credential vault:
  `list`, `show`, `copy`, `rm`, `audit`, `path`. A password the agent generated
  during a signup or captured from a login you typed was previously
  unreachable, because every existing vault path is site-scoped and
  metadata-only by design.
  - `--reveal` is required to print a secret, and refuses any destination that
    is not a terminal so a redirect, a pipe, or a captured stdout cannot
    collect one by accident (`--force` /
    `BETTERWRIGHT_VAULT_ALLOW_NON_INTERACTIVE=1` overrides).
  - `vault copy` sends the password to the system clipboard, so it never
    enters terminal scrollback or shell history.
  - Every reveal is written to the metadata-only audit log.
- `LocalCredentialVault` owner-only methods behind those commands: `ownerList`,
  `ownerReveal`, `ownerRemove`, `ownerAudit`. They are deliberately **not**
  routable through `handleRequest`, the only surface the browser worker — and
  therefore model-authored snippet code — can address, so the model-facing
  boundary is unchanged. Declared in `types/vault.d.ts`.
- `betterwright/vault` subpath export, so a trusted JS host can use those
  owner-only methods (and the `VaultOwnerListResult` / `VaultRevealedRecord` /
  `VaultAuditEntry` types) without reaching into `src/`.
- `betterwright skill --status` reports where the agent skill is installed and
  whether each copy matches this package version.
- `betterwright mcp --check` verifies the MCP server can start (SDK peer plus
  browser) without going through a client that swallows the error.
- `betterwright doctor --json` and `--quiet`; the report now also covers which
  agent hosts are wired, whether the MCP SDK is present, which model backends
  are usable, and where the vault lives.
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

### Performance

- **The CLI no longer loads the browser/worker/agent stack to talk to a running
  daemon.** `daemon.mjs` constructed a `BetterWright` at import, so any client
  that imported it for a socket path or config signature pulled the whole
  browser graph (~20 ms) with it; the CLI entrypoint compounded this by
  importing the agent and browser modules statically. The browser stack is now
  loaded on first construction and the daemon builds its browser lazily, so the
  hot `run` / `close` / `vault` / `sessions` / `view` paths — which only send an
  RPC to an already-running daemon — skip it. Cold CLI start dropped from
  ~46 ms to ~39 ms, a saving paid on every invocation, and the daemon-client
  import graph shrank from ~16 ms to ~5 ms.

### Changed

- **`--help` no longer runs the command.** `setup --help` downloaded a 200 MB
  browser, `update --help` downloaded the Chromium fork, `run --help` blocked
  forever reading stdin, `close --help` closed your session, `view --help`
  started a live-view server, and `skill --help` printed nine kilobytes of
  agent instructions. Every subcommand now has real help, resolved before
  dispatch, and `-h` works wherever `--help` does. `betterwright help <command>`
  is equivalent.
- `betterwright doctor` prints a grouped report — runtime, browser, agent
  integration, built-in agent, credentials — where each line carries `✓`/`!`/`✗`
  and every failure names the command that fixes it. The previous flat
  key/value dump is still available verbatim under `--json`.
- The default model for `exec` and the interactive console follows what is
  actually configured rather than always being `claude-opus-4-8`. A user who
  had signed in with `auth --login codex` — the sign-in the README recommends
  first — previously hit "@anthropic-ai/sdk is not installed" on their first
  task with a working backend already available. When no backend is configured
  at all, both paths now say so up front, with the four ways to fix it, instead
  of failing inside the model adapter.
- The agent skill tells agents that `betterwright vault` is the user's command,
  not theirs: `vault list` is fine, `show --reveal` / `copy` / `rm` are not.
- `import "betterwright/worker"` no longer starts a worker process. The subpath
  resolves to a side-effect-free constants module; `METADATA_RESOLVER_RULES` is
  unchanged.
- `LocalCredentialVault` constructed without `dir` or `home` now honors
  `BETTERWRIGHT_HOME` instead of hard-coding `~/.betterwright`, matching every
  other component. Callers that pass an explicit `home` are unaffected.

### Fixed

- **`vault get --reveal` no longer bypasses the non-terminal reveal gate.**
  `get` is an alias of `show`, but the guard keyed on the subcommand name, so
  `vault get <id> --reveal > file` printed a secret to a pipe with no `--force`
  — the one spelling with no gate. Every path that puts plaintext on stdout is
  now gated; only `vault copy` (clipboard, never stdout) is exempt.
- **Browser capture no longer duplicates — or silently widens the scope of, or
  drops — a credential during a generated signup.** `generateAndFill` types its
  secret into the page, so the capture sensor saw an ordinary accepted
  submission and saved it a second time, leaving two records per agent signup;
  the duplicate used capture's `base-domain` default, widening a credential
  scoped to `host` / `exact-origin` across the whole registrable domain. The
  suppression now happens inside the vault, keyed on whether the submitted
  password *is* the pending generated secret (a constant-time compare) rather
  than on a username guess — so a *different* password typed at the same site
  during the pending window (a failed fill retried by hand, or a headed user's
  own "Save password?") is still saved instead of being silently lost.
- **A configured model backend is no longer refused by `exec`.** The default
  model and `doctor`'s readiness check resolved the optional `@anthropic-ai/sdk`
  peer only next to the package, missing a project-local copy — so a global
  install with `ANTHROPIC_API_KEY` and the SDK in the project (which worked
  before) hit exit 1 with "install a package you already installed". Both now
  use the same working-directory-aware resolution the model adapter uses.
  `doctor` and `exec` also agreed to disagree about OpenRouter/Ollama/API-key
  backends: `exec` refused what `doctor` called ready. `exec` now accepts a
  plain `OPENAI_API_KEY` / `XAI_API_KEY`, and for a source with no default
  model id (OpenRouter, Ollama) it prints "name one with `--model source/id`"
  instead of the false "no backend configured".
- **`betterwright init` is safe to re-run and survives a bad host.** Editing
  `~/.codex/AGENTS.md` refused to guess when its markers were not a clean pair
  (an orphaned marker used to splice out the user's text on the second run) and
  writes atomically; its block now carries a version stamp so an upgrade
  replaces it instead of appending. One unwritable agent host no longer aborts
  the whole run before verification; a network failure at the verify step warns
  instead of failing after everything installed; a run that verified nothing
  (`--skip-browser`) no longer claims "ready"; and `-y` works as `--yes`.
- **A deep or symlinked `BETTERWRIGHT_HOME` no longer costs you session
  persistence.** Beyond the socket-length fallback below, the fallback
  directory hardening no longer runs against — or chmods — the user's own home
  on the natural path (it applies only to the shared-tmpdir fallback), the home
  hash resolves symlinks so two spellings of one home share one daemon, and a
  programmatic `connectSessionDaemon({home})` now pins that home into the
  spawned daemon so client and daemon bind the same socket.
- `types/vault.d.ts`: `VaultRevealedRecord` and `ownerRemove`'s return no
  longer require `id`/`updatedAt`, which a revealed or removed *pending* signup
  does not carry.
- **A deep `BETTERWRIGHT_HOME` no longer costs you session persistence.** A
  unix socket path is capped by `sockaddr_un.sun_path` (104 bytes on macOS, 108
  on Linux) and the kernel rejects a longer one with `EINVAL`, so a home under
  a long path — a CI workspace, a deep project directory, a container mount —
  killed the session daemon on `listen`. Every `run`/`exec` then fell back to a
  private browser, reporting only "the session daemon did not start". Such a
  home now binds a short owner-only socket derived from it, in a `0700`
  directory whose ownership is verified before use.
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

## [1.2.0] - 2026-07-24 [YANKED]

### Added

- A Cloudflare-hosted managed Live View relay with account keys, quotas, and
  billing safeguards. Withdrawn by 1.1.4; the version number is retired on npm.

## [1.1.4] - 2026-07-24

### Removed

- The managed Live View relay and BetterWright account/API-key flows shipped in
  1.2.0, restoring the 1.1.3 local-only Live View behavior. Users on 1.2.0
  should update.

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

[Unreleased]: https://github.com/BetterWright/betterwright/compare/v1.6.3...HEAD
[1.6.3]: https://github.com/BetterWright/betterwright/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/BetterWright/betterwright/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/BetterWright/betterwright/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/BetterWright/betterwright/compare/v1.5.2...v1.6.0
[1.5.2]: https://github.com/BetterWright/betterwright/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/BetterWright/betterwright/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/BetterWright/betterwright/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/BetterWright/betterwright/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/BetterWright/betterwright/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/BetterWright/betterwright/compare/v1.1.4...v1.3.0
[1.2.0]: https://github.com/BetterWright/betterwright/releases/tag/v1.2.0
[1.1.4]: https://github.com/BetterWright/betterwright/releases/tag/v1.1.4
[1.1.3]: https://github.com/BetterWright/betterwright/compare/v1.1.2...v1.1.3
