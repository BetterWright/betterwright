import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  codexAccessToken,
  grokAccessToken,
  isJwtExpired,
  loadCodexAuth,
  loadGrokAuth,
  loginProvider,
  refreshCodexToken,
} from "../../src/auth.mjs";

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Build a signed-looking (unsigned) JWT with the given payload for token fixtures.
function fakeJwt(payload) {
  const header = base64url(Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })));
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  return `${header}.${body}.`;
}

function idToken({ email = "user@example.com", accountId = "acct-123", exp } = {}) {
  return fakeJwt({
    email,
    exp: exp ?? Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
}

let tmpHome;
let tmpGrokHome;
let prevCodexHome;
let prevGrokHome;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bw-auth-"));
  tmpGrokHome = fs.mkdtempSync(path.join(os.tmpdir(), "bw-auth-grok-"));
  prevCodexHome = process.env.CODEX_HOME;
  prevGrokHome = process.env.GROK_HOME;
  process.env.CODEX_HOME = tmpHome;
  process.env.GROK_HOME = tmpGrokHome;
});

after(() => {
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  if (prevGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = prevGrokHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpGrokHome, { recursive: true, force: true });
});

test("isJwtExpired respects exp with skew", () => {
  assert.equal(isJwtExpired(fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })), false);
  assert.equal(isJwtExpired(fakeJwt({ exp: Math.floor(Date.now() / 1000) - 10 })), true);
  assert.equal(isJwtExpired(fakeJwt({})), true, "no exp claim is treated as expired");
  assert.equal(isJwtExpired("not-a-jwt"), true);
});

// A fake OAuth issuer: serves the token endpoint for both the code exchange and
// refresh, so the whole login flow runs without touching the network.
function fakeIssuer(handler) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const params = new URLSearchParams(raw);
      const result = handler(Object.fromEntries(params), req);
      res.writeHead(result.status || 200, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });
  return server;
}

test("loginProvider runs the PKCE flow and persists codex-compatible tokens", async () => {
  let seenExchange;
  const issuer = fakeIssuer((params) => {
    seenExchange = params;
    return {
      body: {
        access_token: idToken({ accountId: "acct-xyz", exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: "refresh-1",
        id_token: idToken({ email: "me@altura.ovh", accountId: "acct-xyz" }),
      },
    };
  });
  await new Promise((r) => issuer.listen(0, "127.0.0.1", r));
  const issuerUrl = `http://127.0.0.1:${issuer.address().port}`;

  // Override just the codex issuer/ports/client for the test; keep the real
  // codex persistence and endpoint paths.
  const override = { issuer: issuerUrl, clientId: "test-client", ports: [0] };

  // Simulate the browser: as soon as we learn the authorize URL, hit the
  // callback server with a matching state and a fake code.
  const onUrl = (url) => {
    const parsed = new URL(url);
    const redirectUri = new URL(parsed.searchParams.get("redirect_uri"));
    const state = parsed.searchParams.get("state");
    assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
    assert.ok(parsed.searchParams.get("code_challenge"), "authorize URL carries a PKCE challenge");
    redirectUri.searchParams.set("code", "auth-code-1");
    redirectUri.searchParams.set("state", state);
    // Fire-and-forget; loginProvider's callback server handles it.
    http.get(redirectUri.href).on("error", () => {});
  };

  const result = await loginProvider({
    provider: "codex",
    _override: override,
    open: false,
    onUrl,
    log: () => {},
  });

  issuer.close();

  assert.equal(result.provider, "codex");
  assert.equal(result.email, "me@altura.ovh");
  assert.equal(result.accountId, "acct-xyz");
  assert.equal(seenExchange.grant_type, "authorization_code");
  assert.equal(seenExchange.code, "auth-code-1");
  assert.ok(seenExchange.code_verifier, "code_verifier is sent on exchange");
  assert.equal(seenExchange.client_id, "test-client");

  // Persisted in the codex-compatible shape.
  const stored = loadCodexAuth();
  assert.equal(stored.accountId, "acct-xyz");
  assert.equal(stored.refreshToken, "refresh-1");
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpHome, "auth.json"), "utf8"));
  assert.equal(onDisk.auth_mode, "chatgpt");
  assert.ok(onDisk.tokens.access_token);
});

test("loginProvider rejects a state mismatch", async () => {
  const onUrl = (url) => {
    const redirectUri = new URL(new URL(url).searchParams.get("redirect_uri"));
    redirectUri.searchParams.set("code", "x");
    redirectUri.searchParams.set("state", "WRONG-STATE");
    http.get(redirectUri.href).on("error", () => {});
  };
  await assert.rejects(
    loginProvider({
      provider: "codex",
      _override: { issuer: "http://127.0.0.1:1", ports: [0] },
      open: false,
      onUrl,
      log: () => {},
    }),
    /state mismatch/i,
  );
});

test("codexAccessToken refreshes an expired access token", async () => {
  // Seed an expired access token.
  fs.writeFileSync(
    path.join(tmpHome, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken({ accountId: "acct-refresh" }),
        access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
        refresh_token: "refresh-old",
        account_id: "acct-refresh",
      },
      last_refresh: new Date(0).toISOString(),
    }),
  );

  const issuer = fakeIssuer((params) => {
    assert.equal(params.grant_type, "refresh_token");
    assert.equal(params.refresh_token, "refresh-old");
    return {
      body: {
        access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: "refresh-new",
        id_token: idToken({ accountId: "acct-refresh" }),
      },
    };
  });
  await new Promise((r) => issuer.listen(0, "127.0.0.1", r));

  // Point refresh at the fake issuer by monkeypatching global fetch for the URL.
  const realFetch = globalThis.fetch;
  const issuerUrl = `http://127.0.0.1:${issuer.address().port}`;
  globalThis.fetch = (url, init) =>
    realFetch(String(url).replace("https://auth.openai.com", issuerUrl), init);
  try {
    const { accessToken } = await codexAccessToken();
    assert.equal(isJwtExpired(accessToken), false);
    assert.equal(loadCodexAuth().refreshToken, "refresh-new", "rotated refresh token is persisted");
  } finally {
    globalThis.fetch = realFetch;
    issuer.close();
  }
});

test("refreshCodexToken throws without a stored refresh token", async () => {
  fs.writeFileSync(path.join(tmpHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
  await assert.rejects(refreshCodexToken(), /refresh token/i);
});

test("login preserves an existing OPENAI_API_KEY in codex auth.json", async () => {
  // A user's pre-configured API key must survive an OAuth login.
  fs.writeFileSync(path.join(tmpHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-existing", tokens: {} }));
  const issuer = fakeIssuer(() => ({
    body: {
      access_token: idToken({ accountId: "acct-keep" }),
      refresh_token: "r",
      id_token: idToken({ accountId: "acct-keep" }),
    },
  }));
  await new Promise((r) => issuer.listen(0, "127.0.0.1", r));
  const issuerUrl = `http://127.0.0.1:${issuer.address().port}`;
  const onUrl = (url) => {
    const parsed = new URL(url);
    const redirectUri = new URL(parsed.searchParams.get("redirect_uri"));
    redirectUri.searchParams.set("code", "c");
    redirectUri.searchParams.set("state", parsed.searchParams.get("state"));
    http.get(redirectUri.href).on("error", () => {});
  };
  await loginProvider({
    provider: "codex",
    _override: { issuer: issuerUrl, clientId: "c", ports: [0] },
    open: false,
    onUrl,
    log: () => {},
  });
  issuer.close();
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpHome, "auth.json"), "utf8"));
  assert.equal(onDisk.OPENAI_API_KEY, "sk-existing", "existing API key survives login");
});

test("loginProvider closes the callback server on timeout", async () => {
  // No redirect ever arrives; a short timeout fires and the server must be torn
  // down so the loopback port is released (and the process can exit).
  let redirectUri;
  const pending = loginProvider({
    provider: "codex",
    _override: { issuer: "http://127.0.0.1:1", ports: [0] },
    open: false,
    timeoutMs: 150,
    onUrl: (url) => {
      redirectUri = new URL(url).searchParams.get("redirect_uri");
    },
    log: () => {},
  });
  await assert.rejects(pending, /Timed out/);
  // The callback port is free again — re-binding it succeeds.
  const port = Number(new URL(redirectUri).port);
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((r) => probe.close(r));
});

test("loginProvider runs the grok PKCE flow and persists to the grok store", async () => {
  let seenExchange;
  const issuer = fakeIssuer((params) => {
    seenExchange = params;
    return {
      body: {
        access_token: "grok-access-1",
        refresh_token: "grok-refresh-1",
        id_token: fakeJwt({ sub: "grok-user-1", email: "g@altura.ovh" }),
        expires_in: 3600,
      },
    };
  });
  await new Promise((r) => issuer.listen(0, "127.0.0.1", r));
  const issuerUrl = `http://127.0.0.1:${issuer.address().port}`;
  const onUrl = (url) => {
    const parsed = new URL(url);
    assert.ok(parsed.searchParams.get("nonce"), "grok authorize URL carries a nonce");
    const redirectUri = new URL(parsed.searchParams.get("redirect_uri"));
    redirectUri.searchParams.set("code", "grok-code-1");
    redirectUri.searchParams.set("state", parsed.searchParams.get("state"));
    http.get(redirectUri.href).on("error", () => {});
  };
  const result = await loginProvider({
    provider: "grok",
    _override: { issuer: issuerUrl, clientId: "grok-test-client", ports: [0] },
    open: false,
    onUrl,
    log: () => {},
  });
  issuer.close();

  assert.equal(result.provider, "grok");
  assert.equal(result.accountId, "grok-user-1");
  assert.ok(seenExchange.code_challenge, "grok echoes the PKCE challenge on exchange");
  const stored = loadGrokAuth();
  assert.equal(stored.accessToken, "grok-access-1");
  assert.equal(stored.refreshToken, "grok-refresh-1");
  assert.ok(stored.expiresAt > Date.now(), "expires_at derived from expires_in");
});

test("grokAccessToken refreshes an expired grok token and rotates it", async () => {
  fs.writeFileSync(
    path.join(tmpGrokHome, "auth.json"),
    JSON.stringify({
      auth_mode: "oauth",
      provider: "grok",
      tokens: { access_token: "old", refresh_token: "grok-refresh-old", id_token: null },
      account_id: "u1",
      expires_at: Date.now() - 1000,
      last_refresh: new Date(0).toISOString(),
    }),
  );
  const issuer = fakeIssuer((params) => {
    assert.equal(params.grant_type, "refresh_token");
    assert.equal(params.refresh_token, "grok-refresh-old");
    return { body: { access_token: "grok-access-new", refresh_token: "grok-refresh-new", expires_in: 3600 } };
  });
  await new Promise((r) => issuer.listen(0, "127.0.0.1", r));
  const realFetch = globalThis.fetch;
  const issuerUrl = `http://127.0.0.1:${issuer.address().port}`;
  globalThis.fetch = (url, init) => realFetch(String(url).replace("https://auth.x.ai", issuerUrl), init);
  try {
    const { accessToken } = await grokAccessToken();
    assert.equal(accessToken, "grok-access-new");
    assert.equal(loadGrokAuth().refreshToken, "grok-refresh-new", "rotated refresh token persisted");
  } finally {
    globalThis.fetch = realFetch;
    issuer.close();
  }
});

test("grok refresh keeps the old refresh token when the response omits one", async () => {
  fs.writeFileSync(
    path.join(tmpGrokHome, "auth.json"),
    JSON.stringify({
      auth_mode: "oauth",
      provider: "grok",
      tokens: { access_token: "old", refresh_token: "keep-me", id_token: null },
      account_id: "u1",
      expires_at: Date.now() - 1000,
    }),
  );
  const issuer = fakeIssuer(() => ({ body: { access_token: "new-access", expires_in: 3600 } }));
  await new Promise((r) => issuer.listen(0, "127.0.0.1", r));
  const realFetch = globalThis.fetch;
  const issuerUrl = `http://127.0.0.1:${issuer.address().port}`;
  globalThis.fetch = (url, init) => realFetch(String(url).replace("https://auth.x.ai", issuerUrl), init);
  try {
    await grokAccessToken();
    assert.equal(loadGrokAuth().refreshToken, "keep-me", "old refresh token preserved across a rotation-less refresh");
  } finally {
    globalThis.fetch = realFetch;
    issuer.close();
  }
});

test("grokAccessToken throws when the token is stale and no refresh token is stored", async () => {
  fs.writeFileSync(
    path.join(tmpGrokHome, "auth.json"),
    JSON.stringify({ auth_mode: "oauth", provider: "grok", tokens: { access_token: "stale" }, account_id: "u1" }),
  );
  await assert.rejects(grokAccessToken(), /refresh token/i);
});
