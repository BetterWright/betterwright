# Test a BetterWright binary end to end

The binary E2E suite launches the executable you specify and checks its public
CLI, browser, security, credential, recording, and MCP behavior. It does not
import `src/`, `dist/`, or the target's installed package. It can therefore test
a local build, a globally installed release, or a separately installed candidate
without accidentally testing the checkout instead.

This is a broad regression suite, not proof that every input or external
integration works. Keep the repository's unit, type, package, Electron, and
cross-platform checks alongside it.

## Run it

Use the supported Bun version from `.bun-version`. Install the target binary's
managed browser with that binary's `setup` command first. The suite does not
download browsers, install models, sign in, or call paid providers.

```bash
# Test betterwright on PATH.
bun run test:e2e

# Test a specific executable, including paths containing spaces.
bun run test:e2e /absolute/path/to/betterwright

# Test this checkout's compiled CLI through Bun.
bun run build
bun run test:e2e --binary bun --binary-arg "$PWD/dist/bin/betterwright.js"

# Require every selected case to run, including optional capabilities.
bun run test:e2e /absolute/path/to/betterwright --require-all
```

`--binary-arg` is repeatable and prepends literal arguments to the executable.
There is no shell interpolation. Use absolute paths for launcher scripts and
preloads: target processes run from an isolated temporary working directory.
To use only the suite outside this checkout, copy the complete `tests/e2e/`
directory and run `bun /path/to/e2e/run.ts [binary]`.

The runner honors `BETTERWRIGHT_CHROMIUM_PATH` or
`BETTERWRIGHT_CHROMIUM_ROOT`. Otherwise it points at the invoking user's
existing `~/.betterwright/chromium` installation while isolating the target's
home. Recording checks require FFmpeg with `libx264` and `libvpx`; an encoder
can be selected with `BETTERWRIGHT_FFMPEG_PATH`.

## Select cases and diagnose failures

```bash
bun run test:e2e --list
bun run test:e2e --group security
bun run test:e2e --group cli --group protocol
bun run test:e2e --filter browser.downloads --keep-work
bun run test:e2e --report /absolute/path/to/report.json
```

Groups are `cli`, `browser`, `security`, `protocol`, and `recording`. The filter
matches a case ID or title, case-sensitively. Empty selections and duplicate
case IDs fail instead of producing a successful empty run.

Each command has a 45-second deadline, and each case has a 180-second deadline.
Override them with `--timeout <milliseconds>` and
`--case-timeout <milliseconds>`. A timeout is a failure, not a skip. The runner
continues after failed cases to show more than the first defect.

The default report is `.tmp/e2e-report.json`. It is updated atomically after
each completed case and includes the target version, platform, selected count,
individual durations, failures, skip reasons, and known coverage gaps. An
unfinished report remains marked incomplete. Exit status is nonzero for failed
cases, failed prerequisites, an all-skipped selection, or interrupted work.
With `--require-all`, any skip also fails. Without it, a run with optional
capability skips is explicitly reported as partial rather than fully passed.

Use `--keep-work` to retain isolated homes and artifacts; the report identifies
each case's directory. Those directories can contain synthetic test passwords,
encrypted test vaults, browser profiles, and capability tokens. Treat retained
work as private and do not upload entire directories. The normal runner removes
them after closing its daemons and fixtures. Cleanup failures fail the case
and retain its directory for diagnosis.

## Coverage

Run `--list` for the executable inventory; the case files are the source of truth.

| Area | Behaviors exercised |
| --- | --- |
| CLI | Every advertised command's help route; version and invalid input; inline/file/stdin/REPL snippets; JSON formatting; configuration persistence and key masking; session management; read-only auth/skills/doctor checks; noninteractive vault and cookie validation failures. |
| Browser | Redirects/history/reload; delayed subresources; forms and human-shaped input; Unicode and rich text; frames and shadow DOM; tabs/popups/dialogs; session/profile separation; cookies and local storage across restart; optional stealth isolation and local CDP-failure fallback. |
| Observation and actions | Snapshot refs, scoping, diffing, and caps; control/media/overlay inspection; console events and history; UI batch consent, ambiguity, asserted reads, and stop-on-failure behavior. |
| Artifacts | PNG/JPEG bytes, dimensions, and annotations; artifact paths; upload boundaries; per-run download approval and exact downloaded bytes; MP4/WebM recording, decoded frames, restart, and finalization. |
| Site capabilities | Same-origin requests and assets; local WebAgents and WebMCP fixtures; local checkbox/grid CAPTCHA flows and evidence on errors. |
| Security | Restricted host globals, constructors, private Playwright channels and routing; internal navigation; read/write path and symlink boundaries; metadata/private/loopback/blocked-host policy with positive controls; concurrent download approval isolation. |
| Credentials | Encrypted vault storage and metadata-only output; trusted fill/submit; result/console/error redaction; origin/host/never scopes; ambiguous and missing forms/accounts; staged generation, commit/discard, rotation, and cross-session recovery. |
| Protocols | Real MCP stdio initialization, discovery, validation, browser calls, recovery, and download denial; an `exec` agent turn through a local OpenAI-compatible mock, including tool-result replay and HTTP/malformed-response failures. |
| Lifecycle | Synchronous and asynchronous snippet timeouts, worker restart and cookie persistence, cyclic/oversized output handling, and token-gated live-view streaming with watch-only enforcement and safe detach. |

Assertions check resulting DOM state, fixture requests, file bytes, protocol
messages, and exit statuses rather than treating `ok: true` as sufficient.
An absent browser is a failed prerequisite, not a successful suite with all
browser tests silently skipped. Optional capabilities have explicit skip reasons.

The existing `Node tests` CI job runs the strict suite against the newly built
CLI and uploads its JSON report as `binary-e2e-report`, including on failures.

## Isolation and limits

Every case gets a fresh `HOME`, `USERPROFILE`, XDG directories,
`BETTERWRIGHT_HOME`, temporary directory, profiles, and vault. The environment
is allowlisted: inherited model/provider credentials, preload hooks, and default
profile selections are not passed through. The suite uses local HTTP fixtures
and synthetic credentials. Metadata-policy probes use a local synthetic proxy
that never forwards to the requested destination.

The runner is not an operating-system sandbox for an untrusted executable.
Only point it at a binary you trust: an arbitrary executable can ignore the
isolated environment. The managed browser installation and encoder are shared
read-only prerequisites from the user's normal environment.

These integrations remain outside this automatic local suite:

- Real cloud browsers, provider billing, OAuth/MFA and live model behavior.
- Third-party websites, external CAPTCHA services, and hostile-network/DNS
  rebinding environments.
- Installer/update downloads, local inference installations and GPU execution,
  and interactive onboarding.
- Electron host attachment, OS clipboard/keystroke injection, native extraction
  of personal browser cookies, and master-password entry through a real terminal.
- Exhaustive SDK/export/type contracts, configurable SDK-only resource limits,
  and all operating systems, browser versions, and hardware combinations.

Those gaps are not counted as passing tests. Real-browser fixture tests do not
establish success on live websites, and a mock-model protocol test does not
measure an actual model's ability to complete a task.

## Extend the suite

Add a case with a stable ID, a meaningful outcome assertion, and local fixtures
to the appropriate `tests/e2e/*-cases.ts` module. Use the shared context for
commands, browser runs, HTTP fixtures, cleanup, and registered redaction values.
Do not import the target's internals or alter another case's home. Register
synthetic secrets with `context.redact` before using them so failure messages
cannot inadvertently print them.

`tests/node/e2e-harness.test.ts` separately exercises the runner against a tiny
fake executable, checking argument passing, isolation, deadlines, output bounds,
JSON/exit-code validation, cleanup, redaction, selection, and skip semantics.
Run it after changing harness behavior:

```bash
bun test --timeout 120000 tests/node/e2e-harness.test.ts
bun run build:harness
bun run lint
```
