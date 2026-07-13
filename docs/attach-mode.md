# Attaching to an existing Chrome (and headed mode)

By default BetterWright launches its **own** Chromium with an isolated profile.
There are two ways to change that: run it **headed** so you can watch it, and
**attach** it to a Chrome you already have open.

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

### Managed dedicated Chrome

On a desktop integration, BetterWright can start or reuse that dedicated Chrome
profile for you. This is useful for long-lived agents such as Pi because every
agent process attaches to the same stable browser state instead of creating a
fresh automation profile:

```js
import { BetterWright, ensureChromeCdp } from "betterwright";

const { endpoint, profileDir } = await ensureChromeCdp();
const bw = new BetterWright({
  connectOverCdp: endpoint,
  searchMinIntervalMs: 12_000,
});
```

The managed browser uses Google Chrome when installed, binds its debugging port
to `127.0.0.1`, and stores state under
`~/.betterwright/chrome-cdp-profile`. Chrome 136 and newer require this separate
`--user-data-dir`; BetterWright never points remote debugging at your everyday
Chrome profile. Set `BETTERWRIGHT_HOME` to move the dedicated profile.

`searchMinIntervalMs` is optional and defaults to `0`. A nonzero value spaces
top-level Google, Bing, and DuckDuckGo search navigations while leaving ordinary
site browsing untouched. Pacing and a stable profile reduce automated-query
signals, but no browser setting can guarantee that a search provider will never
show a CAPTCHA, especially when its decision includes the public IP's history.

## The security trade-off — read this

Attach mode gives up BetterWright's strongest guarantees, because they are
applied when BetterWright launches the browser and it can't set them on a browser
it didn't start:

- **Gone in attach mode:** the launch-time network floor — the Chromium
  `--host-resolver-rules` that NXDOMAIN cloud-metadata endpoints, the forced
  transport proxy that catches every connection (including DNS-rebinding), and
  the WebRTC pinning.
- **Still active:** the per-request [`NetworkPolicy`](network-policy.md) via
  request interception. It still blocks metadata endpoints and private networks
  by default — but as a single layer, not the defense-in-depth of launch mode.

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
  BetterWright's own persistent profile once (it survives across runs). Reach for
  attach mode only when you specifically need the *same* browser you already use.
