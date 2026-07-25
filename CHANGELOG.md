# Changelog

All notable changes to BetterWright are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 1.1.3 predate this file; their notes live on the
[GitHub releases page](https://github.com/BetterWright/betterwright/releases).

## [Unreleased]

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
