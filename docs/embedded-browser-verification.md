# Embedded browser verification

Verified on macOS on September 9, 2026, using Bun 1.4.0, Electron 43.4.1,
and managed BetterChromium 151.0.7922.108. All browser profiles and credentials
were disposable fixtures. No personal app profile or real account was used.

## Review fixes

- Cancellation retains the secret-free recovery details needed to commit or
  discard a staged generated credential, even if teardown fails.
- A failed host attachment can reconnect on the next explicit run after the old
  connection drains.
- Debugger detach revokes the transport, settles pending work and reports the
  closed connection synchronously. The next explicit run replaces stale worker
  handles without replaying an action or closing the host tab.
- PDF export uses Electron's native printing API. Stream reads are restricted to
  handles issued to the leased target, with bounded retained data and cleanup.

## Results

| Check | Result |
| --- | --- |
| Release checks, `bun run release:check` | Passed; 1,053 unit passes, 3 optional skips, 0 failures; public types and package consumer smoke passed |
| Full managed suite, `BETTERWRIGHT_REQUIRE_BROWSER=1 BETTERWRIGHT_REQUIRE_RECORDING=1 bun run test` | 1,143 passed, 3 optional skips, 0 failures across 80 files |
| Native Electron, `bun run test:electron` | Passed: 8 reliability checkpoints and 2 detach/recovery checkpoints |
| ASAR, `bun run test:electron:packaged` | Both archives passed the same reliability and detach/recovery checks |
| Independent native detach reproduction | Passed after the fix, including an interrupted pending evaluation and immediate same-instance recovery |
| Additional local embedding fixture | 5 flows passed: isolated targets, cross-site iframe, actual webview focus, 75% zoom and 150% zoom |
| Whitespace check, `git diff --check` | Passed |

Lint has 22 existing warnings and no errors. The packaged run emitted a non-fatal
macOS `TASK_SUPPRESSION_POLICY` diagnostic; its assertions and exit status passed.

## Native acceptance coverage

- Hidden host tab, 125% zoom, batched input and empty array results.
- Shortcut denial, modifier recovery and host-owned tab lifetime.
- Real system clipboard copy and paste, with the prior clipboard restored privately.
- Exact staged uploads; rejection of unapproved paths and in-memory payloads.
- Network denial for native renderer requests outside the model sandbox.
- Cancellation and debugger detach without closing the host's page.
- Immediate recovery on the same client after idle detach and pending evaluation
  interruption. Connection and save counts verify that no action is replayed.
- Authenticated single-tab attachment, metadata-only save prompt and sensor disposal.
- Default PDF output and custom 6 by 9 inch output, including its 432 by 648 point
  MediaBox. Both unpackaged and ASAR runs exercised the native printing API.

The additional local-only fixture used ordinary controls in two separate native
sessions and an actual webview. Guest input did not enter the host field or the
other target. A 390 by 844 host viewport worked at 75% and 150% guest zoom.
That extra fixture is not committed; the reliability and detach fixtures are.

The native reliability fixture writes a synthetic image to
`artifacts/electron-e2e/native-browser.png`. See [host integration](electron-host.md)
for setup and ownership requirements.

## Limits

The three skipped tests are opt-in live reCAPTCHA, hCaptcha and Cloudflare
Turnstile demos. Local CAPTCHA fixtures and required recording tests were exercised.
Native Electron on Windows and Linux, real account login and external OAuth flows
were not verified. Clipboard fixture shortcuts now select the platform's primary
modifier, but this does not establish native coverage on those other platforms.

Protocol unit tests use a fake native debugger with real Playwright and loopback
WebSockets. They complement the native runs; they do not replace them. Token savings
remain unbenchmarked. These changes do not include host chat UI or scheduling, and
no release was created during this review.
