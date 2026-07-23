# Live view, chat & human handoff

Watch — coach — and when needed, drive — BetterWright's browser from an
ordinary web page. This is BetterWright's self-hosted answer to cloud "session
viewer / human-in-the-loop" products: the agent keeps its persistent,
policy-guarded session, and a human can watch it live, message it, take the
controls, or complete a step the agent cannot (MFA, a resistant CAPTCHA, a
consequential click) — then hand control straight back.

Three surfaces, one server:

| Surface | What it does |
| --- | --- |
| `betterwright exec "<task>" --live-view` | starts the viewer at step 0 and prints the URL, so you watch the whole run while the agent works |
| interactive console `--live-view` | starts one viewer before the first prompt and keeps its URL across follow-up tasks; `/new`, `/headed`, and `/headless` replace the browser and print a new viewer URL without restarting the CLI |
| the session dock (chat / ask / handoff) | always-on chat to guide the agent; `ask` questions appear as chips + a reply box; `handoff` elevates the dock with **Done** / **Cancel** and force-enables browser control |
| `betterwright view` | standalone: opens this machine's BetterWright browser with a live view held open until Ctrl-C — warm up logins by hand, or drive a headless VPS browser from your laptop |

Library equivalents: `browser.startLiveView()`, `browser.stopLiveView()`,
`browser.liveViewStatus()`, `browser.waitForHandoff()`, `browser.waitForAsk()`,
`browser.liveViewPostChat()`, `browser.liveViewDrainChat()`, and
`runAgentTask({liveView: true})`. MCP clients get a `browser_handoff` tool.

## How it works

The viewer server runs inside the browser worker (the only process holding
CDP). Frames are CDP `Page.startScreencast` JPEGs pushed over a WebSocket to a
single self-contained HTML page; your mouse and keyboard travel back as CDP
`Input.dispatch*` events on the same page. The stream is damage-driven — an
idle page costs ~nothing; a busy one is roughly screen-share bandwidth
(~25–80 KB per frame). Several things keep that budget honest:

- the screencast resolution adapts to the largest connected viewer window
  (bucketed, debounced), so a small laptop window never streams 1440px frames;
- a viewer whose browser tab is hidden stops receiving frames entirely and
  repaints from the latest frame the moment it returns;
- the latest frame is replayed to newly connected viewers, so joining never
  shows a black canvas waiting for page damage;
- tab-strip thumbnails travel as per-tab deltas, sent only when the thumbnail
  actually changed — never re-broadcast wholesale.

While the agent is driving, the viewer defaults to watching; **Take control**
enables your input with a visible warning that agent and human inputs can
race. The bottom **session dock** is always available:

- **Chat** — type freeform guidance ("use the work account", "skip that").
  Messages are queued and delivered to the agent at the next turn boundary
  (never mid-`browser` step), so the agent incorporates them safely. Over MCP
  the boundary is each tool call: your messages arrive appended to the next
  `browser` tool result (and in `browser_handoff` status), and the agent's
  per-step notes are mirrored into this chat.
- **Ask** — when the model calls `ask`, the dock elevates with the question and
  optional choice chips; your reply (chip or text) unblocks the agent.
- **Handoff** — when the model calls `handoff`, input is force-enabled and the
  dock shows the reason plus **Done** / **Cancel**. An optional note (the chat
  field) returns to the model verbatim.

Agent step notes (`browser`, `login`, …) and the final answer are mirrored into
the same chat log so watching the run feels alive.

Human browser input goes through every existing guard: the SOCKS policy proxy,
download limits, and credential capture treat takeover navigation exactly like
model-driven navigation. **Takeover does not bypass network policy.** Chat is
allowed even in watch-only mode (watch-only only blocks mouse/keyboard into the
page).

## Hosting: pick who can open it

You shouldn't need to know what a bind host is. One word says who can reach
the viewer, and one flag locks it:

```bash
betterwright view                          # devices on your local network (default)
betterwright view --expose tailscale       # your tailnet only — auto-detects the Tailscale IP
betterwright view --expose local           # only this machine — pair with your own tunnel
betterwright view --set-password           # prompt once; every live view now needs it
```

The same words work everywhere: `exec "<task>" --live-view --expose tailscale`,
`BETTERWRIGHT_LIVE_VIEW_EXPOSE=tailscale` (CLI and MCP), and
`startLiveView({expose: "tailscale"})` in the library. Settings you want
permanent go in `~/.betterwright/config.json` (see below) and apply to all
three surfaces. What each preset does:

- **`lan`** (default) — binds all interfaces and prints a URL with your
  machine's private LAN IP, so a phone or laptop on the same network opens it
  directly.
- **`tailscale`** — binds *only* your Tailscale address (detected from the
  100.64.0.0/10 interface; fails with a clear error if Tailscale isn't up).
  Nothing on the LAN or internet can reach it, traffic is end-to-end
  encrypted by the tailnet, and the printed URL works from any of your
  tailnet devices. This is the recommended way to watch a remote VPS.
- **`local`** — loopback only, for bringing your own tunnel. The CLI prints
  copy-paste commands for the two common ones:

  ```bash
  ssh -L PORT:127.0.0.1:PORT <host>                  # then open the printed URL locally
  cloudflared tunnel --url http://127.0.0.1:PORT     # gives you an https URL to share
  ```

An explicit `--host` still overrides everything for advanced setups.

### Persistent settings & password

`~/.betterwright/config.json` (or `$BETTERWRIGHT_HOME/config.json`) holds
live-view settings you set once and forget. The CLI, the library and the MCP
server all read it; flags and env vars override it per run:

```json
{
  "liveView": {
    "expose": "tailscale",
    "passwordHash": "sha256:…"
  }
}
```

**Password.** `betterwright view --set-password` prompts (hidden input,
confirmed twice) and stores a SHA-256 hash in that file with `0600`
permissions — the plaintext never touches a flag, your shell history, or
`ps`. From then on every live view — `view`, `exec --live-view`, and
MCP-started handoffs — shows a branded login screen in front of the viewer,
on top of the capability token that's already in the URL: the token gets
someone to the door, the password gets them in. Remove it with
`betterwright view --clear-password`. (Library callers can also pass
`startLiveView({password})` per start; MCP deployments that prefer env can
set `BETTERWRIGHT_LIVE_VIEW_PASSWORD`.)

## Security model

Unlike cloud debug URLs, the self-hosted viewer is authenticated by default:

- **Capability token.** Every server start generates a fresh
  `?t=<random-192-bit>` token required on the page, every HTTP request, and
  the WebSocket upgrade (constant-time compare, 404 otherwise). The URL *is*
  the credential — treat it like a password; don't paste it into chats or
  ticket systems.
- **LAN by default.** Live view binds `0.0.0.0` and prints a URL with the
  machine's private LAN IP (e.g. `http://192.168.0.2:PORT/?t=…`) so another
  device on the network can open it directly. Loopback only if you ask:

  ```bash
  betterwright exec "…" --live-view --host 127.0.0.1
  # or
  BETTERWRIGHT_LIVE_VIEW_HOST=127.0.0.1 betterwright exec "…" --live-view
  ```

  Pin the printed host with `--public-host` / `BETTERWRIGHT_LIVE_VIEW_PUBLIC_HOST`.
  Over MCP, a non-loopback host still requires `BETTERWRIGHT_LIVE_VIEW=1` —
  the deployer, not the model, opts in.
- **Optional password gate.** With a password set (`betterwright view
  --set-password`), the token only reaches a login page; the viewer (and the
  WebSocket) additionally require a session established by the password. At
  rest only a SHA-256 hash is stored, in `config.json` with `0600` permissions. Verification is constant-time against a
  SHA-256 digest; the session is a random 192-bit id in an `HttpOnly;
  SameSite=Strict` cookie valid 12 hours; failed logins lock the source
  address out after 10 attempts per 15 minutes; sessions die with the server.
  The page is plain http — rely on the network layer (LAN, tailnet, or an
  https tunnel) for transport privacy, which every preset provides.
- **Server-side watch-only.** `--watch-only` (or `interactive: false`) is
  enforced in the worker; the browser-side toggle is a convenience, never an
  authority. Handoffs force interactive on for their duration only.
- **Origin check + headers.** WebSocket upgrades with a mismatched `Origin`
  are dropped; the page is served with `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`.
- **Sealed from the model.** Nothing live-view-related exists in the code
  sandbox. The model can *request* a handoff; it cannot start servers, read
  the token, or synthesize input.

## Options

| Option / flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--expose` / `liveView.expose` | `BETTERWRIGHT_LIVE_VIEW_EXPOSE` | `lan` | hosting preset: `lan`, `local`, or `tailscale` |
| `view --set-password` / config `passwordHash` / `liveView.password` | `BETTERWRIGHT_LIVE_VIEW_PASSWORD` | off | require a password (min 4 chars) before the viewer loads |
| `--host` / `liveView.host` | `BETTERWRIGHT_LIVE_VIEW_HOST` | `0.0.0.0` | bind host (LAN-reachable by default; overrides `--expose`) |
| `--public-host` / `liveView.publicHost` | `BETTERWRIGHT_LIVE_VIEW_PUBLIC_HOST` | LAN IPv4 | host printed in the URL when bind is wildcard |
| `--port` / `liveView.port` | `BETTERWRIGHT_LIVE_VIEW_PORT` | `0` (ephemeral) | bind port |
| `--watch-only` / `interactive: false` | — | interactive | forbid viewer input outside handoffs |
| `quality` | — | `60` | screencast JPEG quality (10–90) |
| `maxWidth` | — | `1440` | max frame dimension in px (the stream also shrinks to fit the largest connected viewer window) |
| `session` | — | `default` | which session's current tab streams first |
| — | `BETTERWRIGHT_LIVE_VIEW=1` | off | (MCP) allow a non-loopback bind host |

## Timeouts & lifecycle

- `waitForHandoff({timeout})` defaults to 1800 s. The worker resolves
  `action: "timeout"` just before the client's own timeout would fire —
  letting the client timeout expire instead restarts the browser worker (open
  tabs are lost; the persistent profile survives). Size handoff timeouts for
  the worst-case human wait.
- A pending handoff sets the same page hold the `ask` tool uses, so the idle
  reaper never closes tabs mid-takeover; any viewer input also refreshes the
  session's activity clock.
- **The view survives worker restarts.** A snippet timeout or crash restarts
  the browser worker, which would otherwise take the in-worker view server
  with it. The host notices, respawns the worker immediately, and revives the
  view on the *same port and token* — so the URL you already shared keeps
  working. The viewer page rides it out with a "Reconnecting…" overlay and
  resumes automatically (it gives up after ~15 minutes of unreachability).
  Open tabs are still lost to the restart, and chat history/pending handoffs
  reset with it.
- Stopping the browser deliberately stops the viewer (viewers see a clean
  "ended" screen — only an explicit stop announces one). The agent stops a
  viewer it started once the task ends, but never one you started yourself.

## Limitations

- Native Chrome UI is not part of the screencast: OS file pickers and
  permission bubbles are invisible to the viewer (JS dialogs are already
  auto-handled by the worker). If a step needs a file picker, use the
  download/upload APIs instead.
- Credentials you type manually during a handoff are treated as *manual*
  logins by the capture engine: in headless sessions the save prompt cannot
  render, so they are not captured into the vault. The characters you type are
  visible as pixels in your own viewer stream (and nowhere else — frames never
  enter the model transcript).
- One page streams full-res at a time. When more than one tab is open, the
  tab strip shows a live low-res thumbnail of every tab (refreshed every few
  seconds, re-sent only when it changes); click a card to switch the main
  stream — the old stream keeps painting until the new tab's first frame
  lands, with the thumbnail as an instant placeholder. All connected viewers
  see (and, if interactive, share) the same controls.
