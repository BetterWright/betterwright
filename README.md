# BetterWright

**A persistent, policy-guarded Playwright browser for AI agents.**

![BetterWright — an agent operating a browser](https://raw.githubusercontent.com/CuriosityOS/betterwright/main/docs/assets/hero.png)

Playwright gives you a browser automation API. BetterWright is the layer you
need on top of it when the thing driving the browser is a language model rather
than a test script: a long-lived session the agent can return to, a network
policy enforced on every request, an encrypted credential store for trusted
host code, screenshot artifacts the agent cites as proof of work, and native
CAPTCHA helpers.

It runs the same Node worker whether you drive it from **Python** or
**JavaScript**, so an agent written in either language gets identical behavior.

```python
from betterwright import BetterWright

with BetterWright() as bw:
    result = bw.run("await page.goto('https://example.com'); return page.title()")
    print(result.value)          # "Example Domain"
    proof = bw.run("return screenshot({kind: 'proof', name: 'done'})")
    print(proof.artifacts[0].media_reference)   # MEDIA:/…/done-….png
```

---

## Why not just use Playwright directly?

Playwright is built for tests: a script that knows exactly what it will click,
running to completion and tearing the browser down. An agent is the opposite —
it decides what to do next from what it sees, one step at a time, and the same
browser has to still be there on the next step. That difference is where the
work is, and it is what BetterWright handles for you:

| Concern | Playwright | BetterWright |
| --- | --- | --- |
| **Session lifetime** | You open and close a browser per script. | One persistent Chromium with a real profile; the agent runs snippets against it across many turns. |
| **Untrusted control** | The script is trusted; it gets the full API. | Model code runs in a sandbox with the file, process, and network-routing APIs removed. |
| **Network scope** | Any URL the code names. | Every request is checked against a policy; cloud metadata and private networks are blocked by default, even against DNS rebinding. |
| **Secrets** | Passwords live in your script or env. | An encrypted, origin-scoped vault is available to trusted host code; secret-bearing fill operations are not exposed to model snippets. |
| **Evidence** | You assert; nobody looks. | `screenshot({kind: 'proof'})` produces a tagged artifact the agent returns as proof a task finished. |
| **CAPTCHAs** | Out of scope. | Native one-shot checkbox, slider, and text-challenge helpers for authorized flows. |

If you are writing a test, use Playwright. If you are handing a browser to an
agent and need it to stay safe and accountable, that is what this is for.

---

## Install

BetterWright needs **Node.js 18+** on `PATH`. Chromium is downloaded on setup.

### Python

```bash
pip install betterwright
betterwright setup        # installs the pinned Playwright runtime + Chromium
betterwright doctor       # confirms everything resolves
```

### JavaScript

```bash
npm install betterwright  # postinstall downloads Chromium
npx betterwright doctor
```

Both packages ship the identical worker and pin the same Playwright version, so
`betterwright setup` is a one-time download of the matching browser build.

---

## The two APIs

The `run()` call takes a string of asynchronous Playwright JavaScript. A single
trailing expression is returned automatically; a multi-statement block must
`return`. Inside that string the agent has a small set of globals — `page`,
`openPage`, `snapshot`, `screenshot`, `human`, `credentials`, and a few others —
documented in [docs/browser-api.md](docs/browser-api.md).

**Python**

```python
from betterwright import BetterWright, NetworkPolicy

with BetterWright(policy=NetworkPolicy(allow_loopback=True)) as bw:
    dev = bw.session("dev")
    dev.run("await page.goto('http://localhost:5173')")
    title = dev.run("return page.title()")
    print(title.value)
```

**JavaScript**

```js
import { BetterWright, NetworkPolicy } from "betterwright";

const bw = new BetterWright({ policy: new NetworkPolicy({ allowLoopback: true }) });
await bw.run("await page.goto('http://localhost:5173')");
const title = await bw.run("return page.title()");
console.log(title.result);
await bw.close();
```

The Python client returns a typed [`RunResult`](docs/python.md); the JavaScript
client returns the worker's result envelope directly (`result`, `artifacts`,
`console`, `events`, `pages`, `challenges`, `warnings`, `durationMs`).

Long-lived desktop agents can attach to a dedicated real-Chrome profile with
`ensureChromeCdp()`. Keeping browser state stable and optionally pacing public
search navigations avoids needless fresh-session signals; visible bot challenges
are surfaced in the result envelope so an agent can take a direct-site route
instead of repeatedly retrying search. See [attach mode](docs/attach-mode.md).

---

## Adding it to an agent

Point your agent (or coding agent) at **[SETUP.md](SETUP.md)** — it's written to
be followed by an AI agent and walks it through integrating BetterWright into the
host, whether that's an MCP client (Claude Code, Cursor, …), a Python or
JavaScript agent, or a shell-only tool. The whole surface is one tool call, so
the integration is a thin adapter.

For MCP clients specifically, BetterWright ships a server:

```bash
pip install "betterwright[mcp]" && betterwright setup
claude mcp add betterwright -- python -m betterwright.integrations.mcp_server
```

## What each piece does

- **[Network policy](docs/network-policy.md)** — every navigation, subresource,
  WebSocket, and raw TCP connection is checked. The default blocks cloud
  metadata endpoints and private/loopback addresses; open exactly what you need
  with `allow_hosts`, `allow_loopback`, or a `custom` hook.
- **[Credential vault](docs/credentials.md)** — AES-256-GCM, origin-scoped,
  stored outside Chromium's profile for trusted host-side credential workflows.
  Model snippets cannot request a secret-bearing fill.
- **[Proof artifacts](docs/browser-api.md#screenshots-and-artifacts)** —
  screenshots tagged `proof`, `question`, or `debug`, returned as
  `MEDIA:<path>` references a host UI can render.
- **[Native CAPTCHA helpers](docs/captcha.md)** — checkbox clicks, smooth
  slider drags, and tightly cropped text-challenge images for the agent's
  existing vision, with no external solving service or API key.
- **[Human-shaped actions](docs/browser-api.md#human-shaped-interactions)** —
  curved pointer movement, paced typing, and eased wheel events without another
  runtime dependency.
- **[Optional CloakBrowser binary](docs/getting-started.md#optional-cloakbrowser-binary)** —
  use an explicitly installed binary without bundling its separate license or
  changing BetterWright's Node requirement.
- **[Agent guidance](docs/agent-prompt.md)** — drop-in operator instructions
  (`agent_system_prompt()`) that make the model act decisively on authorized
  tasks — logging in, signing up, buying — instead of hedging, with
  `Guardrails` to re-impose confirmation, spending caps, or hard prohibitions.

## How it works

A Python or JavaScript client owns one long-lived Node worker. The worker holds
a persistent Chromium context and exposes a sandboxed set of globals to the
model's code; it calls back to the client to authorize each request and to
handle credentials. The security model — what the sandbox removes, why the
metadata floor cannot be lifted, and where it does *not* claim to be a boundary
— is written up in [docs/architecture.md](docs/architecture.md).

## Scope and responsible use

BetterWright automates a browser under your direction, including signing in and
interacting with simple CAPTCHAs on sites you are authorized to use. It is not
built for bulk account creation, credential stuffing, or scraping behind
anti-bot walls at scale, and its native helpers exist to unblock a task you
legitimately own, not to repeatedly defeat a site that is telling automation to
stop. See
[docs/architecture.md#security-model](docs/architecture.md#security-model) for
the boundaries the code does and does not enforce.

## License

MIT — see [LICENSE](LICENSE).
