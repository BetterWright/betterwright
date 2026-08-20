// Help text for every `betterwright` subcommand.
//
// This exists because `--help` used to fall through to the command itself:
// `betterwright setup --help` downloaded a 200 MB browser, `run --help` blocked
// forever reading stdin, `close --help` closed your session, and `skill --help`
// printed nine kilobytes of agent instructions. Asking a tool what it does
// should never be the thing that does it, so the router in bin/betterwright.ts
// consults this table before dispatching.

export const COMMAND_SUMMARIES = [
  ["init", "guided first-time setup — browser, agent wiring, verification"],
  ["setup", "download the managed browser for this host"],
  ["update", "download or refresh the managed browser for this host"],
  ["doctor", "check that everything needed is installed and reachable"],
  ["run", "run one Playwright snippet in the persistent session"],
  ["repl", "run blank-line-separated snippets from stdin"],
  ["exec", "hand a whole task to BetterWright's own browser agent"],
  ["vault", "read and manage saved passwords"],
  ["sessions", "list live browser sessions"],
  ["close", "close a session (--all stops every profile's daemon)"],
  ["models", "list models the configured backends expose"],
  ["view", "open a live web view of the browser"],
  ["auth", "sign in to a model backend (codex | grok)"],
  ["skill", "print or install the agent instructions"],
  ["skills", "read the on-demand site knowledge packs"],
  ["mcp", "serve the MCP stdio server"],
];

export const MAIN_USAGE = `betterwright — a persistent, policy-guarded browser for AI agents

Usage: betterwright <command> [options]
       betterwright                 interactive agent console (no command)

New here? Run \`betterwright init\`.

Commands:
${COMMAND_SUMMARIES.map(([name, summary]) => `  ${name.padEnd(10)} ${summary}`).join("\n")}

\`betterwright <command> --help\` explains one command.
Docs: https://github.com/BetterWright/betterwright#readme`;

/**
 * Per-command help. Any command absent from this table falls back to
 * MAIN_USAGE, which is still better than running the command by accident.
 */
export const COMMAND_HELP = {
  init: `Usage: betterwright init [options]

Guided first-time setup. Checks Node, installs the managed browser if it is
missing, wires up whichever agent hosts it finds on this machine, and verifies
the whole path with a real page load.

Options:
  --yes            accept every default; never prompt (for scripts and CI)
  --skip-browser   do not download or verify the browser
  --skip-agents    do not touch any agent configuration

Safe to re-run: it reports what is already done and changes only what is not.`,

  setup: `Usage: betterwright setup [options]

Download native BetterChromium, the bundled browser on supported macOS arm64,
Linux x64, and Windows x64 hosts. On platforms with no published artifact,
setup has nothing to install — use --browser / the provider option to bring
your own Chromium binary or a cloud browser (docs/browser-providers.md).

Options:
  --force        re-download the managed browser even when already present

Also refreshes installed agent skill files. Run \`betterwright doctor\` afterwards.`,

  update: `Usage: betterwright update [options]

Download or refresh the managed browser: native BetterChromium when a pinned
artifact is published for this host.

Options:
  --force   re-download even if the pinned version is already installed`,

  doctor: `Usage: betterwright doctor [options]

Check that everything BetterWright needs is installed and reachable: the
runtime, the managed browser, the agent integrations you have wired up, a
usable model for \`exec\`, and the credential vault.

Options:
  --json   the raw report, for scripts
  --quiet  print only problems

Exit code is 0 when ready, 1 otherwise.`,

  run: `Usage: betterwright run -c "<javascript>"
       betterwright run <file>
       betterwright run -            read the snippet from stdin

Run one snippet of async Playwright JavaScript in the persistent browser and
print one JSON object. A trailing expression, or an explicit \`return\`, is the
result. Globals include page, snapshot, screenshot, credentials, human, controls
(including one-call UI batches), site, webagents, and webmcp.

Options:
  --session <name>       which persistent session to use (default "default")
  --profile <name>       browser profile to act as — a separate identity with
                         its own cookies and its own daemon, at
                         browser/profiles/<name> (default: the shared profile;
                         BETTERWRIGHT_PROFILE sets one for the whole shell).
                         Use --session for parallel work as the same identity,
                         --profile for a different account.
  --headed               show the browser window
  --close                close the session after this call
  --approve-downloads    allow downloads for this one run
  --no-daemon            do not use the background session daemon
  --stealth              isolated-world driver (needs patchright-core)
  --browser <name|url>   use a cloud browser provider (browser-use, kernel,
                         browserbase, steel, anchor, hyperbrowser, browserless,
                         brightdata, oxylabs) or any wss:// CDP endpoint
                         instead of the managed BetterChromium fork
  --browser-key <key>    provider API key (or its env var, e.g.
                         BROWSERBASE_API_KEY); BETTERWRIGHT_CDP_URL is the
                         env shorthand for --browser <url>

Network:
  --block-private-network   --block-loopback
  --allow-host <host>       --block-host <host>

Example:
  betterwright run -c "await page.goto('https://example.com'); return page.title()"`,

  repl: `Usage: betterwright repl [options]

Read blank-line-separated snippets from stdin and run each one against the same
live session, printing a JSON result per snippet. Ctrl-D quits.

Takes the same session, profile, network, and browser flags as \`betterwright run\`.

Example:
  printf '%s\\n\\n%s\\n' "await page.goto('https://example.com')" "return page.title()" \\
    | betterwright repl`,

  vault: null, // supplied by vault-cli.js so the text lives beside the command

  sessions: `Usage: betterwright sessions

List the browser sessions held by the background daemons, with how long each
has been idle and whether a task is running in it. Every profile in this home
is listed, one daemon per profile. Never starts a daemon.`,

  close: `Usage: betterwright close [name] [options]

Close a persistent browser session. Open tabs go away; the on-disk profile, and
therefore your logins, do not.

Options:
  --session <name>   the session to close (default "default")
  --profile <name>   close a session of that profile (default: the shared one)
  --all              close every session of every profile and stop each daemon`,

  models: `Usage: betterwright models [source] [options]

List the models reachable right now. With no source, probes the native backends
plus any local Ollama or vLLM server and OpenRouter when keyed.

Sources: openrouter | ollama | vllm

Options:
  --base-url <url>       an OpenAI-compatible endpoint to query
  --api-key-env <name>   environment variable holding its key
  --json                 machine-readable output`,

  view: `Usage: betterwright view [options]

Open a live, token-gated web view of the browser and hold it until Ctrl-C.
Attaches to the running session when there is one, so you see the same tabs the
agent is driving.

Options:
  --expose <preset>    lan (default) | local | tailscale
  --host <host>        bind address; overrides --expose
  --port <port>        bind port (default: ephemeral)
  --profile <name>     watch that profile's browser (default: the shared one)
  --watch-only         no takeover controls
  --set-password       store a password every viewer must enter
  --clear-password     remove that password

The printed URL embeds a capability token. Treat it like a password.`,

  auth: `Usage: betterwright auth --login <codex|grok>
       betterwright auth --status

Sign in to a model backend for BetterWright's own agent, using the provider's
OAuth flow rather than an API key. Tokens are stored under BETTERWRIGHT_HOME.

  --login codex   use a ChatGPT/Codex subscription
  --login grok    use an xAI account
  --status        show which backends are signed in

Anthropic models use ANTHROPIC_API_KEY instead; local models need no sign-in.`,

  skill: `Usage: betterwright skill [options]

Print the agent instructions that teach any shell-capable agent to drive
BetterWright. With no options, writes the browser skill to stdout for pasting.

Options:
  --install    write browser + e2e-review skills to ~/.claude/skills and ~/.agents/skills
  --all        with --install, also write ~/.cursor/skills
  --claude     print Claude-form browser SKILL.md (frontmatter included) to stdout
  --status     show where the skills are installed and whether they are current

The e2e-review skill is installed beside the browser skill. Hosts keep only
its description in context until the user asks for an end-to-end review.

Codex reads an instructions file instead (browser skill only):
  betterwright skill >> ~/.codex/AGENTS.md

\`betterwright init\` does this for you, for whichever hosts it finds.`,

  skills: `Usage: betterwright skills [list | show <name>]

Site and password-manager knowledge packs the agent reads on demand. Run
results hint at packs matching the open page; this is how you read one yourself.`,

  mcp: `Usage: betterwright mcp [--check]

Serve BetterWright over the Model Context Protocol on stdio. Exposes browser,
browser_login, browser_download, browser_handoff, and browser_doctor.

  --check   verify the server can start, then exit — use this to debug a
            client that shows no BetterWright tools

Register it with a client, for example:
  claude mcp add betterwright -- npx betterwright mcp

Needs the @modelcontextprotocol/sdk peer dependency. Policy comes from the
environment; see SETUP.md §6.`,

  exec: null, // EXEC_USAGE lives in the bin entrypoint beside its flag parsing
};

/** Help text for a command, or the main usage when there is nothing specific. */
export function helpFor(command) {
  return COMMAND_HELP[command] || MAIN_USAGE;
}

/**
 * True when the tokens after the subcommand are asking for help.
 * Deliberately only the flag forms: a bare `help` would swallow legitimate
 * arguments such as `betterwright exec "help me find a flight"`.
 */
export function wantsHelp(tokens) {
  return tokens.some((token) => token === "--help" || token === "-h");
}
