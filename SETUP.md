# Integrating BetterWright into an agent

**This file is written to be followed by an AI agent.** If a user has asked you
to add BetterWright to yourself or to a host you maintain, read this top to
bottom, then carry out **Step 0** and the **one** later section that matches the
host. Every section is self-contained and copy-pasteable. Do not guess at APIs
not shown here.

BetterWright gives an agent a persistent, policy-guarded browser it drives with
ordinary async Playwright JavaScript. The entire tool surface is one call:
`run(code)`. Integrating means registering a browser tool plus a separate
approval-gated download tool, and adding the operator guidance to the system
prompt.

---

## Step 0 — Prerequisites (do this for every path)

1. **Node.js 22+ must be on `PATH`.** Check with `node --version`. If missing,
   tell the user to install it from https://nodejs.org — you cannot proceed
   without it.
2. **Install BetterWright** for the host's language:
   - Python host: `pip install betterwright`
   - JavaScript host: `npm install betterwright`
   - MCP path (any host): `pip install "betterwright[mcp]"`
3. **Download the managed browser** (one-time, ~200 MB):
   - Python/MCP install: `betterwright setup`
   - JavaScript install: `npx betterwright setup`

   The official CloakBrowser wrapper downloads its signed binary directly from
   CloakHQ and verifies it before extraction; BetterWright does not redistribute
   that separately licensed binary. npm installation itself has no hidden
   browser-download lifecycle script.
4. **Verify** it is ready and must print `BetterWright is ready.`:
   - Python/MCP install: `betterwright doctor`
   - JavaScript install: `npx betterwright doctor`
   If it does not, stop and report exactly what `doctor` printed.

Then go to the matching section:

| Host | Section |
| --- | --- |
| An MCP client (Claude Code, Cursor, Windsurf, Cline, …) | **§1 — MCP** |
| A Python agent you can edit | **§2 — Python** |
| A JavaScript / TypeScript agent you can edit | **§3 — JavaScript** |
| A host that can only run shell commands | **§4 — CLI** |

After integrating, do **§5 — Verify** and offer **§6 — Safeguards**.

---

## §1 — MCP client (Claude Code, Cursor, and similar)

BetterWright ships an MCP server that exposes `browser`, `browser_download`, and
`browser_doctor`. `browser_download` uses MCP elicitation to ask the user before
any download-capable code runs. You register the server once; the model then has
a first-class browser tool.

**Claude Code:**
```bash
claude mcp add betterwright -- python -m betterwright.integrations.mcp_server
```

**Any other MCP client** (Cursor, Windsurf, Cline, …) — add this to the client's
MCP config file (e.g. `~/.cursor/mcp.json`, or the `mcpServers` block the client
documents):
```json
{
  "mcpServers": {
    "betterwright": {
      "command": "python",
      "args": ["-m", "betterwright.integrations.mcp_server"],
      "env": { "BETTERWRIGHT_ALLOW_LOOPBACK": "0" }
    }
  }
}
```

The server reads its policy from the environment, so the same command works
everywhere — see **§6** for the variables. Restart the client (or reload its MCP
servers) and confirm a `browser` tool appears. Then do **§5**.

The server keeps one browser alive for its lifetime, so pages and logins persist
across tool calls.

Managed launches use CloakBrowser by default to reduce common automation false
positives. This is not a guarantee of undetectability. Set
`BETTERWRIGHT_BROWSER=chromium` only for the explicit stock-browser fallback;
run `betterwright setup --chromium` (Python) or
`npx betterwright setup --chromium` (JavaScript) once before selecting it.

Public search-result UIs are blocked by default. Broad discovery should use the
host's web-search tool, then open selected first-party pages in BetterWright.
`BETTERWRIGHT_PUBLIC_SEARCH_POLICY=allow` is an explicit trusted-host opt-in.

The default `BETTERWRIGHT_DOWNLOAD_POLICY=ask` fails closed when an MCP client
cannot present elicitation. Set it to `allow` to remove approval prompts or
`deny` to disable downloads completely.

---

## §2 — Python agent

Keep **one** `BetterWright` instance alive for the whole process (not one per
call — that would throw away the persistent session). Register an ordinary
browser tool and an approval-gated download tool, and prepend the operator
guidance to your system prompt.

```python
from betterwright import BetterWright, NetworkPolicy, agent_system_prompt

# 1. One browser for the process. Adjust the policy per §6.
browser = BetterWright(policy=NetworkPolicy(allow_loopback=False))

# 2. The tool handler. Map `session` to your conversation/thread id so each
#    conversation gets its own tabs and state.
def run_browser(code: str, session: str = "default", note: str | None = None) -> dict:
    r = browser.run(code, session=session, note=note)
    return {
        "ok": r.ok,
        "result": r.value,
        "error": r.error,
        # Screenshots as data URLs you can hand straight to a vision model.
        # NEVER attach r.files() (downloads, spilled JSON) as images.
        "screenshots": [s.data_url() for s in r.screenshots()],
        "files": [f.path for f in r.files()],
        "challenges": r.challenges,
        "warnings": r.warnings,
    }

# 3. The tool schema to advertise to the model.
BROWSER_TOOL = {
    "name": "browser",
    "description": (
        "Run async Playwright JavaScript in a persistent, policy-guarded browser. "
        "Globals: page, pages, context, state, openPage, usePage, closePage, "
        "snapshot, screenshot, artifactPath, dialogs, credentials, captcha, human. "
        "When a challenge is returned, inspect its image, use the native captcha or "
        "human helpers for up to three distinct stages, then resume the original "
        "action as soon as it clears. A single trailing expression returns "
        "automatically; a statement block must return."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "Playwright JavaScript to run."},
            "note": {"type": "string", "description": "Short present-tense status line."},
        },
        "required": ["code"],
    },
}

# 4. Add the operator guidance to your system prompt so the model acts decisively.
SYSTEM_PROMPT = MY_EXISTING_SYSTEM_PROMPT + "\n\n" + agent_system_prompt()
```

Register `BROWSER_TOOL` with your agent's tool registry and route its calls to
`run_browser`. Register a second `browser_download` tool with the same model
parameters. Its trusted host handler must apply the configured policy: confirm
through the host UI in `ask` mode, skip the prompt in `allow` mode, and refuse in
`deny` mode. Only after approval should it call
`browser.run(..., approved_downloads=True)`. Never expose `approved_downloads`
as a model-controlled tool parameter. Then do **§5**.

Do not expose `connect_over_cdp`, a CDP endpoint, the raw browser object, or
`newCDPSession` through either tool. CDP is an optional trusted host transport;
the model receives only BetterWright's guarded Playwright facade and helpers.

---

## §3 — JavaScript / TypeScript agent

Identical shape. Keep one client alive and expose ordinary and download tools.

```js
import { BetterWright, NetworkPolicy, agentSystemPrompt } from "betterwright";

const browser = new BetterWright({ policy: new NetworkPolicy({ allowLoopback: false }) });

async function runBrowser({ code, session = "default", note }) {
  const r = await browser.run(code, { session, note });
  const isImage = (a) => ["proof", "question", "debug", "captcha"].includes(a.kind);
  return {
    ok: r.ok,
    result: r.result,
    error: r.error,
    // Image artifacts carry a MEDIA: path; read+encode them if your host needs
    // a data URL. Never attach non-image files (downloads, spilled JSON).
    screenshots: (r.artifacts || []).filter(isImage).map((a) => a.media),
    files: (r.artifacts || []).filter((a) => !isImage(a)).map((a) => a.path),
    challenges: r.challenges,
    warnings: r.warnings,
  };
}

const browserTool = {
  name: "browser",
  description:
    "Run async Playwright JavaScript in a persistent, policy-guarded browser. " +
    "Globals: page, pages, context, state, openPage, usePage, closePage, " +
    "snapshot, screenshot, artifactPath, dialogs, credentials, captcha, human. " +
    "When a challenge is returned, inspect its image, use the native captcha or " +
    "human helpers for up to three distinct stages, then resume the original action.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "Playwright JavaScript to run." },
      note: { type: "string", description: "Short present-tense status line." },
    },
    required: ["code"],
  },
};

const systemPrompt = `${MY_EXISTING_SYSTEM_PROMPT}\n\n${agentSystemPrompt()}`;
```

Register `browserTool` and route it to `runBrowser`. Add `browser_download` with
the same model parameters; its trusted handler confirms in `ask`, skips the
prompt in `allow`, refuses in `deny`, and only then calls
`browser.run(code, { approvedDownloads: true })`. Never expose
`approvedDownloads` as a model-controlled tool parameter. Then do **§5**.

Do not expose `connectOverCdp`, a CDP endpoint, the raw browser object, or
`newCDPSession` through either tool. CDP is an optional trusted host transport;
the model receives only BetterWright's guarded Playwright facade and helpers.

---

## §4 — Shell-only host

If you can only run shell commands, use the CLI directly — no integration code.
It prints a single JSON object and exits `0` on success, `1` on failure.

```bash
betterwright run -c "await page.goto('https://example.com'); return page.title()"
```

Pass a multi-line snippet from a file with `betterwright run path/to/snippet.js`,
or from stdin with `betterwright run -`. Policy flags: `--allow-loopback`,
`--allow-host HOST`, `--block-host HOST`, `--headed`. This is the quickest path
but the browser does not persist between separate `run` invocations, so prefer
§1–§3 for real multi-step work.

---

## §5 — Verify the integration

Do not report success until you have observed the browser actually work through
the path you just wired. Have the agent (or run yourself) this two-step check:

1. Navigate and read: run
   `await page.goto('https://example.com'); return page.title()` and confirm the
   result is `"Example Domain"`.
2. Capture proof: run `return screenshot({kind: 'proof', name: 'setup-check'})`
   and confirm you get back a `MEDIA:` path that exists on disk.

If both succeed, the integration is live. If the first fails with a runtime
error, rerun `betterwright doctor` (Python) or `npx betterwright doctor`
(JavaScript); the browser is probably not installed.

For an agent research check, give it a broad discovery task and confirm it uses
the host's web-search tool, then opens returned results or first-party pages in
BetterWright. It should not automate Google or Bing's public search UI. If a
challenge appears, confirm the tool result includes a `captcha` image and that
the agent inspects and works through no more than three distinct stages before
using an alternate source or requesting human help.

---

## §6 — Safeguards (configure to taste)

BetterWright is safe by default (cloud metadata and private networks are
blocked). Tighten or loosen it deliberately. Two independent layers:

**Network — what the browser can reach** (`NetworkPolicy`, or the MCP env vars):

| Goal | Python / JS | MCP env var |
| --- | --- | --- |
| Allow a local dev server | `allow_loopback=True` / `allowLoopback: true` | `BETTERWRIGHT_ALLOW_LOOPBACK=1` |
| Allow the private network | `allow_private_network=True` | `BETTERWRIGHT_ALLOW_PRIVATE_NETWORK=1` |
| Restrict to specific sites | `allow_hosts=("example.com",)` | `BETTERWRIGHT_ALLOW_HOSTS=example.com` |
| Block specific sites | `block_hosts=("ads.example.com",)` | `BETTERWRIGHT_BLOCK_HOSTS=ads.example.com` |
| Ask before each download | `download_policy="ask"` / `downloadPolicy: "ask"` | `BETTERWRIGHT_DOWNLOAD_POLICY=ask` |
| Remove download approval | `download_policy="allow"` / `downloadPolicy: "allow"` | `BETTERWRIGHT_DOWNLOAD_POLICY=allow` |
| Disable all downloads | `download_policy="deny"` / `downloadPolicy: "deny"` | `BETTERWRIGHT_DOWNLOAD_POLICY=deny` |
| Use stock Chromium fallback | `browser="chromium"` / `browser: "chromium"` | `BETTERWRIGHT_BROWSER=chromium` |
| Permit public search-result UIs | `public_search_policy="allow"` / `publicSearchPolicy: "allow"` | `BETTERWRIGHT_PUBLIC_SEARCH_POLICY=allow` |

Cloud metadata endpoints can never be allowlisted. See
[docs/network-policy.md](docs/network-policy.md).

**Behavior — how bold the agent is** (`Guardrails`, prompt-level). The default
guidance makes the agent act on authorized tasks (login, signup, purchase)
rather than hedge. Re-add friction where you want it:

```python
from betterwright import agent_system_prompt, Guardrails

SYSTEM_PROMPT += "\n\n" + agent_system_prompt(Guardrails(
    confirm_before_purchase=True,   # pause + confirm before paying
    spending_limit="$50",           # confirm any purchase over $50
    forbid_account_creation=False,  # allow sign-ups
))
```

Full list of guardrails and the JS form: [docs/agent-prompt.md](docs/agent-prompt.md).

Prompt guidance persuades a cooperative model; the network policy and sandbox
restrictions are what actually enforce limits. Keep secret-bearing vault work in
trusted host code.
