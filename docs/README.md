# BetterWright documentation

**The token-efficient browser for AI agents** — one persistent, policy-guarded
browser engineered so every observation costs the fewest tokens possible.

BetterWright is used in two ways — **integrated**, where *your* agent drives
the browser (skill, MCP, Pi, or the [JS API](javascript.md)), and
**standalone**, where BetterWright's own agent loop drives
(`betterwright exec "<task>"`) and returns one JSON answer.
[getting-started.md](getting-started.md#pick-your-shape-first) explains how to
pick; most pages apply to both.

## Start here

New here: `npm install -g betterwright && betterwright init`. That one command
installs the browser, wires up the agent hosts on your machine, and proves the
whole path works by loading a real page.

| Page | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | `init`, the two usage shapes, first run, sessions, proof screenshots |
| [Integration guide (SETUP.md)](../SETUP.md) | Wiring BetterWright into any host — written to be followed by an AI agent |
| [The built-in agent](agent.md) | `betterwright exec`, the interactive console, model adapters, `runAgentTask()` |
| [JavaScript API](javascript.md) | `BetterWright`, `NetworkPolicy`, the result envelope, vault API |
| [Browser API](browser-api.md) | Every sandboxed global inside a snippet: `page`, `snapshot`, `screenshot`, `human`, … |
| [CAPTCHA recipes](browser-recipes.md) | Manual fallbacks for CAPTCHA interactions |
| [Sessions & the daemon](sessions.md) | Persistence, concurrency, interrupting a run, reconnecting |

## Capabilities

| Page | What it covers |
| --- | --- |
| [Credential vault](credentials.md) | Encrypted storage, site matching, selector-free login, generated-password commits, and `betterwright vault` for reading your own saved passwords back |
| [Live view & handoff](live-view.md) | Watch/coach/take over in a browser tab; hosting presets, password gate, security model |
| [CAPTCHA helpers](captcha.md) | Local checkbox/Turnstile/slider solving; vision handoff for image grids |
| [Network policy](network-policy.md) | What the browser may reach; the unliftable metadata floor |
| [Skill packs](skills.md) | Per-site / per-password-manager guidance the host agent reads on demand |
| [Agent guidance](agent-prompt.md) | The operator prompt and its guardrail options |

## Under the hood

| Page | What it covers |
| --- | --- |
| [Architecture & security model](architecture.md) | The worker process, the RPC loop, what is and isn't a security boundary |
| [Cloaking V2](cloaking-v2.md) | The coherent-fingerprint approach; launch modes and egress matching |
| [Chromium fork](chromium-fork.md) | BetterWright's own Chromium build: farbling, platform masking, discovery |
| [Headed / headless](attach-mode.md) | Display modes over one persistent profile |
