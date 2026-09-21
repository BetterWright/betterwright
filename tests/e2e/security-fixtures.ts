import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import type { E2EContext } from "./types.js";

export function result(envelope: any): any {
  assert.equal(envelope.ok, true, envelope.error);
  return envelope.result;
}

export function denied(envelope: any, reason: RegExp): void {
  assert.equal(envelope.ok, false, "operation unexpectedly succeeded");
  assert.match(envelope.error, reason);
}

export function syntheticSecret(ctx: E2EContext): string {
  const value = `E2E-only!${randomUUID()}-Aa9`;
  ctx.redact(value);
  return value;
}

export function excludesSecret(value: any, secret: string): void {
  assert.equal(JSON.stringify(value).includes(secret), false, "handled synthetic secret leaked");
}

function form(kind: string, suffix = ""): string {
  const signup = kind === "signup";
  const rotation = kind === "rotate";
  const passwordRole = signup || rotation ? "new-password" : "current-password";
  return `<form id="form${suffix}" data-kind="${kind}">
    <label>Username<input id="username${suffix}" name="username" autocomplete="username"></label>
    ${rotation ? `<label>Current password<input id="current${suffix}" name="current" type="password" autocomplete="current-password"></label>` : ""}
    <label>${signup || rotation ? "New password" : "Password"}<input id="password${suffix}" name="password" type="password" autocomplete="${passwordRole}"></label>
    ${signup || rotation ? `<label>Confirm password<input id="confirm${suffix}" name="confirm" type="password" autocomplete="new-password"></label>` : ""}
    <button type="submit">${signup ? "Create account" : rotation ? "Change password" : "Sign in"}</button>
  </form>`;
}

export async function credentialSite(ctx: E2EContext, expectedPassword?: string) {
  const state = {
    requests: new Map<string, number>(),
    submissions: 0,
    accepted: 0,
    rejected: 0,
  };
  const server = await ctx.serve((request, response) => {
    const pathname = new URL(request.url || "/", "http://fixture.invalid").pathname;
    state.requests.set(pathname, (state.requests.get(pathname) || 0) + 1);
    response.setHeader("cache-control", "no-store");
    if (request.method === "POST" && pathname.startsWith("/submit/")) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const fields = new URLSearchParams(body);
        const password = fields.get("password") || "";
        const kind = pathname.slice("/submit/".length);
        const accepted = Boolean(fields.get("username")) && (kind === "login"
          ? expectedPassword === undefined ? password.length >= 16 : password === expectedPassword
          : password.length >= 16 && password === fields.get("confirm") &&
            (kind !== "rotate" || fields.get("current") === expectedPassword));
        state.submissions += 1;
        state.accepted += Number(accepted);
        state.rejected += Number(!accepted);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ accepted }));
      });
      return;
    }
    if (pathname === "/download") {
      response.setHeader("content-type", "application/octet-stream");
      response.setHeader("content-disposition", 'attachment; filename="fixture.txt"');
      response.end("local security download fixture");
      return;
    }
    const kind = pathname === "/signup" ? "signup" : pathname === "/rotate" ? "rotate" : "login";
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><title>Security fixture</title><link rel="icon" href="data:,"></head><body>
      <h1 id="status">Security fixture</h1>
      ${pathname === "/ambiguous" ? form("login", "-one") + form("login", "-two") : form(kind)}
      <input id="upload" type="file"><a id="download" href="/download">Download fixture</a>
      <script>
        window.submits = 0;
        for (const form of document.forms) form.addEventListener("submit", async (event) => {
          event.preventDefault();
          window.submits += 1;
          const response = await fetch("/submit/" + form.dataset.kind, {
            method: "POST", body: new URLSearchParams(new FormData(form)),
          });
          const outcome = await response.json();
          document.querySelector("#status").textContent = outcome.accepted
            ? form.dataset.kind === "signup" ? "Account created" : form.dataset.kind === "rotate" ? "Password changed" : "Signed in"
            : "Rejected";
        });
      </script></body></html>`);
  });
  return { ...server, state };
}

export async function savedLogin(ctx: E2EContext, matchMode = "exact-origin") {
  const secret = syntheticSecret(ctx);
  const site = await credentialSite(ctx, secret);
  const saved = await ctx.run(`
    await page.goto(${JSON.stringify(`${site.origin}/login`)});
    return credentials.save({username: "fixture-user", password: ${JSON.stringify(secret)},
      label: "E2E account", matchMode: ${JSON.stringify(matchMode)}});
  `);
  excludesSecret(saved, secret);
  const record = result(saved);
  assert.ok(record.id);
  return { site, secret, record };
}

export async function confinedUpstream(ctx: E2EContext) {
  const authorities: string[] = [];
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();
  const body = '<!doctype html><title>Confined upstream</title><link rel="icon" href="data:,"><h1>Local proxy fixture</h1>';
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(2_000, () => socket.destroy());
    let buffer = "";
    let connected = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      let end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      if (!connected) {
        const [method, authority] = buffer.slice(0, end).split("\r\n")[0].split(" ");
        if (method !== "CONNECT") {
          socket.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          return;
        }
        authorities.push(authority);
        if (authority.endsWith(":443")) {
          socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          return;
        }
        connected = true;
        buffer = buffer.slice(end + 4);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
      }
      requests.push(buffer.slice(0, end).split("\r\n")[0]);
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address);
  const port = Object.getOwnPropertyDescriptor(address, "port")?.value;
  assert.ok(Number.isInteger(port), "TCP fixture has no port");
  ctx.cleanup(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  return { origin: `http://127.0.0.1:${port}`, authorities, requests };
}
