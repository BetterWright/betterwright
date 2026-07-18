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

import { doctorReport } from "./doctor.mjs";
import { BetterWright, NetworkPolicy } from "./index.mjs";
import { piImageArtifacts, piImageContent } from "./pi.mjs";

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
  const summary = {
    ok: result.ok,
    // Coerce to null (not undefined) so the JSON keeps these keys, matching the
    // documented summary shape on both success and failure.
    result: result.result ?? null,
    error: result.error ?? null,
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

The password is fetched, typed, and (if submitSelector is given) submitted
entirely inside the browser worker — it is never returned to you and never
appears in a snapshot (password fields read as "[redacted]"). Provide CSS
selectors for the fields. Use this instead of typing a password in browser
code, which is blocked for exactly this reason.

- Log in with a saved record: pass passwordSelector (and usernameSelector), and
  optionally id or username to pick the record.
- Sign up with a new strong password: set generate=true; it is generated,
  filled into passwordSelector and confirmPasswordSelector, saved to the vault,
  and never revealed.

Requires a host-configured vault; without one there are no credentials to fill.`;

const LOGIN_INPUT_SCHEMA = {
  type: "object",
  properties: {
    passwordSelector: {
      type: "string",
      description: "CSS selector for the password field (required).",
    },
    usernameSelector: {
      type: "string",
      description: "CSS selector for the username/email field.",
    },
    confirmPasswordSelector: {
      type: "string",
      description: "CSS selector for a confirm-password field (signup).",
    },
    submitSelector: {
      type: "string",
      description: "CSS selector clicked to submit in the same trusted call.",
    },
    id: { type: "string", description: "Select the saved record by id." },
    username: {
      type: "string",
      description: "Select the saved record by username, or set the new one on signup.",
    },
    generate: {
      type: "boolean",
      description: "Generate, fill, and save a new strong password (signup).",
      default: false,
    },
    length: { type: "integer", description: "Generated password length (default 24)." },
    includeSymbols: {
      type: "boolean",
      description: "Include symbols in a generated password (default true).",
    },
    label: { type: "string", description: "Human label for a newly saved record." },
    session: {
      type: "string",
      description: "Independent set of pages/state; reuse a name across calls.",
      default: "default",
    },
  },
  required: ["passwordSelector"],
};

/**
 * Translate `browser_login` tool arguments into fillCredential options,
 * keeping only the recognized keys so the trusted fill sees a clean spec.
 */
export function loginOptionsFromArgs(args = {}) {
  const options = {
    session: String(args.session || "default"),
    passwordSelector: String(args.passwordSelector || ""),
    generate: args.generate === true,
  };
  for (const key of [
    "usernameSelector",
    "confirmPasswordSelector",
    "submitSelector",
    "id",
    "username",
    "label",
  ]) {
    if (args[key] != null) options[key] = String(args[key]);
  }
  if (args.length != null) options.length = Number(args.length);
  if (typeof args.includeSymbols === "boolean")
    options.includeSymbols = args.includeSymbols;
  return options;
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

export async function runMcpServer(env = process.env, { vault } = {}) {
  const { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema } =
    await loadSdk();

  const downloadPolicy = downloadPolicyFromEnv(env);
  // One persistent browser for the life of the server, so pages and logins
  // survive across tool calls the way an agent expects. Pass a `vault` when
  // embedding programmatically to enable `browser_login`; the plain CLI has no
  // vault, so logins there go through a password-manager extension instead.
  const browser = new BetterWright({
    policy: policyFromEnv(env),
    headless: headlessFromEnv(env),
    downloadPolicy,
    ...(vault ? { vault } : {}),
  });

  const server = new Server(
    { name: "betterwright", version: require("../package.json").version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "browser", description: BROWSER_DESCRIPTION, inputSchema: RUN_INPUT_SCHEMA },
      {
        name: "browser_download",
        description: BROWSER_DOWNLOAD_DESCRIPTION,
        inputSchema: RUN_INPUT_SCHEMA,
      },
      {
        name: "browser_login",
        description: LOGIN_DESCRIPTION,
        inputSchema: LOGIN_INPUT_SCHEMA,
      },
      {
        name: "browser_doctor",
        description:
          "Report whether the BetterWright browser runtime is installed and ready.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (name === "browser_doctor") {
        return {
          content: [{ type: "text", text: JSON.stringify(await doctorReport()) }],
        };
      }
      if (name === "browser_login") {
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
          throw new Error("Downloads are disabled by BETTERWRIGHT_DOWNLOAD_POLICY=deny.");
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
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Serve until the client disconnects (stdin closes), then release the
  // browser. server.onclose is the SDK's protocol-level close callback.
  await new Promise((resolve) => {
    server.onclose = resolve;
  });
  await browser.close();
}
