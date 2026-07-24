# BetterWright documentation

**The token-efficient browser for AI agents** — one persistent, policy-guarded
browser engineered so every observation costs the fewest tokens possible.

BetterWright is used in two ways; most pages apply to both, and
[getting-started.md](getting-started.md) explains how to pick:

- **Integrated** — *your* agent drives the browser, through the skill
  (`betterwright skill`), the MCP server (`betterwright mcp`), the Pi package,
  or the [JS API](javascript.md).
- **Standalone** — BetterWright's own agent loop drives
  (`betterwright exec "<task>"` / the interactive console), and you — or a
  coding agent using it as a browser sub-agent — read back one JSON answer.

## Start here

| Page | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Install, the two usage shapes, first run, sessions, proof screenshots |
| [Integration guide (SETUP.md)](../SETUP.md) | Wiring BetterWright into any host — written to be followed by an AI agent |
| [The built-in agent](agent.md) | `betterwright exec`, the interactive console, model adapters, `runAgentTask()` |
| [JavaScript API](javascript.md) | `BetterWright`, `NetworkPolicy`, the result envelope, vault API |
| [Browser API](browser-api.md) | Every sandboxed global inside a snippet: `page`, `snapshot`, `screenshot`, `human`, … |
| [Recipes](browser-recipes.md) | Short copy-paste patterns for common flows |
| [Sessions & the daemon](sessions.md) | Persistence, concurrency, interrupting a run, reconnecting |

## Capabilities

| Page | What it covers |
| --- | --- |
| [Credential vault](credentials.md) | Encrypted storage, site matching, selector-free login, generated-password commits |
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
