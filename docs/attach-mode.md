# Headed and headless browsing

BetterWright launches its managed browser — the [Chromium
fork](chromium-fork.md) when its artifact is installed (macOS arm64 / Linux
x64), CloakBrowser otherwise. Headed and headless runs use the same persistent
profile, fingerprint identity, network floor, download controls, and browser
worker. There is no stock-Chromium fallback and no ordinary-Chrome CDP attach
mode.

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

- `browser: "chromium"` or `BETTERWRIGHT_BROWSER=chromium`
- `executablePath`
- `connectOverCdp` or `BETTERWRIGHT_CONNECT_OVER_CDP`
- `betterwright setup --chromium`

To select an already installed official CloakBrowser build, use
`CLOAKBROWSER_BINARY_PATH`. `betterwright doctor` reports the binary version,
tier, and path that will launch on the CloakBrowser line (and the full wrapper
directory under `doctor --json`).

## Troubleshooting headed launch

1. Run `betterwright doctor` and confirm it ends with `BetterWright is ready.`,
   and note which backend the Browser group's **In use** line reports
   (`chromium-fork` or `cloak`) — either is a correct install. `doctor --json`
   gives the same facts as the raw `ready` / `browser` fields.
2. Run `betterwright setup` if the managed binary is missing.
3. On Linux, confirm a display is present or use `xvfb-run`.
4. If BetterWright reports that the profile was upgraded by a newer browser,
   move or remove `$BETTERWRIGHT_HOME/browser/profile` and sign in again. The
   guard deliberately stops before an older browser build can crash while
   opening an incompatible profile. The usual cause is switching backends: the
   Chromium fork and CloakBrowser ship different Chromium versions, so they
   cannot share one profile. Vault credentials live outside the profile and
   survive the reset; browser-saved logins do not. To keep both backends,
   give each its own `BETTERWRIGHT_HOME`.

The managed browser reduces common automation false positives; it cannot
guarantee that a site will accept a session or never present a challenge.
