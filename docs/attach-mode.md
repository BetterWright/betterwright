# Headed and headless CloakBrowser

BetterWright always launches its managed CloakBrowser. Headed and headless runs
use the same persistent profile, fingerprint identity, network floor, download
controls, and browser worker. There is no stock-Chromium fallback and no
ordinary-Chrome CDP attach mode.

## Choosing the display mode

`headless` accepts `true`, `false`, or `"auto"` (the default):

- `"auto"` opens a visible Cloak window when a display is available and runs
  headless on servers, containers, and CI.
- `false` always requests a visible Cloak window.
- `true` always runs Cloak headless.

```js
new BetterWright();                    // visible on a desktop, headless on a server
new BetterWright({ headless: false }); // always headed Cloak
new BetterWright({ headless: true });  // always headless Cloak
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

Both modes use `$BETTERWRIGHT_HOME/browser/profile`. Cookies, local storage,
browser history, and logins therefore survive a switch between headed and
headless runs. Only one process can own the profile at a time; concurrent
workers receive isolated ephemeral profiles rather than corrupting it.

To sign in manually, start one headed run, complete the login in the visible
Cloak window, then keep using the normal persistent profile. For model-safe
credential filling, prefer the trusted [credential API](credentials.md).

## Cloak-only enforcement

These legacy settings are rejected instead of silently choosing a normal
browser:

- `browser: "chromium"` or `BETTERWRIGHT_BROWSER=chromium`
- `executablePath`
- `connectOverCdp` or `BETTERWRIGHT_CONNECT_OVER_CDP`
- `betterwright setup --chromium`

To select an already installed official CloakBrowser build, use
`CLOAKBROWSER_BINARY_PATH`. `betterwright doctor` reports the exact wrapper,
binary version, tier, and path that will launch.

## Troubleshooting headed launch

1. Run `betterwright doctor` and confirm `browser cloak`,
   `cloakbrowser_ok true`, and `ready true`.
2. Run `betterwright setup` if the managed binary is missing.
3. On Linux, confirm a display is present or use `xvfb-run`.
4. If BetterWright reports that the profile was upgraded by a newer browser,
   move or remove `$BETTERWRIGHT_HOME/browser/profile` and sign in again. The
   guard deliberately stops before an older Cloak build can crash while opening
   an incompatible profile.

Managed CloakBrowser reduces common automation false positives; it cannot
guarantee that a site will accept a session or never present a challenge.
