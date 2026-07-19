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
//     npx betterwright setup          # one-time managed browser download
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
//
// Screenshots are returned as native MCP image content, so a client renders
// them directly — you never hand it a file path or guess a MIME type.

import { createRequire } from "node:module";

import {
  BetterWright,
  NetworkPolicy,
} from "./client.mjs";
import { normalizeCredentialToolOptions } from "./credential-tool-options.mjs";
import { doctorReport } from "./doctor.mjs";
import { piImageArtifacts, piImageContent } from "./pi.mjs";
import { VAULT_MATCH_MODES } from "./vault.mjs";

const require = createRequire(import.meta.url);

const MCP_SDK_HINT =
  "The MCP SDK is required. Install it with `npm install @modelcontextprotocol/sdk`.";

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

Globals available to \`code\`: page, pages, context, state, openPage, usePage,
closePage, snapshot, screenshot, artifactPath, dialogs, credentials, captcha,
human. A single trailing expression is returned automatically; a statement
block must return.
Read pages with \`snapshot({interactive: true})\` and act on \`[ref=eN]\` via
\`page.locator('aria-ref=eN')\`. \`snapshot({ref})\` scopes to a subtree,
\`snapshot({diff: true})\` verifies an action, \`screenshot({annotate: true})\`
draws each ref's box on the image. Snapshots include iframe contents and
off-screen elements — do not scroll to read, and never guess refs or URLs.
Capture \`screenshot({kind: 'proof'})\` before claiming a visible task is done —
the image is returned inline; you do not need to open any file path.
When \`challenges\` is returned, preserve the page and call \`captcha.solve()\`
first (local automatic solver — no external APIs). If status is \`processing\`,
use the attached vision artifact / tile bounds, then solve again. Fall back to
\`captcha.detect\`, \`captcha.inspect\`, \`captcha.click\`, \`captcha.drag\`,
\`captcha.readText\`, and \`human.click\`. Work through at most three distinct
challenge stages. If the same stage rejects an action, stop native challenge
attempts immediately and use an alternate source or human handoff. When the
challenge clears, verify current application state; replay the original action
only if it is idempotent or state proves it did not already complete. Never
duplicate a submission, purchase, or message.`;

const BROWSER_DOWNLOAD_DESCRIPTION = `Run browser code that may download a file, with user approval first.

Use this instead of \`browser\` whenever the Playwright code will click a
download link or otherwise save a remote file. In the default \`ask\` mode, the
MCP client presents a confirmation before any browser code runs. Set
BETTERWRIGHT_DOWNLOAD_POLICY=allow to remove that prompt, or deny to disable
all downloads.`;

const LOGIN_DESCRIPTION = `Fill a saved or freshly generated credential without the secret ever entering the conversation.

BetterWright detects the visible enabled login/signup controls from autocomplete,
labels, names, types, and form relationships. The password is fetched, typed,
and (only with submit=true or submitSelector) submitted
entirely inside the browser worker — it is never returned to you and never
appears in a snapshot (password fields read as "[redacted]"). Use explicit CSS
or current aria-ref=eN targets only when detection reports ambiguity. Use this
instead of typing a password in browser code, which is blocked for exactly this
reason.

- Log in with a saved record: optionally pass id or username to pick the record.
- Sign up with a new strong password: set generate=true; it is generated,
  staged, filled into new-password and confirmation fields, and never revealed.
  After a later browser run visibly verifies signup/rotation success, call
  credentials.commitGenerated({pendingId}) in browser code. On failure call
  credentials.discardGenerated({pendingId}); pending credentials are not saved
  as active records. After a complete host restart, credentials.listPending()
  recovers secret-free pending metadata for the current site.

The built-in encrypted vault is enabled by default; an embedding can replace or disable it.`;

export const LOGIN_INPUT_SCHEMA = {
  type: "object",
  properties: {
    passwordSelector: {
      type: "string",
      description: "Optional CSS or current aria-ref=eN target for the password or new-password field.",
    },
    currentPasswordSelector: {
      type: "string",
      description: "Optional CSS or current aria-ref=eN target for the current-password field during rotation.",
    },
    usernameSelector: {
      type: "string",
      description: "Optional CSS or current aria-ref=eN target for the username/email field.",
    },
    confirmPasswordSelector: {
      type: "string",
      description: "Optional CSS or current aria-ref=eN target for confirmation (signup).",
    },
    submitSelector: {
      type: "string",
      description: "Optional CSS or current aria-ref=eN target clicked to submit.",
    },
    submit: {
      type: "boolean",
      description: "Detect and submit the matching form after filling (default false).",
      default: false,
    },
    id: {
      type: "string",
      description: "Select a saved record, or rotate it when generate=true.",
    },
    username: {
      type: "string",
      description: "Select the saved record by username, or set the new one on signup.",
    },
    generate: {
      type: "boolean",
      description: "Generate, stage, and fill a new strong password (signup/rotation).",
      default: false,
    },
    length: { type: "integer", description: "Generated password length (default 24)." },
    includeSymbols: {
      type: "boolean",
      description: "Include symbols in a generated password (default true).",
    },
    label: { type: "string", description: "Human label for a newly saved record." },
    matchMode: {
      type: "string",
      enum: [...VAULT_MATCH_MODES],
      description: "URL scope for the generated credential (default base-domain).",
    },
    session: {
      type: "string",
      description: "Independent set of pages/state; reuse a name across calls.",
      default: "default",
    },
  },
};

/**
 * Translate `browser_login` tool arguments into fillCredential options,
 * keeping only the recognized keys so the trusted fill sees a clean spec.
 */
export function loginOptionsFromArgs(args = {}) {
  return normalizeCredentialToolOptions(args);
}

const RUN_INPUT_SCHEMA = {
  type: "object",
  properties: {
    code: { type: "string", description: "The Playwright JavaScript to execute." },
    session: {
      type: "string",
      description: "Independent set of pages/state; reuse a name across calls.",
      default: "default",
    },
    note: {
      type: "string",
      description: "Optional present-tense status line (not run in the browser).",
      default: "",
    },
  },
  required: ["code"],
};

async function loadSdk() {
  try {
    const [
      { Server },
      { StdioServerTransport },
      { ListToolsRequestSchema, CallToolRequestSchema },
    ] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/index.js"),
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("@modelcontextprotocol/sdk/types.js"),
    ]);
    return { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema };
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") throw new Error(MCP_SDK_HINT);
    throw error;
  }
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
  const tools = [
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
    name: "browser_doctor",
    description: "Report whether the BetterWright browser runtime is installed and ready.",
    inputSchema: { type: "object", properties: {} },
  });
  return tools;
}

function createMcpHandlers({ browser, server, downloadPolicy }) {
  const withLogin = Boolean(browser.vault);
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
          return { content: await contentForResult(result) };
        }
        if (name !== "browser" && name !== "browser_download") {
          throw new Error(`Unknown tool: ${name}`);
        }
        const options = {
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
        const result = await browser.run(String(args.code || ""), options);
        return { content: await contentForResult(result) };
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

export async function runMcpServer(env = process.env, options = {}) {
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
    ...(Object.hasOwn(options, "vault") ? { vault: options.vault } : {}),
  });

  const server = new Server(
    { name: "betterwright", version: require("../package.json").version },
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
