// A Model Context Protocol server exposing BetterWright as a browser tool.
//
// This lets any MCP client — Claude Code, Cursor, Windsurf, and others — drive
// a persistent, policy-guarded browser. It exposes `browser` for ordinary
// runs, `browser_download` for approval-gated downloads, and `browser_doctor`
// for runtime diagnostics.
//
// Run it directly (stdio transport):
//
//     npm install betterwright @modelcontextprotocol/sdk
//     npx betterwright setup          # fork (mac/linux) + Cloak fallback
//     npx betterwright update         # refresh / switch to Chromium fork
//     npx betterwright mcp
//
// Then register it with your MCP client. For Claude Code:
//
//     claude mcp add betterwright -- npx betterwright mcp
//
// Configuration is read from the environment so the same command works
// everywhere:
//
//     BETTERWRIGHT_BLOCK_LOOPBACK=1        block 127.0.0.1 / localhost (open by default)
//     BETTERWRIGHT_BLOCK_PRIVATE_NETWORK=1 block RFC1918 / *.internal (open by default)
//     BETTERWRIGHT_ALLOW_HOSTS=a.com,b.com always-allow list (comma-separated)
//     BETTERWRIGHT_BLOCK_HOSTS=ads.com     always-block list (comma-separated)
//     BETTERWRIGHT_DOWNLOAD_POLICY=ask     ask (default), allow, or deny downloads
//     BETTERWRIGHT_HEADLESS=0              run the managed browser headed
//     BETTERWRIGHT_PROFILE=<name>          act as a named browser profile: a
//                                          separate identity (own cookies, own
//                                          session daemon) at
//                                          browser/profiles/<name>. Unset uses
//                                          the single default profile. Two MCP
//                                          servers on one home with different
//                                          profiles stay signed in at once.
//     BETTERWRIGHT_TIMEZONE=<IANA tz>      pin the browser timezone to the egress
//                                          geography (unset: host timezone)
//     BETTERWRIGHT_LOCALE=<locale>         browser locale for the same identity
//     BETTERWRIGHT_LIVE_VIEW_HOST=...      live-view bind host (default 127.0.0.1)
//     BETTERWRIGHT_LIVE_VIEW_PORT=...      live-view port (default ephemeral)
//     BETTERWRIGHT_LIVE_VIEW=1             allow a non-loopback live-view host
//     BETTERWRIGHT_LIVE_VIEW_EXPOSE=...    lan | local | tailscale hosting preset
//     BETTERWRIGHT_LIVE_VIEW_PASSWORD=...  require a password to open the live view
//     (live-view settings persist in <home>/config.json too — see docs/live-view.md;
//     `betterwright view --set-password` stores a hashed password there)
//
// Screenshots are returned as native MCP image content, so a client renders
// them directly — you never hand it a file path or guess a MIME type.

import { createRequire } from "node:module";

import {
  BetterWright,
  NetworkPolicy,
} from "./client.js";
import { normalizeCredentialToolOptions } from "./credential-tool-options.js";
import { doctorReport } from "./doctor.js";
import { isLoopbackHost, liveViewFromEnv } from "./live-view-config.js";
import { importOptionalPeer } from "./optional-peer.js";
import { piImageArtifacts, piImageContent } from "./pi.js";
import { resolveProfileName } from "./profile-name.js";
import { mcpLoginInputSchema, mcpRunInputSchema } from "./tool-schemas.js";

const require = createRequire(import.meta.url);

function boolEnv(env, name) {
  return ["1", "true", "yes", "on"].includes(
    String(env[name] || "")
      .trim()
      .toLowerCase(),
  );
}

function listEnv(env, name) {
  return String(env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function policyFromEnv(env = process.env) {
  // Private networks and loopback are open by default; set the BLOCK_* vars to
  // harden. Mirrors the CLI's --block-* flags.
  return new NetworkPolicy({
    allowLoopback: !boolEnv(env, "BETTERWRIGHT_BLOCK_LOOPBACK"),
    allowPrivateNetwork: !boolEnv(env, "BETTERWRIGHT_BLOCK_PRIVATE_NETWORK"),
    allowHosts: listEnv(env, "BETTERWRIGHT_ALLOW_HOSTS"),
    blockHosts: listEnv(env, "BETTERWRIGHT_BLOCK_HOSTS"),
  });
}

export function downloadPolicyFromEnv(env = process.env) {
  const policy = String(env.BETTERWRIGHT_DOWNLOAD_POLICY || "ask")
    .trim()
    .toLowerCase();
  if (!["ask", "allow", "deny"].includes(policy)) {
    throw new Error('BETTERWRIGHT_DOWNLOAD_POLICY must be "ask", "allow", or "deny".');
  }
  return policy;
}

export function headlessFromEnv(env = process.env) {
  // Default to "auto" (headed when a display exists, else headless); honor an
  // explicit BETTERWRIGHT_HEADLESS=0/1 when the deployer sets one.
  if (!String(env.BETTERWRIGHT_HEADLESS || "").trim()) return "auto";
  return boolEnv(env, "BETTERWRIGHT_HEADLESS");
}

/**
 * The named browser profile this server acts as, or null for the default one.
 * A profile is a separate identity — its own cookies, its own session daemon —
 * so two MCP servers on one home with different profiles both stay signed in.
 * An invalid name throws, which surfaces at startup rather than as a
 * mysteriously signed-out browser later.
 */
export function profileFromEnv(env = process.env) {
  return resolveProfileName(String(env.BETTERWRIGHT_PROFILE || "").trim() || undefined);
}

// The live-view hosting resolver moved to live-view-config.ts so the Pi
// extension shares it; re-exported here because this module has always been
// its public home (types/mcp-server.d.ts, tests).
export { liveViewFromEnv };

// The summary keys deliberately match a single documented shape (snake_case
// duration_ms included) so MCP clients see one contract.
export async function contentForResult(result) {
  const imagePaths = new Set(piImageArtifacts(result).map((image) => image.path));
  const files = (result.artifacts || [])
    .filter((artifact) => artifact.path && !imagePaths.has(artifact.path))
    .map((artifact) => ({ kind: artifact.kind, path: artifact.path }));
  const pendingCredential =
    result.pendingCredential && typeof result.pendingCredential === "object"
      ? Object.fromEntries(
          ["pendingId", "origin", "matchMode", "username", "label", "expiresAt"]
            .filter((key) => Object.hasOwn(result.pendingCredential, key))
            .map((key) => [key, result.pendingCredential[key]]),
        )
      : (result.pendingCredential ?? null);
  const summary = {
    ok: result.ok,
    // Coerce to null (not undefined) so the JSON keeps these keys, matching the
    // documented summary shape on both success and failure.
    result: result.result ?? null,
    error: result.error ?? null,
    pendingCredential,
    console: result.console || [],
    // Screenshots are returned as image content below, not as paths. Other
    // files (downloads, spilled output) are listed here as paths only.
    files,
    pages: result.pages || [],
    challenges: result.challenges || [],
    // Deeper site/provider packs matching the open pages; read the `path` with
    // your file tool before improvising site-specific behavior.
    skills: result.skills || [],
    warnings: result.warnings || [],
    duration_ms: result.durationMs,
  };
  return [
    { type: "text", text: JSON.stringify(summary) },
    ...(await piImageContent(result)),
  ];
}

const BROWSER_DESCRIPTION = `Run async Playwright JavaScript in a persistent, policy-guarded browser.
Globals: page, pages, context, state, openPage, usePage, closePage, snapshot, screenshot, artifactPath, dialogs, credentials, captcha, human. Trailing expressions auto-return; statement blocks must return.
snapshot({interactive: true}) reads; page.locator('aria-ref=eN') acts on [ref=eN]; snapshot({ref}) scopes; snapshot({diff: true}) verifies; screenshot({annotate: true}) boxes refs. Snapshots span iframes and off-screen content — never scroll to read or guess refs/URLs. screenshot({kind: 'proof'}) (inline) before claiming visible work done.
On challenges keep the page; captcha.solve() first (local); if 'processing', use the vision artifact/tile bounds, solve again. Fallbacks: captcha.detect, captcha.inspect, captcha.click, captcha.drag, captcha.readText, human.click. Max three distinct stages; a rejected action = stop, use an alternate source or human handoff. After clearing verify state; replay only if idempotent or provably incomplete. Never duplicate a submission, purchase, or message.`;

const BROWSER_DOWNLOAD_DESCRIPTION = `Variant of browser for code that clicks a download link or saves a remote file — user approval first: 'ask' (default) confirms via the MCP client. BETTERWRIGHT_DOWNLOAD_POLICY=allow skips the prompt, deny disables downloads.`;

const LOGIN_DESCRIPTION = `Fill a saved or freshly generated credential; the secret never enters the conversation.
The password fills auto-detected visible login/signup controls inside the browser worker — submitted only with submit=true or submitSelector; never returned; password fields snapshot as '[redacted]'. Selector params (CSS or current aria-ref=eN) only when detection reports ambiguity. Typing passwords in browser code is blocked.
Signup/rotation: generate=true stages and fills a new strong password (new-password + confirmation fields), never revealed. Commit only after a browser run visibly verifies success: credentials.commitGenerated({pendingId}) in browser code; on failure credentials.discardGenerated({pendingId}); pending never becomes active. After a restart credentials.listPending() lists secret-free pending metadata for the site.`;

// Parameter schema shared with the agent harness and Pi extension; the shared
// module is the single source of truth (see src/tool-schemas.ts). MCP layers
// in the per-call `session` argument and JSON-Schema `default` hints there.
export const LOGIN_INPUT_SCHEMA = mcpLoginInputSchema();

/**
 * Translate `browser_login` tool arguments into fillCredential options,
 * keeping only the recognized keys so the trusted fill sees a clean spec.
 */
export function loginOptionsFromArgs(args = {}) {
  return normalizeCredentialToolOptions(args);
}

const RUN_INPUT_SCHEMA = mcpRunInputSchema();

const HANDOFF_DESCRIPTION = `Live view of this browser — the user watches or takes over (human handoff); call anytime mid-session.
Start FIRST when the user asks to watch ('live view', 'show me', 'share the browser') and keep working; also when human hands are needed — MFA/passkey, a captcha.solve()-resistant CAPTCHA, a login the vault cannot fill, a consequential step, explicit takeover. Cookies and page state carry both ways; never claim a live view is running without this tool's URL.
action 'start' returns the URL — relay it VERBATIM, never log or share it elsewhere; for a handoff poll 'status' until done, then re-snapshot. Only watching: keep working — the view follows your session. 'stop' ends the view — never one the user asked for while they may still watch.
Viewer chat is appended to browser tool results (userChat in 'status') — fresh user instructions. Browser-call notes mirror there — write them for the user. Open comparison pages via openPage() — each is a live thumbnail tab in the viewer.`;

const HANDOFF_INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["start", "status", "stop"],
      default: "start",
    },
    reason: { type: "string", description: "Why the user is needed." },
    session: {
      type: "string",
      description: "Which session's current tab streams first.",
      default: "default",
    },
    interactive: {
      type: "boolean",
      description: "Let the viewer control the browser (default true).",
      default: true,
    },
  },
};

async function loadSdk() {
  const [
    { Server },
    { StdioServerTransport },
    { ListToolsRequestSchema, CallToolRequestSchema },
  ] = await Promise.all([
    importOptionalPeer("@modelcontextprotocol/sdk/server/index.js", "The MCP server"),
    importOptionalPeer("@modelcontextprotocol/sdk/server/stdio.js", "The MCP server"),
    importOptionalPeer("@modelcontextprotocol/sdk/types.js", "The MCP server"),
  ]);
  return { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema };
}

async function approveDownload(server, note) {
  let decision;
  try {
    decision = await server.elicitInput({
      message:
        "Allow BetterWright to run browser code that may download a file?" +
        (note ? ` Requested action: ${note}` : ""),
      requestedSchema: {
        type: "object",
        properties: {
          approved: { type: "boolean", description: "Approve this browser download?" },
        },
        required: ["approved"],
      },
    });
  } catch {
    // Clients without elicitation support fail closed.
    throw new Error(
      "This MCP client cannot present download approval; the download was blocked.",
    );
  }
  if (decision?.action !== "accept" || decision?.content?.approved !== true) {
    throw new Error("The user declined or cancelled the download.");
  }
}

function mcpTools(withLogin) {
  const tools: any[] = [
    { name: "browser", description: BROWSER_DESCRIPTION, inputSchema: RUN_INPUT_SCHEMA },
    {
      name: "browser_download",
      description: BROWSER_DOWNLOAD_DESCRIPTION,
      inputSchema: RUN_INPUT_SCHEMA,
    },
  ];
  if (withLogin) {
    tools.push({
      name: "browser_login",
      description: LOGIN_DESCRIPTION,
      inputSchema: LOGIN_INPUT_SCHEMA,
    });
  }
  tools.push({
    name: "browser_handoff",
    description: HANDOFF_DESCRIPTION,
    inputSchema: HANDOFF_INPUT_SCHEMA,
  });
  tools.push({
    name: "browser_doctor",
    description: "Whether the browser runtime is installed and ready.",
    inputSchema: { type: "object", properties: {} },
  });
  return tools;
}

function createMcpHandlers({ browser, server, downloadPolicy, liveView = liveViewFromEnv() }) {
  const withLogin = Boolean(browser.vault);
  // Chat plumbing between the live-view page and the MCP client's model. The
  // standalone agent harness drains viewer chat at its own turn boundaries;
  // over MCP the host's loop is opaque, so the boundary is each tool call:
  // notes go viewer-ward before a run, typed guidance rides back on results.
  let liveViewActive = false;
  const drainViewerChat = async () => {
    if (!liveViewActive) return [];
    try {
      const drained = await browser.liveViewDrainChat();
      return Array.isArray(drained?.messages) ? drained.messages : [];
    } catch {
      return [];
    }
  };
  const viewerChatBlock = (messages) => ({
    type: "text",
    text:
      "The user typed in the live-view chat while you worked — treat these " +
      "as fresh user instructions:\n" +
      messages.map((item) => `- ${String(item.text || "")}`).join("\n"),
  });
  const handleHandoff = async (args) => {
    const action = String(args.action || "start");
    if (action === "stop") {
      const stopped = await browser.stopLiveView();
      liveViewActive = false;
      return { content: [{ type: "text", text: JSON.stringify(stopped) }] };
    }
    if (action === "status") {
      const status = await browser.liveViewStatus();
      liveViewActive = Boolean(status?.running);
      const userChat = (await drainViewerChat()).map((item) => String(item.text || ""));
      // Never echo the token back on status; start already returned the URL.
      const { token: _token, url: _url, ...safe } = status;
      return {
        content: [
          { type: "text", text: JSON.stringify(userChat.length ? { ...safe, userChat } : safe) },
        ],
      };
    }
    if (action !== "start") throw new Error(`Unknown browser_handoff action: ${action}`);
    // "local" (loopback) never needs the opt-in; lan/tailscale — like any
    // non-loopback bind host — require the deployer to set the env flag.
    const reachesBeyondThisMachine = liveView.expose
      ? liveView.expose !== "local"
      : !isLoopbackHost(liveView.host);
    if (reachesBeyondThisMachine && !liveView.enabled) {
      throw new Error(
        "The live view would be reachable beyond this machine; the deployer must " +
          "set BETTERWRIGHT_LIVE_VIEW=1 to allow that (or set " +
          "BETTERWRIGHT_LIVE_VIEW_EXPOSE=local for loopback-only).",
      );
    }
    const view = await browser.startLiveView({
      host: liveView.host,
      port: liveView.port,
      ...(liveView.publicHost ? { publicHost: liveView.publicHost } : {}),
      ...(liveView.expose ? { expose: liveView.expose } : {}),
      ...(liveView.password ? { password: liveView.password } : {}),
      ...(liveView.passwordHash ? { passwordHash: liveView.passwordHash } : {}),
      interactive: args.interactive !== false,
      session: String(args.session || "default"),
    });
    if (!view.ok || !view.url) throw new Error(view.error || "The live view failed to start.");
    liveViewActive = true;
    const text =
      `Live view started: ${view.url}\n\n` +
      "Relay that URL to the user verbatim (it embeds a one-time capability " +
      "token) and tell them exactly what to do in the page" +
      (args.reason ? ` — reason: ${args.reason}` : "") +
      ". If the URL is on 127.0.0.1 and they are remote, they can tunnel with " +
      `\`ssh -L ${view.port}:127.0.0.1:${view.port} <host>\`. ` +
      "Poll browser_handoff {action: \"status\"} to see when they are done, " +
      "then re-observe the page with a snapshot before continuing.";
    return { content: [{ type: "text", text }] };
  };
  return {
    listTools: async () => ({ tools: mcpTools(withLogin) }),
    callTool: async (request) => {
      const { name, arguments: args = {} } = request.params;
      try {
        if (name === "browser_doctor") {
          return {
            content: [{ type: "text", text: JSON.stringify(await doctorReport()) }],
          };
        }
        if (name === "browser_login" && withLogin) {
          const result = await browser.fillCredential(loginOptionsFromArgs(args));
          const chat = await drainViewerChat();
          const content = await contentForResult(result);
          if (chat.length) content.push(viewerChatBlock(chat));
          return { content };
        }
        if (name === "browser_handoff") {
          return await handleHandoff(args);
        }
        if (name !== "browser" && name !== "browser_download") {
          throw new Error(`Unknown tool: ${name}`);
        }
        const options: Record<string, any> = {
          session: String(args.session || "default"),
          note: String(args.note || "") || undefined,
        };
        if (name === "browser_download") {
          if (downloadPolicy === "deny") {
            throw new Error(
              "Downloads are disabled by BETTERWRIGHT_DOWNLOAD_POLICY=deny.",
            );
          }
          if (downloadPolicy === "ask") await approveDownload(server, options.note);
          options.approvedDownloads = true;
        }
        if (liveViewActive && options.note) {
          await browser
            .liveViewPostChat({ role: "agent", text: options.note, kind: "step" })
            .catch(() => {});
        }
        const result = await browser.run(String(args.code || ""), options);
        const chat = await drainViewerChat();
        const content = await contentForResult(result);
        if (chat.length) content.push(viewerChatBlock(chat));
        return { content };
      } catch (error) {
        return {
          content: [{ type: "text", text: error?.message || String(error) }],
          isError: true,
        };
      }
    },
  };
}

// A narrow pure seam for protocol capability tests without opening stdio.
export const _createMcpHandlersForTest = createMcpHandlers;

export async function runMcpServer(env = process.env, options: any = {}) {
  const { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema } =
    await loadSdk();

  const downloadPolicy = downloadPolicyFromEnv(env);
  // One persistent browser for the life of the server, so pages and logins
  // survive across tool calls the way an agent expects. The built-in encrypted
  // vault enables `browser_login`; an embedding may override or disable it.
  const browser = new BetterWright({
    policy: policyFromEnv(env),
    headless: headlessFromEnv(env),
    downloadPolicy,
    // A named profile is a separate identity, so two MCP servers sharing one
    // home (a "social" one holding the logins, a "research" one that only
    // reads) both stay signed in instead of one getting a signed-out
    // ephemeral profile. Unset keeps the single default profile.
    ...(profileFromEnv(env) ? { profile: profileFromEnv(env) } : {}),
    // Identity must match egress geography (see docs/getting-started.md):
    // a headless server whose exit IP sits in another country needs these
    // pinned or geo-sensitive sites challenge every run.
    ...(String(env.BETTERWRIGHT_TIMEZONE || "").trim()
      ? { timezone: String(env.BETTERWRIGHT_TIMEZONE).trim() }
      : {}),
    ...(String(env.BETTERWRIGHT_LOCALE || "").trim()
      ? { locale: String(env.BETTERWRIGHT_LOCALE).trim() }
      : {}),
    ...(Object.hasOwn(options, "vault") ? { vault: options.vault } : {}),
  });

  const server = new Server(
    { name: "betterwright", version: require("../../package.json").version },
    { capabilities: { tools: {} } },
  );

  const handlers = createMcpHandlers({ browser, server, downloadPolicy });
  server.setRequestHandler(ListToolsRequestSchema, handlers.listTools);
  server.setRequestHandler(CallToolRequestSchema, handlers.callTool);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Serve until the client disconnects (stdin closes), then release the
  // browser. server.onclose is the SDK's protocol-level close callback.
  await new Promise((resolve) => {
    server.onclose = resolve;
  });
  await browser.close();
}
