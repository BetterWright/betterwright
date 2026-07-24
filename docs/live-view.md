# Live View, chat, and human handoff

Live View lets a person watch BetterWright's browser, chat with the agent,
answer an `ask`, or take control for a handoff without moving the browser to a
cloud VM.

BetterWright has two first-class transports:

- **Managed relay**: an account-backed, encrypted link at
  `https://live.betterwright.com`. Both host and viewer connect outbound to
  Cloudflare. No port forwarding, public listener, SSH tunnel, or host IP in
  the viewer is required.
- **Direct**: a self-hosted listener on this machine. It is loopback-only by
  default. LAN and Tailscale exposure are explicit choices.

The Live View data plane does not pass through the BetterWright website. The
website is only for sign-in and API-key management.

## Where Live View appears

| Surface | How to start it |
| --- | --- |
| One CLI task | `betterwright exec "<task>" --live-view` |
| Interactive console | start with `--live-view`, or use `/live` at any time |
| Existing daemon session | `betterwright view --session <name>` |
| Built-in agent | the `live_view` tool watches without pausing; `handoff` pauses for the person |
| MCP | `browser_handoff` with `action: "start"` |
| JavaScript API | `startLiveView()`, `stopLiveView()`, and `liveViewStatus()` |

The viewer follows exactly one daemon session. Once a capability is created,
it cannot silently retarget to a different session. Chat, ask, handoff, status,
and teardown are checked against that same session.

Ordinary progress messages never start a listener or managed session. Only an
explicit Live View, ask, or handoff action activates it.

## Managed relay quick start

1. Sign in at <https://betterwright.com/account> and create a personal Live
   View API key.
2. Store and verify it without putting it in shell history:

   ```bash
   betterwright account set-key
   betterwright account status
   ```

   In a non-interactive environment, pipe it on standard input:

   ```bash
   printf '%s' "$BETTERWRIGHT_API_KEY" | betterwright account set-key --api-key-stdin
   ```

3. Save managed relay as the default and start a view:

   ```bash
   betterwright configure live-view --live-view-mode relay
   betterwright view
   ```

Use it for one invocation without changing the saved default:

```bash
betterwright exec "check the production dashboard" --live-view --transport relay
betterwright view --transport relay --session default
```

`betterwright setup` also offers this choice interactively. In a
non-interactive shell, setup does not change the Live View mode unless
`--live-view-mode` is provided.

### Upgrading from 1.1.x

Version 1.2.0 deliberately removes implicit network exposure. If an older
workflow relied on `betterwright view` being LAN-reachable, choose that risk
explicitly once with `betterwright configure live-view --live-view-mode lan`;
otherwise it now stays on loopback. Tailscale, user-owned HTTPS tunnels, and
experimental Quick Tunnels still work as Direct alternatives.

Managed Relay is new in 1.2.0 and requires a BetterWright account, a personal
API key, and an explicit saved, environment, CLI, or API transport choice. A
saved Relay choice applies to MCP too, so it does not need a redundant
`BETTERWRIGHT_LIVE_VIEW=1`; that variable remains the safety opt-in for
non-loopback Direct MCP listeners. New Direct passwords require at least eight
characters and are stored as salted scrypt verifiers. Existing legacy SHA-256
verifiers remain readable for a non-breaking upgrade.

### Account credentials

The API key is stored in `~/.betterwright/account.json` with owner-only
permissions. It is separate from ordinary `config.json`, is masked in status
output, and is never accepted as a normal command-line value. Revoke a key from
the account page or remove the local copy with:

```bash
betterwright account logout
```

`BETTERWRIGHT_API_KEY` overrides the stored key for an ephemeral process and is
not persisted automatically. `BETTERWRIGHT_RELAY_URL` can point to a compatible
self-hosted relay; it must be HTTPS, except for explicit loopback tests. An
invalid custom relay URL fails closed rather than falling back to the hosted
service.

## Managed quota and availability

Each account receives **7,200 viewer-connected seconds per ISO week**, which is
two hours. The week begins Monday at 00:00 UTC.

- Time starts only after an authorized viewer WebSocket is accepted.
- A waiting host, an idle session with no viewer, and session creation do not
  consume the allowance.
- Disconnecting stops the clock. Usage is reconciled against a bounded
  15-minute lease so a dropped connection cannot run indefinitely.
- Only one viewer lease can be active for an account at a time.
- There is no byte-transfer allowance to manage. The time allowance is the
  user-facing quota.

The account page and `betterwright account status` show the remaining time and
reset date. Admission also fails closed if quota, budget, or service control
state cannot be verified.

## Cloudflare-only data path

For managed mode, the host sends an outbound WSS connection directly to
`live.betterwright.com`. The viewer loads the shell and opens its own WSS
connection to the same Cloudflare Worker. A per-session Durable Object pairs
one host and one viewer. D1 stores account, API-key digest, session, and quota
metadata.

```text
BetterWright host  -- outbound WSS -->  Cloudflare Durable Object
                                              ^
Viewer browser     -- HTTPS + WSS ------------|
```

The relay path does not traverse Azure or the marketing website. It never
needs an inbound port on the host and does not give the viewer the host's IP
address.

### End-to-end encryption

The complete viewer link looks like:

```text
https://live.betterwright.com/s/<session-id>#k=<root-key>
```

The `#k=` fragment stays in the viewer browser and is not sent in HTTP requests.
BetterWright creates the session ID and 32-byte root locally, sends only a
session-bound proof to the relay, and appends the root to the returned viewer
URL after validating the response origin and path.

The root derives separate host-to-viewer and viewer-to-host AES-256-GCM keys
with HKDF-SHA-256. Each direction uses a fresh 16-byte epoch and monotonic
64-bit sequence numbers. The authenticated header binds protocol version,
direction, epoch, and sequence; tampering, replay, wrong-direction frames, and
mid-connection epoch changes are rejected.

On every viewer connection, BetterWright sends an encrypted random challenge.
The viewer must return the exact encrypted response before mouse, keyboard,
paste, chat, tab switching, or handoff messages are accepted. The Durable
Object forwards opaque ciphertext and control events only.

The relay can observe account/session metadata, connection timing, IP
metadata available to Cloudflare, and ciphertext sizes. It cannot decrypt the
screen, input, or chat. Anyone who has the complete viewer link can access the
session, so treat the whole link like a password.

## Direct and user-owned networking

Without saved configuration, Direct mode binds to `127.0.0.1`:

```bash
betterwright view                         # safe loopback default
betterwright view --expose local          # explicit loopback
betterwright view --expose lan            # explicit same-network listener
betterwright view --expose tailscale      # explicit tailnet-only listener
```

The presets mean:

- `local`: loopback only. Use an SSH tunnel or a tunnel you own when needed.
- `lan`: bind all interfaces and print the private LAN address.
- `tailscale`: bind only the detected Tailscale address. It fails clearly if
  Tailscale is unavailable.

For a user-owned tunnel, keep BetterWright on loopback:

```bash
ssh -L PORT:127.0.0.1:PORT <host>
cloudflared tunnel --url http://127.0.0.1:PORT
```

Cloudflare Quick Tunnels are an experimental convenience here, not the managed
production relay. Their URL and availability are controlled by Cloudflare's
Quick Tunnel service.

### Direct-view password

A direct capability URL is always required. Add a separate password gate with:

```bash
betterwright view --set-password
betterwright view --clear-password
```

Passwords must be at least eight characters. New stored verifiers use salted
scrypt in `~/.betterwright/config.json`; legacy SHA-256 verifiers remain
readable for upgrade compatibility. The plaintext is not stored or accepted as
a CLI flag. A direct password does not apply to managed links, which use the
fragment capability and endpoint encryption.

Direct viewing is plain HTTP unless the surrounding LAN, tailnet, SSH tunnel,
or user-owned tunnel supplies transport protection.

## Persistent configuration and precedence

Saved settings live under the `liveView` section of
`~/.betterwright/config.json`:

```json
{
  "liveView": {
    "transport": "relay",
    "expose": "local"
  }
}
```

The API key is never placed in that file. Configuration is resolved in this
order:

1. explicit per-call API options or CLI flags;
2. explicit constructor options and surface environment variables;
3. `account.json` and the `liveView` section of `config.json`;
4. safe built-ins: Direct transport on `127.0.0.1` with an ephemeral port.

Files are re-read on every start, so changing the mode, deleting a saved
setting, or revoking/removing a local key takes effect in an already-running
daemon. Choosing an explicit host or exposure preset selects Direct mode; a
saved Relay choice cannot silently turn that listener into a remote relay.

Useful environment variables:

| Variable | Purpose |
| --- | --- |
| `BETTERWRIGHT_API_KEY` | ephemeral account API key |
| `BETTERWRIGHT_RELAY_URL` | managed or compatible self-hosted relay origin |
| `BETTERWRIGHT_LIVE_VIEW_TRANSPORT` | `direct` or `relay` |
| `BETTERWRIGHT_LIVE_VIEW_EXPOSE` | Direct preset: `local`, `lan`, or `tailscale` |
| `BETTERWRIGHT_LIVE_VIEW_HOST` | explicit Direct bind host |
| `BETTERWRIGHT_LIVE_VIEW_PORT` | explicit Direct bind port |
| `BETTERWRIGHT_LIVE_VIEW_PUBLIC_HOST` | host printed for a wildcard Direct bind |
| `BETTERWRIGHT_LIVE_VIEW_PASSWORD` | ephemeral Direct-view password |
| `BETTERWRIGHT_LIVE_VIEW=1` | MCP deployer opt-in for non-loopback Direct access; an explicit saved/environment Relay selection authorizes Relay itself |

## Viewer behavior

The active page is streamed from CDP screencast frames. The largest visible
viewer controls the bucketed stream size; hidden viewer tabs stop receiving
frames and repaint from the latest frame on return. Tab thumbnails are sent as
deltas.

The viewer starts in watch mode. **Take control** enables browser input. Human
navigation still goes through BetterWright's network policy, download limits,
and credential-capture rules.

The session dock supports:

- **Chat**: guidance is delivered at the next safe agent-turn boundary.
- **Ask**: choice chips and free text resolve the agent's pending question.
- **Handoff**: input is enabled and Done/Cancel returns control to the agent.

Agent progress and the final answer are mirrored only after a Live View has
been explicitly started.

## JavaScript API

```js
import { BetterWright } from "betterwright";

const browser = new BetterWright({
  liveView: { transport: "relay" },
});

const view = await browser.startLiveView({
  session: "support-case-42",
  interactive: true,
});
console.log(view.url);

const status = await browser.liveViewStatus();
await browser.liveViewPostChat({
  session: "support-case-42",
  role: "agent",
  text: "Waiting for your confirmation",
});
await browser.stopLiveView();
await browser.close();
```

`startLiveView()` returns `transport`, the immutable `session`, viewer count,
and transport-specific fields. Managed results can include `sessionId`, quota,
and expiry metadata. Do not log the returned URL.

## Lifecycle and recovery

- An explicit stop closes the viewer and terminates the managed session.
- The host performs best-effort managed-session deletion on normal teardown.
- A worker crash or snippet timeout reconnects the bound Live View without
  silently creating a different session or changing its URL.
- Managed sessions expire no later than the service session TTL, currently 24
  hours. Direct capabilities end with their listener.
- A viewer reconnects after a bounded lease ends if quota and service admission
  still allow it.
- If the host disconnects, viewer input is closed rather than buffered for a
  later process.

## Security checklist

- Treat the complete viewer URL and personal API key as credentials.
- Revoke unused API keys from <https://betterwright.com/account>; at most five
  active keys are allowed per account.
- Use `--watch-only` or `interactive: false` when control is unnecessary.
- Do not put API keys or viewer links in logs, issue trackers, or model prompts.
- Use Relay, Tailscale, SSH, or an HTTPS tunnel for remote use. Never expose a
  Direct HTTP listener to the public internet.
- Re-observe the page after a handoff before automation continues.

## Limitations

- Native browser chrome, OS file pickers, and permission bubbles are not part
  of the page screencast.
- One page streams at full resolution at a time. The tab strip provides live
  thumbnails for other pages.
- One host and one viewer are paired per managed session, with one active
  viewer lease across the account.
- Manual credentials typed during a headless handoff are not automatically
  saved when no trusted save prompt can be shown.
