# Headed and headless browsing

BetterWright launches its managed browser — the [Chromium
fork](chromium-fork.md) installed by `betterwright setup` (macOS arm64 /
Linux x64 / Windows x64). Headed and headless runs use the same persistent
profile, fingerprint identity, network floor, download controls, and browser
worker. To run against a different browser — your own Chromium binary or a
cloud provider's — use the [provider option](browser-providers.md).

## Choosing the display mode

`headless` accepts `true`, `false`, or `"auto"` (the default):

- `"auto"` opens a visible browser window when a display is available and runs
  headless on servers, containers, and CI.
- `false` always requests a visible window.
- `true` always runs headless.

```js
new BetterWright();                    // visible on a desktop, headless on a server
new BetterWright({ headless: false }); // always headed
new BetterWright({ headless: true });  // always headless
```

The CLI equivalent is `betterwright run --headed`. For MCP, set
`BETTERWRIGHT_HEADLESS=0`.

Display detection uses `DISPLAY`/`WAYLAND_DISPLAY` on Linux, the absence of an
SSH-only session on macOS, and the session type on Windows. Override detection
with `BETTERWRIGHT_DISPLAY=1` or `BETTERWRIGHT_DISPLAY=0`.

On a headless Linux host, use a virtual display for headed mode:

```bash
xvfb-run -a betterwright run --headed -c "return page.title()"
```

## Persistent state

Both modes use `$BETTERWRIGHT_HOME/browser/profile` (or
`browser/profiles/<name>` with a named profile). Cookies, local storage,
browser history, and logins therefore survive a switch between headed and
headless runs. Only one process can own the profile at a time; concurrent
workers receive isolated ephemeral profiles rather than corrupting it.

To sign in manually, start one headed run, complete the login in the visible
browser window, then keep using the normal persistent profile. For model-safe
credential filling, prefer the trusted [credential API](credentials.md).

### A second identity

The single-owner rule is per profile, and `profile: "<name>"` makes a new one:
an independent persistent profile at
`$BETTERWRIGHT_HOME/browser/profiles/<name>` with its own cookie jar, lock, and
session daemon.

```js
new BetterWright({ profile: "social" }); // signed in as the posting account
new BetterWright({ profile: "review" }); // signed in as the reading account
```

Both run at the same time, each fully signed in; sign into each one once, the
same way. Omitting `profile` keeps the default `browser/profile`, unchanged.
For parallel work as the *same* identity use `--session` names instead — they
share one browser and one cookie jar. The CLI equivalent is `--profile <name>`;
for MCP, set `BETTERWRIGHT_PROFILE`. See
[sessions.md](sessions.md#sessions-vs-profiles) and
[architecture.md](architecture.md#named-profiles).

## Managed-browser enforcement

These legacy settings are rejected instead of silently choosing a normal
browser:

- `BETTERWRIGHT_BROWSER=chromium` (or `cloak`) — the bundled-fallback
  selector is gone; use `provider` for a non-managed browser
- `CLOAKBROWSER_BINARY_PATH` — CloakBrowser support was removed; use
  `provider: { executablePath }` for a specific local binary
- `betterwright setup --chromium` / `--cloak-only`

To run a browser you supply — a local Chromium binary, a CDP endpoint, or a
cloud provider such as Browser Use, Kernel, or Browserbase — see
[browser-providers.md](browser-providers.md). `betterwright doctor` reports
the backend in use and, for a provider browser, which provider and endpoint
it attached to.

## Troubleshooting headed launch

1. Run `betterwright doctor` and confirm it ends with `BetterWright is ready.`,
   and note which backend the Browser group's **In use** line reports
   (`chromium-fork`, or `provider:<name>`). `doctor --json` gives the same
   facts as the raw `ready` / `browser` fields.
2. Run `betterwright setup` if the managed binary is missing.
3. On Linux, confirm a display is present or use `xvfb-run`.
4. If BetterWright reports that a profile was upgraded by a newer browser,
   move only the path named in that error and sign in again. Vault
   credentials live outside browser profiles and survive a reset;
   browser-saved logins do not.

The managed browser reduces common automation false positives; it cannot
guarantee that a site will accept a session or never present a challenge.
