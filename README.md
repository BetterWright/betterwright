# BetterWright

BetterWright gives AI agents a persistent browser controlled with Playwright
JavaScript. An agent can navigate, interact with pages, and read results across
calls without starting a new browser each time.

It adds compact page observations, configurable network controls, trusted
credential filling, and human handoff for steps that need a person.

Use the **CLI**, **MCP server**, or **JavaScript/TypeScript SDK** to give your
existing agent browser access. The optional **built-in agent** accepts a
natural-language task and runs the browser steps with a model you configure.
The browser runtime itself does not require a model or an API key.

[Documentation](https://betterwright.com/docs) · [Integration guide](SETUP.md) ·
[npm](https://www.npmjs.com/package/betterwright) · [Changelog](CHANGELOG.md)

## Quickstart

Install [Bun 1.4 or newer](https://bun.com) and make sure it is on your `PATH`.
The CLI and setup commands use Bun; the ESM library can also be imported from
Node.js 22 or newer.

The managed browser, **BetterChromium**, is available for **macOS arm64,
Linux x64, and Windows x64**. On other platforms, supply your own browser via
the [provider configuration](docs/browser-providers.md).

```bash
bun install -g betterwright
betterwright setup
betterwright run -c "await page.goto('https://example.com'); return page.title()"
betterwright close
```

`setup` downloads the pinned BetterChromium build and verifies its checksum.
The browser download is explicit, not a package-install side effect. The
`run` command prints a JSON result with `ok: true` and
`result: "Example Domain"` on success; failures include `ok: false` and an
`error`, and exit nonzero.

The browser starts headless by default; add `--headed` to `run` to show it.
Between CLI calls, a background daemon keeps the session's tabs and page state
alive. `close` ends the session, but leaves the saved profile and its cookies
on disk. See [sessions and profiles](docs/sessions.md) for idle timeouts and
persistence limits.

If setup or a run fails, use `betterwright doctor` for diagnostics. To upgrade,
run `bun install -g betterwright@latest`, then `betterwright update` to refresh
the managed browser. More setup options are in
[Getting started](docs/getting-started.md).

## Connect an existing agent

### CLI and skills

An agent with a shell tool can call `betterwright run` directly. The packaged
skill supplies the CLI syntax and guidance for observing pages, choosing
actions, and verifying results.

```bash
betterwright skill
betterwright skill --install
betterwright skill --status
```

The first command prints the instructions. `--install` writes the browser and
e2e-review skills to `~/.claude/skills` and `~/.agents/skills`; add `--all` to
include `~/.cursor/skills`. For other hosts, use the packaged [SKILL.md](SKILL.md)
or follow the [integration guide](SETUP.md), which also covers Codex and Pi.

For guided setup instead, run `betterwright init`. It checks Bun, installs the
browser, and tests a real page load. With your confirmation, it also installs
skills into detected hosts and updates Codex's global instructions when
present. It offers Claude Code MCP registration when the CLI and MCP peer
dependency are available. Use `--skip-agents` to leave agent configuration
alone; `--yes` accepts the default setup steps, including detected-host skill
writes, in a non-interactive run.

### MCP

The stdio MCP server exposes browser execution, UI batches, downloads,
recording, diagnostics, and human handoff. Install its optional peer dependency
before registering it with a client. For Claude Code:

```bash
bun add -g betterwright @modelcontextprotocol/sdk
claude mcp add betterwright -- bunx betterwright mcp
betterwright mcp --check
```

Reload the client's MCP servers and confirm the `browser` tool appears. See
the [MCP integration guide](SETUP.md#3--mcp-client) for other clients, environment
configuration, and download policy.

## Use the SDK

Install BetterWright in your project with `bun add betterwright`. If you have
not installed the managed browser yet, run `bunx betterwright setup`.
Save this as `example.mjs` and run it with `bun example.mjs`:

```js
import { BrowserError, withBrowser } from "betterwright/sdk";

const title = await withBrowser(async (browser) => {
  const result = await browser.run(
    "await page.goto('https://example.com'); return page.title()",
  );
  if (!result.ok) throw new BrowserError(result.error);
  return result.result;
});

console.log(title);
```

`withBrowser` closes the client even if the callback throws. Browser execution
failures arrive as result envelopes, so check `ok`; client startup failures can
throw. The code string runs inside the worker with restricted Playwright
wrappers and helpers such as `snapshot()` and `screenshot()`; it is not an
unrestricted host-side Playwright script.

See the [SDK guide](docs/sdk.md), [client API](docs/javascript.md), and
[snippet API](docs/browser-api.md) for options, result envelopes, and available
globals. The same ESM example runs with `node example.mjs` on Node.js 22+;
that library support is separate from the Bun-based CLI.

## Delegate a task to the built-in agent

`betterwright exec` accepts a natural-language task rather than a code snippet.
It uses the same browser runtime, but BetterWright runs the model/tool loop.
For example, sign in to Codex with a ChatGPT subscription that has access to
the selected model:

```bash
betterwright auth --login codex
betterwright exec "Open https://example.com and report its page title." --model gpt-5.6-sol --close
```

Progress goes to stderr and the final result is JSON on stdout. `--close` ends
the browser session after the task. Model access and usage limits depend on
your provider; API-backed runs may incur charges. Tasks can require human
input or end without completion, so inspect the returned `ok` and `reason`.

Use `betterwright models` to inspect available model sources. The
[built-in agent guide](docs/agent.md#choosing-a-model) covers API keys, local
models, compatible endpoints, budgets, and the interactive console.

## Working with the browser

- **Keep state between steps.** Named sessions have their own tabs and
  in-memory state, but share cookies within a profile. Use separate profiles
  for different accounts, not separate sessions.
  [Sessions and profiles](docs/sessions.md#sessions-vs-profiles)
- **Control what the agent observes.** Read page data with Playwright or use
  compact snapshots with element references, interactive-only views, scoped
  subtrees, and diffs. Screenshots provide visual evidence when text is not
  enough. [Browser API](docs/browser-api.md)
- **Bring a person into the session.** Live view lets you watch the browser;
  handoff lets a person complete a step such as MFA before the agent resumes.
  [Live view and handoff](docs/live-view.md)
- **Choose where the browser runs.** Use managed BetterChromium, supply a local
  Chromium executable, attach over CDP, or embed with the Electron adapter.
  The network protections differ by transport.
  [Browser providers](docs/browser-providers.md) · [Electron](docs/electron-host.md)

## Safety and defaults

BetterWright automates sites under your direction. Treat page content as
untrusted, authorize consequential actions in your host, and use only accounts
and sites you are permitted to automate. Browser configuration does not
guarantee undetectability or CAPTCHA acceptance.

**Network access is permissive by default.** Public, private, and loopback
destinations are allowed. Set both `--block-private-network` and
`--block-loopback` on CLI runs to block private and local access. The
non-disableable metadata floor applies to locally launched browsers and
guarded Electron attachments. Ordinary remote CDP/provider browsers are
outside the local transport guard: supported Playwright routing checks still
apply, but transport-level metadata and DNS-rebinding protections do not.
See [network policy](docs/network-policy.md) before deploying on a sensitive
network.

**The snippet sandbox is defense in depth.** Restricted APIs and `node:vm` are
not a security boundary against hostile JavaScript. See the
[security model](docs/architecture.md#security-model).

**Credential filling is a trusted operation, not a secrecy guarantee.** The
vault encrypts stored records, URL-gates filling, and redacts handled values
from results. Filled secrets still exist in the matched page's DOM; an
unrestricted shell or compromised host can bypass local vault protections.
Scope credential access in the host and review the
[vault documentation](docs/credentials.md) and [security policy](SECURITY.md).

[Ghostery ad and tracker blocking](docs/ad-blocking.md) is on by default. Use
`--no-ad-block` for CLI runs or `adBlock: false` in the SDK to disable it.

## Documentation and contributing

The [documentation index](docs/README.md) links the full guides and references.
For bugs and feature requests, open a
[GitHub issue](https://github.com/BetterWright/betterwright/issues). Read
[CONTRIBUTING.md](CONTRIBUTING.md) for development checks and the
[release process](CONTRIBUTING.md#releasing), and report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md#reporting-a-vulnerability).

## License and attribution

BetterWright is [MIT licensed](LICENSE), copyright The BetterWright Project
and contributors. See [NOTICE.md](NOTICE.md) for project and third-party
notices, and [TRADEMARKS.md](TRADEMARKS.md) for name and visual identity guidance.
The attribution request in the notice adds no condition to the MIT License.
