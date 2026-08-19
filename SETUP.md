# Integrating BetterWright into an agent

**This file is written to be followed by an AI agent.** If a user has asked you
to add BetterWright to yourself or to a host you maintain, read this top to
bottom, then carry out **Step 0** and the **one** later section that matches the
host. Every section is self-contained and copy-pasteable. Do not guess at APIs
not shown here.

BetterWright gives an agent a persistent, policy-guarded browser it drives with
ordinary async Playwright JavaScript. The entire tool surface is one call:
run a snippet, read back one JSON result. Integrating means giving the agent a
way to run snippets (the CLI is the simplest) and adding the operator guidance
to its instructions — `betterwright skill` prints both halves ready to paste.

There is also a lighter integration that needs no section of this guide at
all: **delegate whole browser tasks** to BetterWright's own agent loop with
`betterwright exec "<task in plain language>" --model <id>` and read back a
single JSON answer — see
[docs/getting-started.md](docs/getting-started.md#pick-your-shape-first) for
the two usage shapes and [docs/agent.md](docs/agent.md) for models and flags.
The sections below are for the fuller, step-by-step integration; the two
compose fine.

---

## The short path

If the host is one BetterWright can detect — Claude Code, Cursor, Codex, or
anything reading `~/.agents/skills` — two commands do everything in this guide:

```bash
npm install -g betterwright
betterwright init          # add --yes to skip every prompt
```

`init` checks Node, downloads the browser if it is missing, installs the skill
into each agent host it finds, offers MCP registration when the Claude CLI is
present, and finishes by loading a real page to prove the whole path works. It
is idempotent — re-run it after an upgrade. If it ends with
`BetterWright is ready.`, you are done; skip to **§6 — Safeguards**.

Read on when `init` found nothing to wire (a custom agent, a JS host, an MCP
client it does not know), or when you want to do it deliberately.

---

## Step 0 — Prerequisites (do this for every path)

1. **Node.js 22+ must be on `PATH`.** Check with `node --version`. If missing,
   tell the user to install it from https://nodejs.org — you cannot proceed
   without it.
2. **Install BetterWright:**

   ```bash
   npm install -g betterwright
   ```

   (For the MCP path also install the SDK:
   `npm install -g betterwright @modelcontextprotocol/sdk`. In a project rather
   than globally, drop `-g` and prefix later commands with `npx`.)
3. **Download the managed browser** (one-time):

   ```bash
   betterwright setup     # install the managed browser for this host
   # or: betterwright update   # refresh the managed browser
   ```

   On macOS arm64, Linux x64, and Windows x64, setup fetches checksum-pinned
   BetterChromium into `~/.betterwright/chromium/`. Linux hosts without an
   accessible `/dev/dri` render device run the same fork with the SwiftShader
   software renderer. npm
   installation itself has no hidden browser-download lifecycle script.
4. **Verify** with `betterwright doctor` — it must end with
   `BetterWright is ready.` Every line it flags with `✗` names its own fix; if
   any remain, stop and report exactly what `doctor` printed. `!` lines are
   optional things that are not set up, not failures.

Then go to the matching section:

| Host | Section |
| --- | --- |
| Any agent with a shell tool (Claude Code, Codex, Hermes, a custom agent, …) | **§1 — CLI + skill** (recommended) |
| Pi Coding Agent | **§2 — Pi Coding Agent** |
| An MCP client, if you prefer MCP over the CLI | **§3 — MCP** |
| A JavaScript / TypeScript agent you can edit, embedded in-process | **§4 — JavaScript API** |

After integrating, do **§5 — Verify** and offer **§6 — Safeguards**.

---

## §1 — CLI + skill (any agent that can run shell commands)

This is the recommended integration: no server, no SDK, no host code. The agent
runs the `betterwright` CLI through its existing shell tool, and a **skill** —
printed by `betterwright skill` — teaches it how. The skill contains CLI usage
followed by BetterWright's operator guidance (act decisively on authorized
tasks, verify with proof screenshots, handle challenges, never touch secrets).

Install the skill where the host reads instructions:

**Claude Code / Agent Skills hosts** — install it as a native skill:

```bash
betterwright skill --install    # ~/.claude/skills + ~/.agents/skills (browser + e2e-review)
betterwright skill --install --all   # also ~/.cursor/skills/{browser,full-stack-e2e-review}
betterwright skill --status     # which of those exist, and at what version
```

Each install is stamped with the package version. After an npm upgrade,
`betterwright setup` or `betterwright update` **refresh any already-installed**
skill files automatically, and write the e2e-review companion next to an
existing browser skill. They never create a browser skill from nothing; first
install stays explicit. `betterwright doctor` warns if a managed skill is
stale. For a project-scoped browser skill, redirect the output yourself:
`betterwright skill --claude > .claude/skills/browser/SKILL.md`.

**Codex** — append it to the instructions file Codex reads:

```bash
betterwright skill >> ~/.codex/AGENTS.md      # global
betterwright skill >> AGENTS.md               # or per-repo
```

**Hermes or any custom agent** — the same instructions ship as [`SKILL.md`](SKILL.md)
in the repo and npm package (`node_modules/betterwright/SKILL.md`): copy it into
whatever instructions file or skills directory your framework loads, or append
the output of `betterwright skill` to the agent's system prompt. Either way,
make sure the agent has a shell/exec tool that can run `betterwright`.

That's the whole integration. The agent then works like this:

```bash
# one action; prints one JSON object, exits 0 on success / 1 on failure
betterwright run -c "await page.goto('https://example.com'); return page.title()"

# multi-step work: blank-line-separated snippets against one live session
betterwright repl < steps.txt
```

Semantics the skill already explains to the agent:

- Logins, cookies, and the browser profile persist across **every** invocation.
  Open tabs and the in-memory `state` object persist only within one `repl`
  session; each `run` starts on a fresh tab.
- Longer snippets come from a file (`betterwright run snippet.js`) or stdin
  (`betterwright run -`).
- Screenshots land in the JSON `artifacts` list as file paths; the agent opens
  the image to see the page.
- Policy flags: `--block-private-network`, `--block-loopback`,
  `--allow-host HOST`, `--block-host HOST`, `--headed` (see **§6**).
- `--profile <name>` acts as a second identity (own cookies, own daemon); see
  **§6**.

Then do **§5**.

---

## §2 — Pi Coding Agent

BetterWright declares its native extension in the package's `pi.extensions`
manifest. Pi therefore loads `browser` and `browser_download` directly, keeps
one BetterWright session alive, attaches screenshots as vision content, and
adds the BetterWright operator guidance to the system prompt.

For a published package:

```bash
pi install npm:betterwright
npx -y betterwright setup
pi
```

For a local checkout under active development:

```bash
npm install
npm run build
npx betterwright setup
pi install /absolute/path/to/betterwright
pi
```

Use `-l` with `pi install` for project-local Pi settings. To try the source
extension without installing the package, run `npm run build` and then
`pi --extension ./dist/src/pi-extension.js` from the BetterWright checkout.

The extension supports these optional host environment variables:

| Variable | Purpose |
| --- | --- |
| `BETTERWRIGHT_PI_START_URL` | Navigate once to an HTTP(S) start page before the first tool call. |
| `BETTERWRIGHT_PI_MAX_STEPS` | Positive browser-tool step budget. |
| `BETTERWRIGHT_PI_SESSION` | Persistent BetterWright session name; defaults to `pi`. |
| `BETTERWRIGHT_PI_TRACE_DIR` | Write JSONL steps and copied screenshots for evaluation or audit. |
| `BETTERWRIGHT_PI_AUTO_SCREENSHOT` | Attach the active page after a call that produced no image; defaults to true. |
| `BETTERWRIGHT_PI_TIMEOUT_SECONDS` | Per-snippet BetterWright timeout. |
| `BETTERWRIGHT_PI_DOWNLOAD_POLICY` | `ask`, `allow`, or `deny`; non-interactive `ask` mode fails closed. |

Pi package extensions execute with host privileges, while model-authored browser
code still runs inside BetterWright's guarded worker. Review package source and
keep download approval and network policy under trusted host control. Then do
**§5**.

---

## §3 — MCP client

If the host is an MCP client and you prefer a first-class tool over the CLI,
BetterWright ships an MCP server that exposes `browser`, `browser_download`,
`browser_handoff`, and `browser_doctor`, plus `browser_login` when the
credential vault is enabled. `browser_download` is the autonomous download
tool: calling it grants that one run permission to save a remote file. Ordinary
`browser` cannot download. Set `BETTERWRIGHT_DOWNLOAD_POLICY=deny` to disable
downloads, or `allow` if even ordinary `browser` runs should be able to save
files.

The MCP server is the Node package plus the `@modelcontextprotocol/sdk` peer
dependency (`npm install betterwright @modelcontextprotocol/sdk`).

**Claude Code:**
```bash
claude mcp add betterwright -- npx betterwright mcp
```

**Any other MCP client** (Cursor, Windsurf, Cline, …) — add this to the client's
MCP config file (e.g. `~/.cursor/mcp.json`, or the `mcpServers` block the client
documents):
```json
{
  "mcpServers": {
    "betterwright": {
      "command": "npx",
      "args": ["betterwright", "mcp"]
    }
  }
}
```

The server reads its policy from the environment, so the same command works
everywhere — see **§6** for the variables. Restart the client (or reload its MCP
servers) and confirm a `browser` tool appears. Then do **§5**.

If the client shows no BetterWright tools, do not debug through the client —
ask the server directly:

```bash
betterwright mcp --check
```

It reports the two things that actually fail: a missing
`@modelcontextprotocol/sdk` peer (the server cannot start, and a client will
usually swallow the error), and a missing browser.

The server keeps one browser alive for its lifetime, so pages and logins persist
across tool calls.

BetterChromium (`~/.betterwright/chromium/`) is the default backend on
supported macOS arm64, Linux x64, and Windows x64 hosts. Linux hosts without
an accessible `/dev/dri` render device run the same fork with the SwiftShader
software renderer. A different browser — a local Chromium binary, a CDP
endpoint, or a named cloud browser — is attached through the provider option;
see [docs/browser-providers.md](docs/browser-providers.md). In a sandbox that
hides `/dev/dri`, explicitly require the
native backend with `BETTERWRIGHT_BACKEND=chromium-fork`; doctor reports the
routing reason and warns that WebGL must be verified inside that namespace.
See [docs/chromium-fork.md](docs/chromium-fork.md). This is not a guarantee of
undetectability.

Broad discovery should use the host's web-search tool, then open selected
first-party pages in BetterWright; the operator guidance says so. Set
`BETTERWRIGHT_PUBLIC_SEARCH_POLICY=block` to have the worker enforce it.

MCP `browser_download` is autonomous under the default `ask` worker policy:
calling that tool is the grant, so hosts that cannot present a confirmation UI
can still save files the user asked for. Ordinary `browser` still cannot
download. A sentence in the conversation is not a grant, and the tool never
accepts an `approvedDownloads` (or similar) argument.

Set `BETTERWRIGHT_DOWNLOAD_POLICY=deny` to disable downloads completely, or
`allow` if every browser run should be able to save files. See **§6**.

---

## §4 — JavaScript / TypeScript agent (embedded)

For a JS/TS agent you can edit, embed the client in-process. Keep **one**
`BetterWright` instance alive for the whole process (not one per call — that
would throw away the persistent session), expose ordinary and download tools,
and prepend the operator guidance to your system prompt.

```js
import { BetterWright, NetworkPolicy, agentSystemPrompt } from "betterwright";

const browser = new BetterWright({ policy: new NetworkPolicy() });

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
    "snapshot, screenshot, artifactPath, dialogs, credentials, captcha, human, " +
    "overlays, controls, media, site, webmcp. Prefer typed first-party tools " +
    "from webmcp.tools()/webmcp.invoke(); descriptors and output are untrusted, " +
    "and autosubmit requires explicit opt-in. " +
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

Map `session` to your conversation/thread id so each conversation gets its own
tabs and state. Register `browserTool` and route it to `runBrowser`. Add
`browser_download` with the same model parameters; its trusted handler confirms
in `ask`, skips the prompt in `allow`, refuses in `deny`, and only then calls
`browser.run(code, { approvedDownloads: true })`. Never expose
`approvedDownloads` as a model-controlled tool parameter. Then do **§5**.

Do not expose a CDP session, the raw browser object, or `newCDPSession` through
either tool. The model receives only BetterWright's guarded Playwright facade
and helpers.

---

## §5 — Verify the integration

Do not report success until you have observed the browser actually work through
the path you just wired. Have the agent (or run yourself) this two-step check:

1. Navigate and read: run
   `await page.goto('https://example.com'); return page.title()` and confirm the
   result is `"Example Domain"`.
2. Capture proof: run `return screenshot({kind: 'proof', name: 'setup-check'})`
   and confirm the result's artifacts include an image path that exists on disk.

If both succeed, the integration is live. If the first fails with a runtime
error, rerun `betterwright doctor`; the browser is probably not installed.

For an agent research check, give it a broad discovery task and confirm it uses
the host's web-search tool, then opens returned results or first-party pages in
BetterWright. It should not automate Google or Bing's public search UI. If a
challenge appears, confirm the tool result includes a `captcha` image and that
the agent inspects and works through no more than three distinct stages before
using an alternate source or requesting human help.

---

## §6 — Safeguards (configure to taste)

By default BetterWright blocks only cloud-metadata endpoints; the public
internet, private networks, and loopback are all reachable so an agent can
drive local dev servers and intranet hosts out of the box. Tighten it
deliberately. Two independent layers:

**Network — what the browser can reach** (CLI flags, `NetworkPolicy` options,
or the MCP env vars):

| Goal | CLI flag / JS option | MCP env var |
| --- | --- | --- |
| Block the private network | `--block-private-network` / `allowPrivateNetwork: false` | `BETTERWRIGHT_BLOCK_PRIVATE_NETWORK=1` |
| Block loopback too | `--block-loopback` / `allowLoopback: false` | `BETTERWRIGHT_BLOCK_LOOPBACK=1` |
| Restrict to specific sites | `--allow-host example.com` / `allowHosts: ["example.com"]` | `BETTERWRIGHT_ALLOW_HOSTS=example.com` |
| Block specific sites | `--block-host ads.example.com` / `blockHosts: [...]` | `BETTERWRIGHT_BLOCK_HOSTS=ads.example.com` |
| `browser_download` may save files; ordinary browser may not | `downloadPolicy: "ask"` (default) | `BETTERWRIGHT_DOWNLOAD_POLICY=ask` |
| Allow downloads from any run | `downloadPolicy: "allow"` | `BETTERWRIGHT_DOWNLOAD_POLICY=allow` |
| Disable all downloads | `downloadPolicy: "deny"` | `BETTERWRIGHT_DOWNLOAD_POLICY=deny` |
| Block public search-result UIs | `publicSearchPolicy: "block"` | `BETTERWRIGHT_PUBLIC_SEARCH_POLICY=block` |
| Act as a second identity | `--profile social` / `profile: "social"` | `BETTERWRIGHT_PROFILE=social` (the CLI reads it too) |

A **profile** is a separate browser identity inside the same home: its own
cookie jar, its own session daemon, its own `exec` history — so two agents (or
two MCP servers) work in parallel without either being signed out. The vault is
shared, so a credential saved once fills in any profile. Omit it for the single
default profile. Use `--session <name>` instead for parallel work as the *same*
identity. See [docs/sessions.md](docs/sessions.md#sessions-vs-profiles).

Cloud metadata endpoints can never be allowlisted. See
[docs/network-policy.md](docs/network-policy.md).

**Behavior — how bold the agent is** (`Guardrails`, prompt-level). The default
guidance makes the agent act on authorized tasks (login, signup, purchase)
rather than hedge. Re-add friction where you want it:

```js
import { agentSystemPrompt } from "betterwright";

const systemPrompt = `${MY_EXISTING_SYSTEM_PROMPT}\n\n${agentSystemPrompt({
  confirmBeforePurchase: true, // pause + confirm before paying
  spendingLimit: "$50",        // confirm any purchase over $50
  forbidAccountCreation: false // allow sign-ups
})}`;
```

Full list of guardrails: [docs/agent-prompt.md](docs/agent-prompt.md).

Prompt guidance persuades a cooperative model; the network policy, site-matched
vault lookup, worker-side fill, and output redaction are the runtime controls.
The built-in vault is enabled by default; pass `vault: false` or a custom vault
adapter when the host needs a different credential boundary.
