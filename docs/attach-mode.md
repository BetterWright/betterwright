# Attaching to an existing Chrome (and headed mode)

By default BetterWright launches its **own managed Cloak browser** with an
isolated persistent profile. There are two ways to change that: run it
**headed** so you can watch it, and **attach** it to a Chrome you already have
open.

## Headed vs. headless

`headless` accepts `True`, `False`, or `"auto"` (the default):

- **`"auto"`** — run a visible window when a display is available, and headless
  on servers, containers, and CI. This is what you usually want: you see the
  browser on your desktop, and nothing breaks on a headless host.
- **`True`** / **`False`** — force it.

```python
from betterwright import BetterWright

BetterWright()                    # auto: visible on a desktop, headless on a server
BetterWright(headless=False)      # always show a window
BetterWright(headless=True)       # never show a window
```

```js
new BetterWright();                  // auto
new BetterWright({ headless: false }); // always visible
```

Detection uses `DISPLAY`/`WAYLAND_DISPLAY` on Linux, the absence of an SSH-only
session on macOS, and the session type on Windows. Override the detection with
`BETTERWRIGHT_DISPLAY=1` or `BETTERWRIGHT_DISPLAY=0`. Even headed, this is still
BetterWright's own browser — a separate window from your everyday Chrome.

## Attach mode — driving your real Chrome

Attach mode connects to a Chrome/Chromium you started yourself, so the agent
works in the browser **you can see**, with **your tabs and logins**. It uses
Chrome's DevTools protocol, which has one hard requirement: the browser must
have been launched with `--remote-debugging-port`. You cannot attach to a normal
Chrome that is already running without that flag — Chrome only opens the debug
port when it starts.

CDP remains a trusted host transport. The endpoint is supplied when the client
is constructed; it is not included in the model's browser tool, and
model-authored snippets cannot access `newCDPSession`, the raw browser object,
or private Playwright handles.

### 1. Launch Chrome with the debug port

Quit Chrome first, then start it with the flag. A separate profile directory is
recommended so you are not handing the agent your primary profile.

**macOS**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.betterwright-chrome"
```

**Linux**
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.betterwright-chrome"
```

**Windows (PowerShell)**
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\.betterwright-chrome"
```

Log into whatever sites the task needs in that window. Confirm the port is up:
`curl http://127.0.0.1:9222/json/version` should return JSON.

### 2. Point BetterWright at it

```python
from betterwright import BetterWright

bw = BetterWright(connect_over_cdp="http://127.0.0.1:9222")
bw.run("return pages.map(p => p.url())")   # sees the tabs already open
```

```js
const bw = new BetterWright({ connectOverCdp: "http://127.0.0.1:9222" });
```

MCP server: set `BETTERWRIGHT_CONNECT_OVER_CDP=http://127.0.0.1:9222` in its env.

The already-open tabs are adopted into the default session, so `pages`, `page`,
`usePage`, and `snapshot` work against them immediately. On shutdown BetterWright
disconnects without closing your browser or its tabs.

### Managed dedicated Chrome — attach, or launch if none is open

You usually don't want to launch Chrome by hand. Pass `connect_over_cdp="auto"`
and BetterWright reuses a debug Chrome if one is already listening, or otherwise
launches a real Google Chrome with a persistent dedicated profile and attaches to
that:

```python
from betterwright import BetterWright

bw = BetterWright(connect_over_cdp="auto")   # reuse or launch a real Chrome
```

```js
const bw = new BetterWright({ connectOverCdp: "auto" });
```

For explicit control (e.g. long-lived agents such as Pi that all attach to the
same stable state), call the helper yourself:

```js
import { BetterWright, ensureChromeCdp } from "betterwright";

const { endpoint, profileDir } = await ensureChromeCdp();
const bw = new BetterWright({ connectOverCdp: endpoint });
```

```python
from betterwright import BetterWright, ensure_chrome_cdp

info = ensure_chrome_cdp()          # {"endpoint", "profile_dir", "started"}
bw = BetterWright(connect_over_cdp=info["endpoint"])
```

The managed browser uses Google Chrome when installed, binds its debugging port
to `127.0.0.1`, and stores state under
`~/.betterwright/chrome-cdp-profile`. Chrome 136 and newer require this separate
`--user-data-dir`; BetterWright never points remote debugging at your everyday
Chrome profile. Set `BETTERWRIGHT_HOME` to move the dedicated profile.

### Password managers (1Password) in attach mode

Because the dedicated profile is persistent, it is the place to install a
password-manager extension once and let the agent fill logins through it — so the
secret stays in the extension and never reaches BetterWright:

1. Start the browser once (`connect_over_cdp="auto"`), install the 1Password
   extension in the window that opens, sign in, and **unlock** it. The agent
   cannot type your master password or pass biometrics, so it must already be
   unlocked (the desktop-app integration keeps it unlocked across restarts).
2. Keep 1Password's "Show autofill menu on field focus" setting on.
3. The agent focuses a login field and clicks the matching entry in 1Password's
   inline menu. BetterWright's clicks emit real `isTrusted` events, which the
   extension requires, so the fill works.

This only works in attach mode — the managed Cloak browser does not carry your
extensions. When the extension is missing or locked, fall back to the trusted
[vault fill](credentials.md) (`bw.fill_credential` / `generate_and_fill_credential`).
See [`examples/python/onepassword_attach.py`](../examples/python/onepassword_attach.py).

Note the trade-off: extension autofill puts the secret into the page DOM, where a
later model snippet could read it (redaction still scrubs run output). That is
acceptable for your own credentials under the "guard against accidental leakage"
model, but it is a weaker guarantee than the vault fill, which never lets a model
snippet near the value.

For broad discovery, use a web-search tool supplied by the host, then open the
returned result or first-party page in BetterWright. Do not automate Google or
Bing's public search UI. The example's `publicSearchPolicy: "allow"` is an
explicit trusted-host escape hatch; without it, those result pages are blocked.
`searchMinIntervalMs` then spaces top-level public-search navigations, but
pacing is not a substitute for the host search route and cannot guarantee that
a provider will accept the traffic.

## The security trade-off — read this

Attach mode gives up BetterWright's strongest guarantees, because they are
applied when BetterWright launches the browser and it can't set them on a browser
it didn't start:

- **Browser signals:** attach mode uses the Chrome instance you launched, not
  BetterWright's managed Cloak backend. It therefore gives up Cloak's reduction
  of common stock automation signals.

- **Gone in attach mode:** the launch-time network floor — the Chromium
  `--host-resolver-rules` that NXDOMAIN cloud-metadata endpoints, the forced
  transport proxy that catches every connection (including DNS-rebinding), and
  the WebRTC pinning.
- **Still active:** the per-request [`NetworkPolicy`](network-policy.md) via
  request interception. It still blocks metadata endpoints and private networks
  by default — but as a single layer, not the defense-in-depth of launch mode.
- **Downloads:** BetterWright keeps its browser-wide byte limit when the attached
  Chrome exposes that CDP control. Otherwise it disables downloads for the
  attached pages instead of allowing unbounded writes to disk.

Every run in attach mode returns a warning saying the floor is inactive.

There's a second, larger consideration: pointing an autonomous agent at your
real, logged-in browser is a big blast radius. It can act as authenticated-you on
every site that profile is signed into, and a prompt-injection from any page
becomes far more dangerous. Prefer a **dedicated `--user-data-dir`** you log into
deliberately, not your primary Chrome profile.

## When to use which

- **Just want to watch it work?** Use `headless=False` (or `"auto"`) — that keeps
  the full security floor and still shows a window.
- **Need your existing logins in a browser you can see?** Prefer logging into
  BetterWright's own managed persistent profile once (it survives across runs).
  Reach for attach mode only when you specifically need the *same* browser you
  already use.
