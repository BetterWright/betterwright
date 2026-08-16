// Native OAuth login for the built-in agent's model backends.
//
// `betterwright auth --login codex|grok` runs the provider's OAuth 2.0 PKCE
// flow itself — the same "Sign in to Codex with ChatGPT" consent screen the
// codex CLI uses — and stores the resulting tokens where the matching model
// adapter reads them. This removes the dependency on an external OAuth router:
// BetterWright holds its own tokens and refreshes them.
//
// Only the login/token machinery lives here. Using the tokens to call the model
// (the ChatGPT-backend Responses API, or xAI) is the adapter's job in agent.ts.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import type { UntrustedValue } from "./untrusted-value.js";

function base64url(buffer) {
  return buffer.toString("base64url");
}

// PKCE (RFC 7636): a random verifier and its S256 challenge.
function createPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function randomState() {
  return base64url(crypto.randomBytes(32));
}

// Parse a token-endpoint body, turning an unexpected non-JSON response (an HTML
// error page, a proxy notice) into a readable error instead of a SyntaxError.
function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned a non-JSON response: ${String(text).slice(0, 200)}`);
  }
}

// Decode a JWT payload without verifying the signature (we only read claims from
// a token the token endpoint just handed us over TLS).
function decodeJwtPayload(token) {
  try {
    const segment = String(token).split(".")[1];
    if (!segment) return {};
    // JWT segments are base64url. Node's "base64" decoder happens to accept the
    // URL-safe alphabet too, but naming the real encoding keeps this correct on
    // its own terms rather than by decoder leniency.
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function grokHome() {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

// The codex CLI's public OAuth client and endpoints (verified against the
// open-source codex login server). BetterWright reuses the same client so its
// tokens interoperate with ~/.codex/auth.json.
const CODEX = {
  name: "codex",
  issuer: "https://auth.openai.com",
  authorizePath: "/oauth/authorize",
  tokenPath: "/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
  ports: [1455, 1457],
  redirectPath: "/auth/callback",
  extraAuthParams: { id_token_add_organizations: "true", codex_cli_simplified_flow: "true" },
  persist: writeCodexAuth,
};

// xAI / Grok subscription OAuth (SuperGrok / X Premium+). Public desktop client
// and endpoints verified against the auth.x.ai OIDC discovery document and two
// open-source implementations. Uses a loopback + PKCE authorization-code flow.
const GROK = {
  name: "grok",
  issuer: "https://auth.x.ai",
  authorizePath: "/oauth2/authorize",
  tokenPath: "/oauth2/token",
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  scope: "openid profile email offline_access grok-cli:access api:access",
  ports: [56121, 0],
  redirectHost: "127.0.0.1",
  redirectPath: "/callback",
  extraAuthParams: { plan: "generic", referrer: "hermes-agent" },
  useNonce: true,
  sendChallengeOnExchange: true,
  persist: (tokens) => writeGrokAuth(tokens),
};

function providerByName(name) {
  if (name === "codex") return CODEX;
  if (name === "grok") return GROK;
  return null;
}

function authorizeUrl(provider, { redirectUri, challenge, state, nonce }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    scope: provider.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  if (provider.useNonce) params.set("nonce", nonce);
  // `set`, not `append`: the original init-object spread let an extra param
  // override a base one, and a repeated key must not send two values.
  for (const [key, value] of Object.entries(provider.extraAuthParams || {})) {
    params.set(key, String(value));
  }
  return `${provider.issuer}${provider.authorizePath}?${params.toString()}`;
}

// Open a URL in the user's default browser, best-effort. The URL is always
// returned/printed too, so a headless or SSH session can paste it.
function openInBrowser(url) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed URL is the fallback.
  }
}

// Bind a loopback server on the first free port from the provider's list. The
// redirect_uri must match the port we actually bind, so binding happens before
// the authorize URL is built. Returns the bound redirect URI plus a promise that
// resolves with the authorization code once the provider redirects back.
function startCallbackServer(provider, { state, log }): Promise<any> {
  return new Promise((resolveBind, rejectBind) => {
    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, "http://127.0.0.1");
      if (requestUrl.pathname !== provider.redirectPath) {
        res.writeHead(404).end("Not found");
        return;
      }
      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");
      const returnedState = requestUrl.searchParams.get("state");
      const reply = (ok, message) => {
        res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>BetterWright</title><body style="font:16px system-ui;padding:3rem;text-align:center"><h2>${ok ? "Signed in ✓" : "Sign-in failed"}</h2><p>${message}</p><p style="color:#888">You can close this tab and return to the terminal.</p></body>`,
        );
        server.close();
      };
      if (error) {
        reply(false, `The provider returned an error: ${error}.`);
        rejectCode(new Error(`OAuth error: ${error}`));
        return;
      }
      if (returnedState !== state) {
        reply(false, "State mismatch — possible cross-site request. Aborted.");
        rejectCode(new Error("OAuth state mismatch — aborting."));
        return;
      }
      if (!code) {
        reply(false, "No authorization code was returned.");
        rejectCode(new Error("No authorization code in the OAuth redirect."));
        return;
      }
      reply(true, "BetterWright captured your authorization.");
      resolveCode(code);
    });

    // Try the provider's ports in order, moving on from an in-use port.
    const ports = [...provider.ports];
    const bind = () => {
      const port = ports.shift();
      if (port == null) {
        rejectBind(new Error(`Could not bind any of ports ${provider.ports.join(", ")} for the OAuth callback.`));
        return;
      }
      const onError = (err) => {
        if (err.code === "EADDRINUSE") {
          log?.(`  port ${port} in use, trying next…`);
          bind();
        } else {
          rejectBind(err);
        }
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        server.on("error", rejectCode);
        // Use the actually-bound port (matters when port 0 = ephemeral).
        // SAFETY: inside the listen callback of a TCP server, address() is
        // always an AddressInfo object; only pipe/IPC servers yield a string.
        const boundPort = (server.address() as { port: number }).port;
        resolveBind({
          redirectUri: `http://${provider.redirectHost || "localhost"}:${boundPort}${provider.redirectPath}`,
          codePromise,
          server,
        });
      });
    };
    bind();
  });
}

async function exchangeCode(provider, { code, verifier, challenge, redirectUri, fetchImpl }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: provider.clientId,
    code_verifier: verifier,
  });
  // Some providers (xAI) echo the challenge on exchange as well.
  if (provider.sendChallengeOnExchange) {
    body.set("code_challenge", challenge);
    body.set("code_challenge_method", "S256");
  }
  const response = await (fetchImpl || fetch)(`${provider.issuer}${provider.tokenPath}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Token exchange failed (${response.status}): ${text.slice(0, 400)}`);
  const tokens = parseJson(text, "Token exchange");
  if (!tokens.access_token) throw new Error("Token exchange returned no access token.");
  return tokens;
}

// The chatgpt_account_id lives in the id_token's OpenAI auth claim.
function accountIdFromIdToken(idToken) {
  const claims = decodeJwtPayload(idToken);
  return (
    claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims?.["https://api.openai.com/auth"]?.user_id ||
    claims?.organization_id ||
    null
  );
}

// The auth.json layouts this module reads back. Every field is re-guarded
// with `?.`/`||` fallbacks on use: the file is user-editable (and shared with
// the codex CLI), so presence is never assumed, only tolerated.
interface StoredOAuthTokens {
  id_token?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  account_id?: string | null;
}

interface StoredCodexAuth {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: StoredOAuthTokens;
  last_refresh?: string | null;
}

interface StoredGrokAuth {
  auth_mode?: string;
  provider?: string;
  tokens?: StoredOAuthTokens;
  account_id?: string | null;
  expires_at?: number | null;
  last_refresh?: string | null;
}

// Persist codex tokens in the same layout the codex CLI writes, so the two
// share one session and `codex login status` stays truthful.
function writeCodexAuth(tokens) {
  const dir = codexHome();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "auth.json");
  let existing: StoredCodexAuth = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // fresh file
  }
  // A refresh may omit id_token / refresh_token; fall back to the stored values
  // so a partial write never wipes credentials (mirrors writeGrokAuth).
  const idToken = tokens.id_token || existing.tokens?.id_token || null;
  const merged = {
    ...existing,
    auth_mode: "chatgpt",
    OPENAI_API_KEY: existing.OPENAI_API_KEY ?? null,
    tokens: {
      id_token: idToken,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || existing.tokens?.refresh_token || null,
      account_id: accountIdFromIdToken(idToken) || existing.tokens?.account_id || null,
    },
    last_refresh: new Date().toISOString(),
  };
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return { file, accountId: merged.tokens.account_id };
}

// Persist grok tokens in BetterWright's own store (~/.grok/auth.json). Grok
// access tokens are short-lived, so we record an absolute expiry.
function writeGrokAuth(tokens) {
  const dir = grokHome();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "auth.json");
  let existing: StoredGrokAuth = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // fresh file
  }
  const expiresAt = tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 : existing.expires_at ?? null;
  const claims = decodeJwtPayload(tokens.id_token);
  const merged = {
    auth_mode: "oauth",
    provider: "grok",
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || existing.tokens?.refresh_token,
      id_token: tokens.id_token || existing.tokens?.id_token || null,
    },
    account_id: claims?.sub || existing.account_id || null,
    expires_at: expiresAt,
    last_refresh: new Date().toISOString(),
  };
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return { file, accountId: merged.account_id };
}

export function loadGrokAuth() {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(grokHome(), "auth.json"), "utf8"));
    const tokens = auth.tokens || {};
    if (!tokens.access_token && !tokens.refresh_token) return null;
    return {
      accessToken: tokens.access_token || null,
      refreshToken: tokens.refresh_token || null,
      idToken: tokens.id_token || null,
      accountId: auth.account_id || null,
      expiresAt: auth.expires_at || null,
    };
  } catch {
    return null;
  }
}

// Concurrent requests can each notice an expired token at once; a single
// in-flight refresh is shared so the refresh token is only rotated once.
let grokRefreshInFlight = null;

// Exchange the stored grok refresh token for a fresh access token, persisting
// the rotated tokens back to auth.json.
export async function refreshGrokToken() {
  if (grokRefreshInFlight) return grokRefreshInFlight;
  grokRefreshInFlight = (async () => {
    const stored = loadGrokAuth();
    if (!stored?.refreshToken) throw new Error("No grok refresh token — run `betterwright auth --login grok`.");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: GROK.clientId,
      refresh_token: stored.refreshToken,
    });
    const response = await fetch(`${GROK.issuer}${GROK.tokenPath}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Grok token refresh failed (${response.status}): ${text.slice(0, 300)}`);
    const refreshed = parseJson(text, "Grok token refresh");
    if (!refreshed.access_token) throw new Error("Grok token refresh returned no access token.");
    writeGrokAuth({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || stored.refreshToken,
      id_token: refreshed.id_token || stored.idToken,
      expires_in: refreshed.expires_in,
    });
    return refreshed.access_token;
  })();
  try {
    return await grokRefreshInFlight;
  } finally {
    grokRefreshInFlight = null;
  }
}

/**
 * Return a valid grok access token, refreshing it if it is expired or within a
 * skew window. Throws if the user has not signed in.
 * @returns {Promise<{accessToken: string, accountId: (string|null)}>}
 */
export async function grokAccessToken() {
  const stored = loadGrokAuth();
  if (!stored) throw new Error("Not signed in to grok — run `betterwright auth --login grok`.");
  const fresh = stored.expiresAt && stored.expiresAt > Date.now() + 120_000;
  if (stored.accessToken && fresh) return { accessToken: stored.accessToken, accountId: stored.accountId };
  const accessToken = await refreshGrokToken();
  return { accessToken, accountId: loadGrokAuth()?.accountId ?? stored.accountId };
}

// Read stored codex tokens (BetterWright and the codex CLI share this file).
export function loadCodexAuth() {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(codexHome(), "auth.json"), "utf8"));
    const tokens = auth.tokens || {};
    if (!tokens.access_token && !tokens.refresh_token) return null;
    return {
      accessToken: tokens.access_token || null,
      refreshToken: tokens.refresh_token || null,
      idToken: tokens.id_token || null,
      accountId: tokens.account_id || accountIdFromIdToken(tokens.id_token),
      apiKey: auth.OPENAI_API_KEY || null,
      lastRefresh: auth.last_refresh || null,
    };
  } catch {
    return null;
  }
}

// A JWT is expired (or within `skewSeconds` of it). Used to decide whether to
// refresh the access token before a request.
export function isJwtExpired(token, skewSeconds = 120) {
  const claims = decodeJwtPayload(token);
  if (!claims?.exp) return true;
  return claims.exp * 1000 <= Date.now() + skewSeconds * 1000;
}

// Concurrent requests can each notice an expired token at once; a single
// in-flight refresh is shared so the refresh token is only rotated once.
let codexRefreshInFlight = null;

// Exchange the stored refresh token for a fresh access token, persisting the
// rotated tokens back to auth.json.
export async function refreshCodexToken() {
  if (codexRefreshInFlight) return codexRefreshInFlight;
  codexRefreshInFlight = (async () => {
    const stored = loadCodexAuth();
    if (!stored?.refreshToken) throw new Error("No codex refresh token — run `betterwright auth --login codex`.");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
      client_id: CODEX.clientId,
      scope: "openid profile email",
    });
    const response = await fetch(`${CODEX.issuer}${CODEX.tokenPath}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Codex token refresh failed (${response.status}): ${text.slice(0, 300)}`);
    const refreshed = parseJson(text, "Codex token refresh");
    if (!refreshed.access_token) throw new Error("Codex token refresh returned no access token.");
    // A refresh may omit id_token / refresh_token; keep the prior values.
    writeCodexAuth({
      id_token: refreshed.id_token || stored.idToken,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || stored.refreshToken,
    });
    return refreshed.access_token;
  })();
  try {
    return await codexRefreshInFlight;
  } finally {
    codexRefreshInFlight = null;
  }
}

/**
 * Return a valid codex access token, refreshing it if expired. Throws if the
 * user has not signed in.
 * @returns {Promise<{accessToken: string, accountId: (string|null)}>}
 */
export async function codexAccessToken() {
  const stored = loadCodexAuth();
  if (!stored) throw new Error("Not signed in to codex — run `betterwright auth --login codex`.");
  if (stored.accessToken && !isJwtExpired(stored.accessToken))
    return { accessToken: stored.accessToken, accountId: stored.accountId };
  const accessToken = await refreshCodexToken();
  return { accessToken, accountId: loadCodexAuth()?.accountId ?? stored.accountId };
}

// The caller's progress sink, per LoginProviderOptions.log in types/auth.d.ts.
// Callability is the checked invariant; the signature is the declared contract.
function isLogSink(value: UntrustedValue): value is (line: string) => void {
  return typeof value === "function";
}

/**
 * Run the interactive OAuth login for a provider.
 * @param {object} options
 * @param {"codex"|"grok"} options.provider
 * @param {(url: string) => void} [options.onUrl] receives the authorize URL
 * @param {(line: string) => void} [options.log] progress lines
 * @param {boolean} [options.open=true] open the URL in a browser
 * @param {number} [options.timeoutMs=180000] how long to wait for the redirect
 * @returns {Promise<{provider: string, file: string, accountId: (string|null), email: (string|null)}>}
 */
export async function loginProvider(options: any = {}) {
  const name = String(options.provider || "").toLowerCase();
  const base = providerByName(name);
  if (!base) throw new Error(`Unsupported provider "${options.provider}". Supported: codex, grok.`);
  // `_override` is a test seam to point the flow at a fake issuer/ports while
  // keeping the real persistence and paths.
  const provider = options._override ? { ...base, ...options._override } : base;
  const log = isLogSink(options.log) ? options.log : () => {};

  const { verifier, challenge } = createPkce();
  const state = randomState();
  const nonce = randomState();

  const { redirectUri, codePromise, server } = await startCallbackServer(provider, { state, log });
  const url = authorizeUrl(provider, { redirectUri, challenge, state, nonce });

  options.onUrl?.(url);
  log(`Opening the ${provider.name} sign-in page in your browser…`);
  log(url);
  if (options.open !== false) openInBrowser(url);

  const timeoutMs = Number(options.timeoutMs) || 180_000;
  let timer;
  try {
    const code = await Promise.race([
      codePromise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for sign-in.`)),
          timeoutMs,
        );
      }),
    ]);
    log("Exchanging the authorization code for tokens…");
    const tokens = await exchangeCode(provider, { code, verifier, challenge, redirectUri, fetchImpl: options.fetchImpl });
    const { file, accountId } = provider.persist(tokens);
    const email = decodeJwtPayload(tokens.id_token)?.email || null;
    return { provider: provider.name, file, accountId, email };
  } finally {
    // On timeout/error the redirect never arrives and the server is still
    // listening; always release the loopback port so the process can exit.
    clearTimeout(timer);
    if (server.listening) server.close();
  }
}

export { grokHome };
