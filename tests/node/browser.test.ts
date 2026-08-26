// End-to-end Node tests. Skipped unless doctor reports a ready managed browser,
// so the policy suite still runs on machines without BetterChromium installed.
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";

import { doctorReport } from "../../dist/src/doctor.js";
import { BetterWright, NetworkPolicy, runAgentTask } from "../../dist/src/index.js";
import { _createMcpHandlersForTest } from "../../dist/src/mcp-server.js";
import { isBoolean, isCallable, isString } from "../../dist/src/untrusted-value.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const browserStatus = await doctorReport();
const ready = browserStatus.ready;
// On a laptop without a ready browser, skipping is friendly. In CI it would mean
// the entire integration suite silently reports green without running, so the
// workflows set BETTERWRIGHT_REQUIRE_BROWSER=1 to turn that into a failure.
if (!ready && process.env.BETTERWRIGHT_REQUIRE_BROWSER) {
  throw new Error(
    `BETTERWRIGHT_REQUIRE_BROWSER is set but no browser runtime is ready (doctor browser: ${browserStatus.browser}) — ` +
      "the browser integration suite would silently skip. Run `betterwright setup`.",
  );
}
const opts = {
  skip: ready ? false : `browser runtime not ready (doctor browser: ${browserStatus.browser})`,
};
function tempHome() {
  return makeTempDir("betterwright-test-");
}

// Chromium's site isolation keys on scheme + eTLD+1 and ignores the port, so a
// caller that needs a genuinely cross-site frame has to pass a distinct
// loopback host, not just a distinct port.
async function listen(handler, host = "127.0.0.1") {
  const server = http.createServer(handler);
  server.listen(0, host);
  await once(server, "listening");
  // SAFETY: the server finished `listen` on a TCP port, so `address()` returns
  // an AddressInfo — not the null of an unbound server or a pipe-name string.
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${host}:${port}`,
    port,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function scriptedAgentModel(turns) {
  let index = 0;
  const seen = [];
  return {
    seen,
    async complete(request) {
      seen.push(request);
      const scripted = turns[index++];
      const turn = isCallable(scripted) ? await scripted(request) : scripted;
      assert.ok(turn, `unexpected agent turn ${index}`);
      return { text: "", usage: null, ...turn };
    },
  };
}

class LimitedBetterWright extends BetterWright {
  limits: any;
  // Declared, not defined: they are inherited from the untyped built runtime.
  declare run: (code: string, options?: any) => Promise<any>;
  declare close: () => Promise<void>;

  constructor(options, limits) {
    super(options);
    this.limits = limits;
  }

  _workerConfig() {
    return { ...super._workerConfig(), ...this.limits };
  }
}

function directorySize(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(target);
    else total += fs.statSync(target).size;
  }
  return total;
}

function largestFileSize(root) {
  if (!fs.existsSync(root)) return 0;
  let largest = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    largest = Math.max(
      largest,
      entry.isDirectory() ? largestFileSize(target) : fs.statSync(target).size,
    );
  }
  return largest;
}

test("navigate and read the title", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), policy: new NetworkPolicy(), headless: true });
  try {
    const result = await bw.run("await page.goto('https://example.com'); return page.title()");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, "Example Domain");
  } finally {
    await bw.close();
  }
});

test("stock software-rasterizer boilerplate warns without blocking launch", opts, async () => {
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    chromiumArgs: ["--disable-software-rasterizer"],
  });
  try {
    const result = await bw.run("return 42");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, 42);
    assert.ok(
      result.warnings.some((warning) =>
        /Ignored Chromium switch --disable-software-rasterizer/.test(warning),
      ),
      JSON.stringify(result.warnings),
    );
  } finally {
    await bw.close();
  }
});

test("the selected managed browser keeps WebGL available with a coherent identity", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`return await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 2;
      const gl = canvas.getContext("webgl");
      if (!gl) {
        // Diagnostic detail for a GPU-less runner: report every GL surface so a
        // null context says why rather than just "false".
        let webgl2 = "null";
        try { webgl2 = canvas.getContext("webgl2") ? "ok" : "null"; } catch (e) { webgl2 = "err:" + e.message; }
        return { available: false, webgl2, userAgent: navigator.userAgent, platform: navigator.platform };
      }
      gl.clearColor(0.25, 0.5, 0.75, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const pixels = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        available: true,
        vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        extensions: gl.getSupportedExtensions()?.length || 0,
        pixels: [...pixels],
        userAgent: navigator.userAgent,
        platform: navigator.platform,
      };
    });`);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.available, true, JSON.stringify(result.result));
    assert.ok(isString(result.result.vendor));
    assert.ok(result.result.vendor.length > 0);
    assert.ok(isString(result.result.renderer));
    assert.ok(result.result.renderer.length > 0);
    assert.ok(result.result.extensions > 0);
    for (const [index, actual] of result.result.pixels.entries()) {
      assert.ok(Math.abs(actual - [64, 128, 191, 255][index]) <= 1);
    }
    if (browserStatus.browser === "chromium-fork" && process.platform === "linux") {
      // Honest-Linux fork: no Mac masquerade. The WebGL identity is a common
      // GPU (never "SwiftShader"/"llvmpipe", even on a GPU-less host), the
      // platform is Linux, and the UA says Linux.
      assert.equal(result.result.platform, "Linux x86_64", JSON.stringify(result.result));
      assert.match(result.result.userAgent, /Linux/, result.result.userAgent);
      assert.doesNotMatch(result.result.userAgent, /Macintosh/, result.result.userAgent);
      assert.doesNotMatch(result.result.renderer, /SwiftShader|llvmpipe|softpipe/i, result.result.renderer);
      assert.match(result.result.renderer, /ANGLE/, result.result.renderer);
    } else if (/Macintosh/.test(result.result.userAgent)) {
      assert.equal(result.result.platform, "MacIntel");
    } else if (/Windows/.test(result.result.userAgent)) {
      assert.equal(result.result.platform, "Win32");
    } else {
      assert.match(result.result.userAgent, /Linux/);
      assert.match(result.result.platform, /Linux/);
    }
  } finally {
    await bw.close();
  }
});

test("managed sessions preserve native service-worker behavior", opts, async () => {
  const site = await listen((request, response) => {
    if (request.url === "/sw.js") {
      response.writeHead(200, {
        "content-type": "application/javascript",
        "service-worker-allowed": "/",
      });
      response.end("self.addEventListener('fetch', () => {});");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Service worker fixture</title>");
  });
  const bw = new BetterWright({
    home: tempHome(),
    policy: new NetworkPolicy(),
    headless: true,
  });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(site.origin)});
      return page.evaluate(async () => {
        const registration = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        return {
          scope: registration.scope,
          active: Boolean(registration.active),
        };
      });
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.active, true);
    assert.equal(result.result.scope, `${site.origin}/`);
  } finally {
    await bw.close();
    await site.close();
  }
});

test("page summaries identify the active tab", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const opened = await bw.run(`
      await page.setContent('<title>First</title><h1>First</h1>');
      const second = await openPage();
      await second.setContent('<title>Second</title><h1>Second</h1>');
      return pages.map(item => ({ pageId: item }));
    `);
    assert.equal(opened.ok, true, opened.error);
    assert.equal(opened.pages.length, 2);
    assert.equal(opened.pages.filter((page) => page.active).length, 1);
    assert.equal(opened.pages.find((page) => page.active).title, "Second");

    const firstId = opened.pages.find((page) => page.title === "First").pageId;
    const selected = await bw.run(`
      await usePage(${JSON.stringify(firstId)});
      return page.title();
    `);
    assert.equal(selected.ok, true, selected.error);
    assert.equal(selected.pages.filter((page) => page.active).length, 1);
    assert.equal(selected.pages.find((page) => page.active).title, "First");
  } finally {
    await bw.close();
  }
});

test("role names and page handles reject objects at the call boundary", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const regexName = await bw.run(`
      await page.setContent('<input aria-label="Email">');
      return page.getByRole('textbox', {name: /email/i}).count();
    `);
    assert.equal(regexName.ok, true, regexName.error);
    assert.equal(regexName.result, 1);

    const roleName = await bw.run(`
      await page.getByRole('textbox', {name: {text: 'Email'}}).click();
    `);
    assert.equal(roleName.ok, false);
    assert.equal(
      roleName.error,
      "getByRole name must be a string or RegExp, received object.",
    );
    assert.doesNotMatch(roleName.error, /\[object Object\]|InvalidSelector|timed out/i);

    const pageHandle = await bw.run("await usePage(pages[0]);");
    assert.equal(pageHandle.ok, false);
    assert.equal(
      pageHandle.error,
      "usePage page handle must be a page ID string or numeric index, received object.",
    );
    assert.doesNotMatch(pageHandle.error, /\[object Object\]|Unknown page/i);

    const closeHandle = await bw.run("await closePage({pageId: 'page-1'});");
    assert.equal(closeHandle.ok, false);
    assert.equal(
      closeHandle.error,
      "closePage page handle must be a page ID string or numeric index, received object.",
    );
  } finally {
    await bw.close();
  }
});

test("public search UIs route agents to the host search tool", opts, async () => {
  // Public search is allowed by default now, so opt into the block routing.
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    publicSearchPolicy: "block",
  });
  try {
    const direct = await bw.run(
      "await page.goto('https://www.google.com/search?q=betterwright'); return 'loaded'",
    );
    assert.equal(direct.ok, false);
    assert.match(direct.error, /host web-search\/research tool/i);

    const clicked = await bw.run(`
      await page.setContent(
        '<a id="search" href="https://www.bing.com/search?q=betterwright">Search</a>'
      );
      await page.locator('#search').click();
      return page.url();
    `);
    assert.equal(clicked.ok, false);
    assert.ok(
      clicked.events?.some((event) => event.type === "public-search-blocked"),
      JSON.stringify(clicked.events),
    );

    for (const url of [
      "https://www.bing.com/images/search?q=betterwright",
      "https://www.bing.com/videos/search?q=betterwright",
      "https://www.bing.com/news/search?q=betterwright",
      "https://lite.duckduckgo.com/lite/?q=betterwright",
    ]) {
      const variant = await bw.run(
        `await page.goto(${JSON.stringify(url)}); return 'loaded'`,
      );
      assert.equal(variant.ok, false, url);
      assert.match(variant.error, /host web-search\/research tool/i, url);
    }
  } finally {
    await bw.close();
  }
});

test("metadata endpoint is blocked", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run("await page.goto('http://169.254.169.254/'); return 'reached'");
    assert.equal(result.ok, false);
  } finally {
    await bw.close();
  }
});

test("IPv4-mapped IPv6 cannot reach an IPv4 loopback service", opts, async () => {
  let hits = 0;
  const server = await listen((_request, response) => {
    hits += 1;
    response.end("loopback reached");
  });
  // Loopback is open by default; this guards the mapped-IPv6 spelling against
  // bypassing a policy that explicitly blocks it.
  const bw = new BetterWright({
    home: tempHome(),
    policy: new NetworkPolicy({ allowLoopback: false, allowPrivateNetwork: false }),
    headless: true,
  });
  try {
    const result = await bw.run(
      `await page.goto('http://[::ffff:127.0.0.1]:${server.port}/'); return 'reached'`,
    );
    assert.equal(result.ok, false);
    assert.equal(hits, 0);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("setInputFiles only reads files from the artifact root", opts, async () => {
  const home = tempHome();
  const outside = path.join(home, "host-secret.txt");
  const outsideScript = path.join(home, "host-secret.js");
  const allowed = path.join(home, "artifacts", "upload.txt");
  const linkedOutside = path.join(home, "artifacts", "linked-secret.txt");
  fs.mkdirSync(path.dirname(allowed), { recursive: true });
  fs.writeFileSync(outside, "host-secret-value");
  fs.writeFileSync(outsideScript, "globalThis.hostSecret = 'read';");
  fs.writeFileSync(allowed, "allowed-artifact-value");
  if (process.platform !== "win32") fs.symlinkSync(outside, linkedOutside);
  const bw = new BetterWright({ home, headless: true });
  try {
    const denied = await bw.run(`
      await page.setContent('<input type="file">');
      await page.locator('input').setInputFiles(${JSON.stringify(outside)});
      return page.locator('input').evaluate(element => element.files[0].text());
    `);
    assert.equal(denied.ok, false);
    assert.match(denied.error || "", /artifact directory/i);

    const accepted = await bw.run(`
      await page.setContent('<input type="file">');
      await page.locator('input').setInputFiles(${JSON.stringify(allowed)});
      return page.locator('input').evaluate(element => element.files[0].text());
    `);
    assert.equal(accepted.ok, true, accepted.error);
    assert.equal(accepted.result, "allowed-artifact-value");

    const chooserDenied = await bw.run(`
      await page.setContent('<input type="file">');
      const chooserPromise = page.waitForEvent('filechooser');
      await page.locator('input').click();
      const chooser = await chooserPromise;
      await chooser.setFiles(${JSON.stringify(outside)});
      return 'read';
    `);
    assert.equal(chooserDenied.ok, false);
    assert.match(chooserDenied.error || "", /artifact directory/i);

    const initScriptDenied = await bw.run(`
      await page.addInitScript({path: ${JSON.stringify(outsideScript)}});
      return 'read';
    `);
    assert.equal(initScriptDenied.ok, false);
    assert.match(initScriptDenied.error || "", /artifact directory/i);

    if (process.platform !== "win32") {
      const symlinkDenied = await bw.run(`
        await page.setContent('<input type="file">');
        await page.locator('input').setInputFiles(${JSON.stringify(linkedOutside)});
        return 'read';
      `);
      assert.equal(symlinkDenied.ok, false);
      assert.match(symlinkDenied.error || "", /artifact directory/i);
    }
  } finally {
    await bw.close();
  }
});

test("model-authored credentials.fill types the secret without returning it", opts, async () => {
  const secret = "vault-secret-value";
  const server = await listen((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<input id="u"><input id="p" type="password">');
  });
  const vault = {
    async handleRequest(action, _payload, origin) {
      assert.equal(action, "fill");
      return { secret, origin, username: "alice", id: "rec-1" };
    },
  };
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
    vault,
  });
  try {
    // Fill directly from run(), origin-scoped, and get metadata back — never
    // the secret.
    const result = await bw.run(`
      await page.goto(${JSON.stringify(server.origin)});
      const outcome = await credentials.fill({
        username: 'alice',
        usernameSelector: '#u',
        passwordSelector: '#p',
      });
      const typed = await page.locator('#p').evaluate(element => element.value.length);
      return { outcome, typed };
    `);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result.outcome.filled, ["username", "password"]);
    assert.equal(result.result.outcome.submitted, false);
    assert.equal(result.result.outcome.username, "alice");
    assert.equal(result.result.outcome.secret, undefined);
    // The field really was typed with the full secret.
    assert.equal(result.result.typed, secret.length);
    // The secret never appears anywhere in the envelope in plain text — the
    // redaction net scrubs even a snippet that reads the DOM value back.
    assert.ok(!JSON.stringify(result).includes(secret));

    const readBack = await bw.run(
      "return page.locator('#p').evaluate(element => element.value);",
    );
    assert.equal(readBack.ok, true);
    assert.ok(!JSON.stringify(readBack).includes(secret), "plain read-back is redacted");
  } finally {
    await bw.close();
    await server.close();
  }
});

test("browser capture saves an accepted model login through the managed browser", opts, async () => {
  const secret = "captured-model-secret";
  const calls = [];
  const loginPage = `<!doctype html><html><body>
    <form method="post" action="/login">
      <label>Email <input id="email" name="email" type="email" autocomplete="username"></label>
      <label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
      <button type="submit">Sign in</button>
    </form>
  </body></html>`;
  const server = await listen((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/login") {
      response.end(loginPage);
      return;
    }
    if (request.method === "POST" && url.pathname === "/login") {
      request.resume();
      response.statusCode = 302;
      response.setHeader("location", "/home");
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/home") {
      response.end("<main><h1>Signed in</h1></main>");
      return;
    }
    response.statusCode = 404;
    response.end("<main>Not found</main>");
  });
  const vault = {
    async handleRequest(action, payload, origin) {
      calls.push({ action, payload, origin });
      return { id: "captured-1", origin, username: payload.username };
    },
  };
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
    vault,
  });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(`${server.origin}/login`)});
      await page.fill('#email', 'captured@example.test');
      await page.fill('#password', ${JSON.stringify(secret)});
      await page.getByRole('button', {name: 'Sign in'}).click();
      await page.waitForURL('**/home');
      return page.getByRole('heading').textContent();
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, "Signed in");

    const deadline = Date.now() + 4_000;
    while (!calls.some((call) => call.action === "save") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const save = calls.find((call) => call.action === "save");
    assert.ok(save, "accepted login should reach the vault save path");
    assert.equal(save.origin, server.origin);
    assert.deepEqual(save.payload, {
      username: "captured@example.test",
      password: secret,
      label: "127.0.0.1",
      matchMode: "base-domain",
      deferToPending: true,
    });
    assert.ok(!JSON.stringify(result).includes(secret));

    const synthetic = await bw.run(`
      await page.goto(${JSON.stringify(`${server.origin}/login`)});
      await page.fill('#email', 'forged@example.test');
      await page.fill('#password', 'page-script-secret');
      await Promise.all([
        page.waitForURL('**/home'),
        page.evaluate(() => document.querySelector('button').click()),
      ]);
      return page.getByRole('heading').textContent();
    `);
    assert.equal(synthetic.ok, true, synthetic.error);
    assert.equal(synthetic.result, "Signed in");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(
      calls.filter((call) => call.action === "save").length,
      1,
      "page-script submission must not create a captured credential",
    );
  } finally {
    await bw.close();
    await server.close();
  }
});

test("built-in password manager signs up, persists, and logs in through the agent", opts, async () => {
  const home = tempHome();
  const account = { username: "agent@example.test", password: "" };
  const submissions = [];
  const server = await listen((request, response) => {
    const host = request.headers.host || "";
    const url = new URL(request.url || "/", `http://${host}`);
    const html = (body) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><body>${body}</body></html>`);
    };
    if (request.method === "GET" && url.pathname === "/signup") {
      html(`<form method="post" action="/signup">
        <label>Email <input name="email" type="email" autocomplete="username" required></label>
        <label>New password <input name="password" type="password" autocomplete="new-password" required></label>
        <label>Confirm password <input name="confirm" type="password" autocomplete="new-password" required></label>
        <button type="submit">Create account</button>
      </form>`);
      return;
    }
    if (request.method === "GET" && url.pathname === "/login") {
      html(`<form method="post" action="/login">
        <label>Email <input name="email" type="email" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">Sign in</button>
      </form>`);
      return;
    }
    if (request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        submissions.push({ host, path: url.pathname, form: Object.fromEntries(form) });
        if (url.pathname === "/signup") {
          account.username = form.get("email") || "";
          account.password = form.get("password") || "";
          const matches = account.password === form.get("confirm");
          response.statusCode = matches ? 200 : 400;
          html(matches ? '<main><h1>Account created</h1></main>' : "<main>Passwords differ</main>");
          return;
        }
        const authenticated =
          form.get("email") === account.username && form.get("password") === account.password;
        response.statusCode = authenticated ? 200 : 401;
        html(authenticated ? '<main><h1>Signed in</h1></main>' : "<main>Invalid login</main>");
      });
      return;
    }
    response.statusCode = 404;
    html("<main>Not found</main>");
  });

  const signupUrl = `http://signup.acme.localhost:${server.port}/signup`;
  const loginUrl = `http://login.acme.localhost:${server.port}/login`;
  try {
    const signupBrowser = new BetterWright({ home, headless: true });
    try {
      const signupModel = scriptedAgentModel([
        {
          toolCalls: [
            {
              id: "open-signup",
              name: "browser",
              input: {
                note: "Opening the signup form",
                code: `await page.goto(${JSON.stringify(signupUrl)}); return snapshot({interactive: true})`,
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "generate-password",
              name: "login",
              input: { generate: true, username: account.username, submit: true },
            },
          ],
        },
        (request) => {
          const pendingId = JSON.stringify(request.messages).match(
            /pending_[0-9a-f-]+/i,
          )?.[0];
          assert.ok(
            pendingId,
            "generated credential observation should include a pending id",
          );
          return {
            toolCalls: [
              {
                id: "verify-signup",
                name: "browser",
                input: {
                  note: "Verifying the new account",
                  code:
                    "const heading = await page.getByRole('heading').textContent(); " +
                    `if (heading === 'Account created') await credentials.commitGenerated({pendingId: ${JSON.stringify(pendingId)}}); ` +
                    "return {finalAnswer: heading === 'Account created' ? 'Account created' : ''}",
                },
              },
            ],
          };
        },
      ]);
      const signup = await runAgentTask({
        task: "Create an account using a generated password.",
        model: signupModel,
        browser: signupBrowser,
      });
      assert.equal(signup.ok, true, signup.answer);
      assert.equal(signup.answer, "Account created");
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0].path, "/signup");
      assert.equal(submissions[0].form.email, account.username);
      assert.equal(submissions[0].form.password, submissions[0].form.confirm);
      assert.ok(account.password.length >= 16);
      assert.ok(!JSON.stringify(signup.transcript).includes(account.password));
      assert.ok(signupModel.seen[0].tools.some((tool) => tool.name === "login"));
    } finally {
      await signupBrowser.close();
    }

    const loginBrowser = new BetterWright({ home, headless: true });
    try {
      const loginModel = scriptedAgentModel([
        {
          toolCalls: [
            {
              id: "open-login",
              name: "browser",
              input: {
                note: "Opening the login form",
                code: `await page.goto(${JSON.stringify(loginUrl)}); return snapshot({interactive: true})`,
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "fill-login",
              name: "login",
              input: { username: account.username, submit: true },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "verify-login",
              name: "browser",
              input: {
                note: "Verifying the signed-in state",
                code:
                  "const heading = await page.getByRole('heading').textContent(); " +
                  "return {finalAnswer: heading === 'Signed in' ? 'Signed in' : ''}",
              },
            },
          ],
        },
      ]);
      const login = await runAgentTask({
        task: "Sign in with the saved account.",
        model: loginModel,
        browser: loginBrowser,
      });
      assert.equal(login.ok, true, login.answer);
      assert.equal(login.answer, "Signed in");
      assert.equal(submissions.length, 2);
      assert.equal(submissions[1].path, "/login");
      assert.equal(submissions[1].form.email, account.username);
      assert.equal(submissions[1].form.password, account.password);
      assert.ok(!JSON.stringify(login.transcript).includes(account.password));
    } finally {
      await loginBrowser.close();
    }
  } finally {
    await server.close();
  }
});

test("credentials.save/list carry category and filter, and never leak field secrets", opts, async () => {
  const apiKey = "sk-live-supersecret-01";
  const calls = [];
  const vault = {
    async handleRequest(action, payload, origin) {
      calls.push({ action, payload });
      if (action === "save") return { id: "rec-1", origin, category: payload.category };
      if (action === "list")
        // A well-behaved backend returns metadata only; the redaction net is a
        // second defense the test also exercises below.
        return { credentials: [{ id: "rec-1", category: "api-credential", label: "CI token" }] };
      return {};
    },
  };
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
    vault,
  });
  const server = await listen((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<main>ok</main>");
  });
  try {
    const result = await bw.run(
      `
      await page.goto(${JSON.stringify(server.origin)});
      const saved = await credentials.save({
        category: 'api-credential',
        label: 'CI token',
        fields: { secret: ${JSON.stringify(apiKey)} },
      });
      const listed = await credentials.list({ text: 'CI', category: 'api-credential' });
      // Try to smuggle the secret back out through ordinary console output.
      console.log('leak-probe ' + ${JSON.stringify(apiKey)});
      return { saved, listed };
    `,
    );
    assert.equal(result.ok, true, result.error);
    // Category flows through save and list unchanged.
    assert.equal(calls.find((c) => c.action === "save").payload.category, "api-credential");
    assert.deepEqual(calls.find((c) => c.action === "list").payload, {
      text: "CI",
      category: "api-credential",
    });
    assert.equal(result.result.saved.category, "api-credential");
    assert.equal(result.result.listed[0].label, "CI token");
    // The field secret was tracked, so it is scrubbed from console output.
    const consoleText = JSON.stringify(result.console || []);
    assert.doesNotMatch(consoleText, /supersecret/);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("snapshot redacts filled password values but keeps other fields", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <form>
          <input id="u" placeholder="Username">
          <input id="p" type="password" placeholder="Password">
          <button>Sign in</button>
        </form>
      \`);
      await page.fill('#u', 'alice');
      await page.fill('#p', 'hunter2-super-secret');
      const snap = await snapshot({ interactive: true });
      return {
        leaks: snap.includes('hunter2-super-secret'),
        redacted: snap.includes('[redacted]'),
        keepsUsername: snap.includes('alice'),
      };
    `);
    assert.equal(result.ok, true, result.error);
    // The password value must never reach the model-facing snapshot text.
    assert.equal(result.result.leaks, false);
    assert.equal(result.result.redacted, true);
    // Non-secret fields still read normally.
    assert.equal(result.result.keepsUsername, true);
  } finally {
    await bw.close();
  }
});

test("overlays dismisses cookie and promotional popups but preserves task dialogs", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <div role="dialog" id="cookie"><p>We value your privacy and use cookies.</p><button onclick="this.parentElement.remove()">Reject all</button></div>
        <div role="dialog" id="promo"><p>Subscribe to our newsletter for a discount.</p><button aria-label="Close" onclick="this.parentElement.remove()">×</button></div>
        <div role="dialog" id="checkout"><p>Confirm purchase</p><button aria-label="Close">×</button></div>
      \`);
      const dismissed = await overlays.dismiss();
      return {
        dismissed,
        cookie: await page.locator('#cookie').count(),
        promo: await page.locator('#promo').count(),
        checkoutVisible: await page.locator('#checkout').isVisible(),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(
      result.result.dismissed.dismissed.map((item) => item.kind),
      ["cookie", "promotion"],
    );
    assert.equal(result.result.cookie, 0);
    assert.equal(result.result.promo, 0);
    assert.equal(result.result.checkoutVisible, true);
  } finally {
    await bw.close();
  }
});

test("controls and media inspectors expose exact live state", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <label>Radius <select><option>10 miles</option><option selected>25 miles</option></select></label>
        <label>Maximum price <input type="number" min="0" max="25000" step="1" value="24999"></label>
        <input type="password" aria-label="Password" value="never-return-this">
        <h1>Game recap: Knicks vs Spurs</h1>
        <video aria-label="Game recap: Knicks vs Spurs" src="recap.mp4"></video>
      \`);
      return { controls: await controls.inspect(), media: await media.inspect() };
    `);
    assert.equal(result.ok, true, result.error);
    const controls = result.result.controls.frames[0].controls;
    const radius = controls.find((control) => control.label === "Radius");
    assert.equal(radius.options.find((option) => option.selected).text, "25 miles");
    assert.equal(controls.find((control) => control.label === "Maximum price").value, "24999");
    assert.equal(controls.find((control) => control.label === "Password").value, "[redacted]");
    const media = result.result.media.frames[0].media[0];
    assert.equal(media.title, "Game recap: Knicks vs Spurs");
    assert.equal(media.paused, true);
    assert.deepEqual(media.headings, ["Game recap: Knicks vs Spurs"]);
  } finally {
    await bw.close();
  }
});

test("controls.batch runs a guarded semantic UI transaction and waits for verification", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <form id="signup">
          <label>Display name <input name="name"></label>
          <label>Plan <select name="plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
          <label><input name="terms" type="checkbox"> Accept terms</label>
          <button>Create account</button>
        </form>
        <div role="status" hidden></div>
        <script>
          document.querySelector('#signup').addEventListener('submit', (event) => {
            event.preventDefault();
            setTimeout(() => {
              const status = document.querySelector('[role=status]');
              status.hidden = false;
              status.textContent = 'Created ' + event.target.elements.name.value + ' on ' + event.target.elements.plan.value;
            }, 75);
          });
        </script>
      \`);
      return controls.batch({
        operations: [
          {id:'name', action:'fill', target:{label:'Display name', exact:true}, value:'Ada'},
          {id:'plan', action:'select', target:{label:'Plan'}, value:'pro'},
          {id:'terms', action:'check', target:{label:'Accept terms', exact:true}},
          {id:'submit', action:'click', target:{role:'button', name:'Create account', exact:true}},
          {id:'verify', action:'read', target:{role:'status'}, value:'Created Ada on pro'},
        ],
        allowWrites: true,
        minIntervalMs: 0,
      });
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.protocol, "ui-batch/1");
    assert.equal(result.result.pageUpdated, true);
    assert.equal(result.result.results.verify.text, "Created Ada on pro");
    assert.equal(result.result.results.terms.checked, true);

    const expected = await bw.run(`
      await page.setContent('<button id="run">Run</button><div id="status">Waiting</div><script>document.querySelector("#run").onclick=()=>setTimeout(()=>document.querySelector("#status").textContent="Finished",75)</script>');
      return controls.batch({
        operations: [
          {id:'run', action:'click', target:{role:'button', name:'Run', exact:true}},
          {id:'status', action:'read', target:{css:'#status'}, value:'Finished'},
        ],
        allowWrites:true,
        minIntervalMs:0,
      });
    `);
    assert.equal(expected.ok, true, expected.error);
    assert.equal(expected.result.results.status.text, "Finished");
    assert.ok(expected.result.durationMs >= 60);

    const missingExpectation = await bw.run(`
      return controls.batch({
        operations: [
          {id:'run', action:'click', target:{role:'button', name:'Run', exact:true}},
          {id:'status', action:'read', target:{css:'#status'}},
        ],
        allowWrites:true,
      });
    `);
    assert.equal(missingExpectation.ok, false);
    assert.match(missingExpectation.error, /non-empty expected value/);

    const targetOnlyVerification = await bw.run(`
      await page.setContent('<button id="run">Resolve</button><article id="ticket">T-1</article><section id="summary">Status resolved</section><script>document.querySelector("#run").onclick=()=>setTimeout(()=>{document.querySelector("#ticket").textContent="Ticket resolved"},300)</script>');
      return controls.batch({
        operations: [
          {id:'run', action:'click', target:{role:'button', name:'Resolve', exact:true}},
          {id:'status', action:'read', target:{css:'#ticket'}, value:'resolved'},
        ],
        allowWrites:true,
        minIntervalMs:0,
      });
    `);
    assert.equal(targetOnlyVerification.ok, true, targetOnlyVerification.error);
    assert.equal(targetOnlyVerification.result.results.status.text, "Ticket resolved");
    assert.ok(targetOnlyVerification.result.durationMs >= 250);

    const directory = await bw.run(`
      await page.setContent('<label>Query <input value="browser automation"></label><select><option selected>Current plan</option></select><button>Search</button><article><h2>T-1</h2><button>Assign</button></article><article><h2>T-2</h2><button>Assign</button></article>');
      return controls.directory();
    `);
    assert.equal(directory.ok, true, directory.error);
    assert.equal(directory.result.protocol, "betterwright-ui/1");
    assert.equal(directory.result.tool, "browser_batch");
    assert.deepEqual(directory.result.controls[0].target, { label: "Query", exact: true });
    assert.equal(directory.result.controls[0].value, "browser automation");
    assert.deepEqual(directory.result.controls[1].target, { role: "combobox", exact: true });
    assert.equal(directory.result.controls[1].value, "Current plan");
    const assigns = directory.result.controls.filter((control) => control.target.name === "Assign");
    assert.equal(assigns.length, 2);
    assert.equal(assigns[0].target.nth, 0);
    assert.equal(assigns[0].context, "T-1");
    assert.equal(assigns[1].target.nth, 1);
    assert.equal(assigns[1].context, "T-2");

    const framed = await bw.run(`
      await page.setContent('<iframe name="billing" srcdoc="<label>Region <select><option>US</option><option selected>EU</option></select></label>"></iframe>');
      await page.locator('iframe').contentFrame().getByLabel('Region').waitFor();
      return controls.batch([
        {id:'region', action:'read', target:{frameName:'billing', label:'Region'}},
      ]);
    `);
    assert.equal(framed.ok, true, framed.error);
    assert.equal(framed.result.results.region.value, "EU");

    const gated = await bw.run(`
      return controls.batch([
        {id:'submit', action:'click', target:{role:'button', name:'Create account', exact:true}},
        {id:'verify', action:'read', target:{role:'status'}},
      ]);
    `);
    assert.equal(gated.ok, false);
    assert.match(gated.error, /allowWrites:true/);

    const password = await bw.run(`
      await page.setContent('<label>Password <input type="password"></label><div role="status">Ready</div>');
      return controls.batch({
        operations: [
          {id:'secret', action:'fill', target:{label:'Password'}, value:'must-not-leak'},
          {id:'verify', action:'read', target:{role:'status'}, value:'Ready'},
        ],
        allowWrites: true,
      });
    `);
    assert.equal(password.ok, false);
    assert.match(password.error, /cannot fill a password/);
    assert.ok(!JSON.stringify(password).includes("must-not-leak"));

    const suppliedPassword = await bw.run(`
      return controls.batch({
        operations: [
          {id:'secret', action:'fill', target:{label:'Password'}, value:'task-supplied'},
          {id:'verify', action:'read', target:{role:'status'}, value:'Ready'},
        ],
        allowWrites: true,
        allowPasswordFill: true,
      });
    `);
    assert.equal(suppliedPassword.ok, true, suppliedPassword.error);
    assert.equal(suppliedPassword.result.results.secret.filled, 13);
    assert.ok(!JSON.stringify(suppliedPassword).includes("task-supplied"));

    const ambiguous = await bw.run(`
      await page.setContent('<button>Save</button><button>Save</button>');
      return controls.batch({
        operations: [
          {id:'save', action:'click', target:{role:'button', name:'Save', exact:true}},
          {id:'url', action:'readUrl', value:'about:blank'},
        ],
        allowWrites: true,
      });
    `);
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.error, /matched 2 elements/);
  } finally {
    await bw.close();
  }
});

test("ordinary navigation attaches one compact UI directory automatically", opts, async () => {
  let probes = 0;
  const site = await listen((request, response) => {
    if (request.url === "/webagents.md" || request.url === "/.well-known/webagents.json") {
      probes += 1;
      response.statusCode = 404;
      response.end("missing");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end('<label>Search <input value="compact"></label><button>Go</button>');
  });
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const opened = await bw.run(`await page.goto('${site.origin}/form'); return page.url()`);
    assert.equal(opened.ok, true, opened.error);
    assert.equal(opened.ui.protocol, "betterwright-ui/1");
    assert.deepEqual(opened.ui.controls[0].target, { label: "Search", exact: true });
    assert.equal(probes, 2);

    const repeated = await bw.run("return page.title()");
    assert.equal(repeated.ok, true, repeated.error);
    assert.equal(repeated.ui, undefined);
    assert.equal(probes, 2);

    const nextPath = await bw.run(`await page.goto('${site.origin}/other'); return page.url()`);
    assert.equal(nextPath.ok, true, nextPath.error);
    assert.equal(nextPath.ui.protocol, "betterwright-ui/1");
    assert.equal(probes, 2);
  } finally {
    await bw.close();
    await site.close();
  }
});

test("WebAgents auto-discovery executes one same-origin operation DAG", opts, async () => {
  let status = "open";
  let workflowBody: any;
  const site = await listen((request, response) => {
    if (request.url === "/webagents.md") {
      response.setHeader("content-type", "text/markdown");
      response.end(`\`\`\`webagents
{"version":"0.1","workflow":{"endpoint":"/workflow"},"actions":{"resolve":{"effect":"write"},"status":{"effect":"read"}}}
\`\`\``);
      return;
    }
    if (request.url === "/.well-known/webagents.json") {
      response.statusCode = 404;
      response.end("missing");
      return;
    }
    if (request.url === "/workflow" && request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        workflowBody = JSON.parse(body);
        status = "resolved";
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status }));
      });
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<main><div role="status">${status}</div></main>`);
  });
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const opened = await bw.run(`await page.goto('${site.origin}/tickets'); return page.url()`);
    assert.equal(opened.ok, true, opened.error);
    assert.equal(opened.webagents.protocol, "webagents/0.1");
    assert.deepEqual(opened.webagents.actions.map((action) => action.name), ["resolve", "status"]);

    const batch = await bw.run(`
      return webagents.batch([
        {id:'resolve', action:'resolve', input:{}},
        {id:'verify', action:'status', input:{}},
      ], {allowWrites:true});
    `);
    assert.equal(batch.ok, true, batch.error);
    assert.equal(batch.result.pageUpdated, true);
    assert.equal(batch.result.result.status, "resolved");
    assert.deepEqual(workflowBody.operations, [
      { id: "resolve", action: "resolve", input: {} },
      { id: "verify", action: "status", input: {}, dependsOn: ["resolve"] },
    ]);
  } finally {
    await bw.close();
    await site.close();
  }
});

test("WebAgents path scopes are rediscovered after navigation", opts, async () => {
  let probes = 0;
  const site = await listen((request, response) => {
    if (request.url === "/webagents.md") {
      probes += 1;
      response.setHeader("content-type", "text/markdown");
      response.end(`\`\`\`webagents
{"version":"0.1","workflow":{"endpoint":"/workflow"},"actions":{"store":{"effect":"read","pathPrefixes":["/store"]}}}
\`\`\``);
      return;
    }
    if (request.url === "/.well-known/webagents.json") {
      probes += 1;
      response.statusCode = 404;
      response.end("missing");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end("<main>Scoped workflow</main>");
  });
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const landing = await bw.run(`await page.goto('${site.origin}/'); return page.url()`);
    assert.equal(landing.ok, true, landing.error);
    assert.equal(landing.webagents, undefined);
    assert.equal(probes, 2);

    const store = await bw.run(`await page.goto('${site.origin}/store'); return page.url()`);
    assert.equal(store.ok, true, store.error);
    assert.deepEqual(store.webagents.actions.map((action) => action.name), ["store"]);
    assert.equal(probes, 4);
  } finally {
    await bw.close();
    await site.close();
  }
});

test("guard decisions are not reused across request methods", opts, async () => {
  let deleteRequests = 0;
  const server = await listen((request, response) => {
    if (request.method === "DELETE") deleteRequests += 1;
    response.setHeader("content-type", request.url === "/" ? "text/html" : "text/plain");
    response.end(request.url === "/" ? "<h1>cache test</h1>" : "ok");
  });
  const policy = new NetworkPolicy({
    allowLoopback: true,
    custom: (_url, details) =>
      details.method === "DELETE" ? { allowed: false, reason: "DELETE denied" } : null,
  });
  const bw = new BetterWright({ home: tempHome(), headless: true, policy });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(server.origin)});
      return page.evaluate(async () => {
        await fetch('/api');
        try {
          await fetch('/api', {method: 'DELETE'});
          return 'allowed';
        } catch {
          return 'blocked';
        }
      });
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, "blocked");
    assert.equal(deleteRequests, 0);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("screenshots are rejected before an oversized file is written", opts, async () => {
  const home = tempHome();
  const bw = new LimitedBetterWright(
    { home, headless: true },
    { maxScreenshotBytes: 512 },
  );
  try {
    const result = await bw.run(`
      await page.setContent('<main style="width:1000px;height:1000px;background:red"></main>');
      return screenshot({kind: 'proof', name: 'oversized.png'});
    `);
    assert.equal(result.ok, false);
    assert.match(result.error || "", /screenshot.*limit/i);
    assert.equal(directorySize(path.join(home, "artifacts")), 0);
  } finally {
    await bw.close();
  }
});

test("downloads are canceled while crossing the byte limit", opts, async () => {
  const chunk = Buffer.alloc(4096, 0x61);
  const chunkCount = 64;
  const server = await listen((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end(`
        <a id="download-1" href="/large-1.bin" download>Download one</a>
        <a id="download-2" href="/large-2.bin" download>Download two</a>
      `);
      return;
    }
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("content-disposition", 'attachment; filename="large.bin"');
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= chunkCount || response.destroyed) {
        clearInterval(timer);
        if (!response.destroyed) response.end();
        return;
      }
      response.write(chunk);
      sent += 1;
    }, 50);
    response.on("close", () => clearInterval(timer));
  });
  const home = tempHome();
  const maxDownloadBytes = 32 * 1024;
  // Chromium batches Browser.downloadProgress notifications. Permit one 64 KiB
  // notification window beyond the configured ceiling, but still prove that
  // cancellation stops this 256 KiB response well before completion.
  const progressAllowance = 64 * 1024;
  const bw = new LimitedBetterWright(
    {
      home,
      headless: true,
      downloadPolicy: "allow",
      policy: new NetworkPolicy({ allowLoopback: true }),
    },
    { maxArtifactBytes: maxDownloadBytes, maxDownloadBytes },
  );
  let maxObservedFile = 0;
  const observer = setInterval(() => {
    // The limit is per download. Summing both concurrent Chromium temp files
    // compares an aggregate to a per-file ceiling and flakes on platforms
    // where their progress overlaps for longer.
    maxObservedFile = Math.max(
      maxObservedFile,
      largestFileSize(path.join(home, "artifacts")),
    );
  }, 10);
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(server.origin)});
      await page.locator('#download-1').click();
      await page.waitForTimeout(100);
      await page.locator('#download-2').click();
      await page.waitForTimeout(1500);
      return 'done';
    `);
    assert.equal(result.ok, true, result.error);
    assert.ok(
      maxObservedFile <= maxDownloadBytes + progressAllowance,
      `download grew to ${maxObservedFile} bytes before cancellation`,
    );
    const rejected = (result.events || []).filter(
      event => event.type === "download-rejected",
    );
    assert.equal(rejected.length, 2, JSON.stringify(result.events));
  } finally {
    clearInterval(observer);
    await bw.close();
    await server.close();
  }
});

test("downloads require a trusted per-run approval by default", opts, async () => {
  const body = Buffer.from("approved download contents");
  const server = await listen((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<a id="download" href="/report.txt" download>Download</a>');
      return;
    }
    response.setHeader("content-type", "text/plain");
    response.setHeader(
      "content-disposition",
      'attachment; filename="report.txt"',
    );
    response.end(body);
  });
  const home = tempHome();
  const bw = new BetterWright({
    home,
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  const code = `
    await page.goto(${JSON.stringify(server.origin)});
    await page.locator('#download').click();
    await page.waitForTimeout(100);
    return 'done';
  `;
  try {
    const blocked = await bw.run(code);
    assert.equal(blocked.ok, true, blocked.error);
    assert.equal(
      directorySize(path.join(home, "artifacts", "downloads")),
      0,
    );
    assert.equal(
      (blocked.artifacts || []).filter((item) => item.kind === "download").length,
      0,
    );

    const approved = await bw.run(code, { approvedDownloads: true });
    assert.equal(approved.ok, true, approved.error);
    const downloads = (approved.artifacts || []).filter(
      (item) => item.kind === "download",
    );
    assert.equal(downloads.length, 1, JSON.stringify(approved.events));
    assert.deepEqual(fs.readFileSync(downloads[0].path), body);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("MCP browser tool collects page console through page.on", opts, async () => {
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  const handlers = _createMcpHandlersForTest({
    browser: bw,
    downloadPolicy: "deny",
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });
  try {
    const missing = await handlers.callTool({
      params: {
        name: "browser",
        arguments: {
          code: `
            const messages = [];
            page.on("console", (message) => messages.push(message.text()));
            return messages;
          `,
        },
      },
    });
    assert.equal(missing.isError, undefined, missing.content[0].text);
    const missingSummary = JSON.parse(missing.content[0].text);
    assert.equal(missingSummary.ok, true, missingSummary.error);
    assert.deepEqual(missingSummary.result, []);

    const collected = await handlers.callTool({
      params: {
        name: "browser",
        arguments: {
          code: `
            const messages = [];
            page.on("console", (message) => messages.push(message.text()));
            await page.evaluate(() => console.log("mcp-console"));
            return messages;
          `,
        },
      },
    });
    assert.equal(collected.isError, undefined, collected.content[0].text);
    const collectedSummary = JSON.parse(collected.content[0].text);
    assert.equal(collectedSummary.ok, true, collectedSummary.error);
    assert.deepEqual(collectedSummary.result, ["mcp-console"]);
  } finally {
    await bw.close();
  }
});

test("MCP browser_download saves one real file without elicitation", opts, async () => {
  const body = Buffer.from("MCP autonomous download contents");
  const server = await listen((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<a id="download" href="/report.txt" download>Download</a>');
      return;
    }
    response.setHeader("content-type", "text/plain");
    response.setHeader(
      "content-disposition",
      'attachment; filename="report.txt"',
    );
    response.end(body);
  });
  const home = tempHome();
  const bw = new BetterWright({
    home,
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  const handlers = _createMcpHandlersForTest({
    browser: bw,
    downloadPolicy: "ask",
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });
  const code = `
    await page.goto(${JSON.stringify(server.origin)});
    await page.locator('#download').click();
    await page.waitForTimeout(100);
    return 'done';
  `;
  try {
    const ordinary = await handlers.callTool({
      params: { name: "browser", arguments: { code } },
    });
    assert.equal(ordinary.isError, undefined, ordinary.content[0].text);
    const ordinarySummary = JSON.parse(ordinary.content[0].text);
    assert.equal(ordinarySummary.ok, true, ordinarySummary.error);
    assert.equal(ordinarySummary.files, undefined);
    assert.equal(directorySize(path.join(home, "artifacts", "downloads")), 0);

    const download = await handlers.callTool({
      params: { name: "browser_download", arguments: { code } },
    });
    assert.equal(download.isError, undefined, download.content[0].text);
    const downloadSummary = JSON.parse(download.content[0].text);
    assert.equal(downloadSummary.ok, true, downloadSummary.error);
    const file = downloadSummary.files?.find((item) => item.kind === "download");
    assert.ok(file?.path, JSON.stringify(downloadSummary));
    assert.deepEqual(fs.readFileSync(file.path), body);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("download approval cannot be borrowed by a different browser session", opts, async () => {
  const body = Buffer.from("cross-session download must stay blocked");
  let downloadRequests = 0;
  const server = await listen((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<a id="download" href="/report.txt" download>Download</a>');
      return;
    }
    downloadRequests += 1;
    response.setHeader("content-type", "text/plain");
    response.setHeader(
      "content-disposition",
      'attachment; filename="report.txt"',
    );
    response.end(body);
  });
  const home = tempHome();
  const bw = new BetterWright({
    home,
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const armed = await bw.run(
      `
        await page.goto(${JSON.stringify(server.origin)});
        await page.evaluate(() => {
          setTimeout(() => {
            window.downloadAttempted = true;
            document.querySelector('#download').click();
          }, 750);
        });
        return 'armed';
      `,
      { session: "attacker" },
    );
    assert.equal(armed.ok, true, armed.error);

    const approvedVictim = await bw.run(
      "await page.waitForTimeout(1800); return 'victim complete'",
      { session: "victim", approvedDownloads: true },
    );
    assert.equal(approvedVictim.ok, true, approvedVictim.error);
    assert.equal(
      (approvedVictim.artifacts || []).some((item) => item.kind === "download"),
      false,
    );

    const attempted = await bw.run(
      "return page.evaluate(() => window.downloadAttempted === true)",
      { session: "attacker" },
    );
    assert.equal(attempted.result, true, attempted.error);
    // A canceled Chromium download may retry the transfer. Request count is
    // not the security boundary; the unapproved session must retain no bytes.
    assert.ok(downloadRequests >= 1);
    assert.equal(directorySize(path.join(home, "artifacts")), 0);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("an approved run's open download gate does not leak into a concurrent session", opts, async () => {
  const body = Buffer.from("a concurrent session must not ride the open gate");
  let downloadRequests = 0;
  const server = await listen((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<a id="download" href="/report.txt" download>Download</a>');
      return;
    }
    downloadRequests += 1;
    response.setHeader("content-type", "text/plain");
    response.setHeader("content-disposition", 'attachment; filename="report.txt"');
    response.end(body);
  });
  const home = tempHome();
  const bw = new BetterWright({
    home,
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    // Sessions run concurrently now, so the browser-wide download permission
    // is open for the whole of the approved run while the unapproved one is
    // clicking. Only the session that was granted approval may keep a file.
    const [approved, sneaky] = await Promise.all([
      bw.run(
        `await page.goto(${JSON.stringify(server.origin)});
         await page.locator('#download').click();
         await page.waitForTimeout(1200);
         return 'approved done';`,
        { session: "approved", approvedDownloads: true },
      ),
      bw.run(
        `await page.waitForTimeout(300);
         await page.goto(${JSON.stringify(server.origin)});
         await page.locator('#download').click();
         await page.waitForTimeout(500);
         return 'sneaky done';`,
        { session: "sneaky" },
      ),
    ]);
    assert.equal(approved.ok, true, approved.error);
    assert.equal(sneaky.ok, true, sneaky.error);
    assert.equal(
      (approved.artifacts || []).filter((item) => item.kind === "download").length,
      1,
      "the approved session still got its download",
    );
    assert.equal(
      (sneaky.artifacts || []).filter((item) => item.kind === "download").length,
      0,
      "the unapproved session got nothing",
    );
    // Chromium starts the transfer before the guard can rule on it — the same
    // as when the two runs were serialized — so the request reaching the
    // server proves nothing. What matters is which bytes survived: only the
    // approved session's file exists, and it is the real one.
    const kept = (approved.artifacts || []).find((item) => item.kind === "download");
    assert.deepEqual(fs.readFileSync(kept.path), body);
    assert.ok(downloadRequests >= 1);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("downloadPolicy deny rejects even trusted approval", opts, async () => {
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    downloadPolicy: "deny",
  });
  try {
    const result = await bw.run("state.executed = true; return 'ran'", {
      approvedDownloads: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.error || "", /downloadPolicy=deny/);
    const state = await bw.run("return state.executed ?? false");
    assert.equal(state.result, false);
  } finally {
    await bw.close();
  }
});

test("screenshot without an extension still yields a png", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    await bw.run("await page.goto('https://example.com')");
    const result = await bw.run("return screenshot({kind: 'proof', name: 'home'})");
    assert.equal(result.ok, true, result.error);
    assert.ok(result.artifacts[0].path.endsWith(".png"));
  } finally {
    await bw.close();
  }
});

test("screenshots encode at CSS scale without changing page identity", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<main style="width:100px;height:100px;background:#369"></main>');
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
      }));
      const artifact = await screenshot({kind: 'debug', name: 'css-scale.png'});
      return {viewport, artifact};
    `);
    assert.equal(result.ok, true, result.error);
    const image = fs.readFileSync(result.result.artifact.path);
    assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(image.readUInt32BE(16), result.result.viewport.width);
    assert.equal(image.readUInt32BE(20), result.result.viewport.height);
    assert.ok(result.result.viewport.devicePixelRatio >= 1);
  } finally {
    await bw.close();
  }
});

test("visible bot challenges include actionable state and a vision artifact", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(
      "await page.setContent('<h1>One last step</h1><p>Please solve the challenge below to continue</p>'); return 'loaded'",
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.challenges?.[0]?.type, "bot_challenge");
    assert.equal(result.challenges?.[0]?.solve?.maxAttempts, 3);
    assert.ok(result.warnings?.some((warning) => /solve it before retrying/i.test(warning)));
    assert.ok(result.artifacts?.some((artifact) => artifact.kind === "captcha"));
  } finally {
    await bw.close();
  }
});

test("inactive stale challenges do not contaminate the active tab result", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<h1>Verify you are human to continue</h1>');
      const blockedId = pages[0];
      const clean = await openPage();
      await clean.setContent('<h1>Current clean result</h1>');
      return { blockedId, clean: await clean.title() };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.challenges, undefined);
    assert.equal(
      result.artifacts?.some((artifact) => artifact.kind === "captcha") ?? false,
      false,
    );

    const blockedId = result.result.blockedId.pageId;
    const selected = await bw.run(`
      await usePage(${JSON.stringify(blockedId)});
      return page.url();
    `);
    assert.equal(selected.challenges?.[0]?.type, "bot_challenge");
    assert.ok(selected.artifacts?.some((artifact) => artifact.kind === "captcha"));
  } finally {
    await bw.close();
  }
});

test("iframe-only bot challenges are detected", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<iframe srcdoc="<h1>Verify you are human</h1>"></iframe>');
      return 'loaded';
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.challenges?.[0]?.detectedIn, "frame");
  } finally {
    await bw.close();
  }
});

// The staged scan reads same-origin frame text without a round trip, so the
// srcdoc case above never exercises the hard half. A real out-of-process frame
// is opaque to that read, and this one names no provider anywhere in its URL:
// only the gate's unread-frame budget can reach it.
test("bot challenges in a cross-origin frame are detected", opts, async () => {
  const embed = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end("<!doctype html><body><h1>Verify you are human</h1></body>");
  }, "localhost");
  const site = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(
      `<!doctype html><body><h1>Checkout</h1>` +
        `<iframe width="320" height="120" src="${embed.origin}/w/9f3.html"></iframe>` +
        `</body>`,
    );
  });
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(site.origin)});
      const frames = page.frames();
      return frames.map(frame => frame.url());
    `);
    assert.equal(result.ok, true, result.error);
    assert.ok(
      result.result.some((url) => url.startsWith(embed.origin)),
      `the challenge frame never attached: ${JSON.stringify(result.result)}`,
    );
    assert.equal(result.challenges?.[0]?.detectedIn, "frame");
  } finally {
    await bw.close();
    await site.close();
    await embed.close();
  }
});

test("a completed provider response clears the challenge and resumes", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const unresolved = await bw.run(`
      await page.setContent(
        "<p>I'm not a robot</p>" +
        "<textarea hidden name='g-recaptcha-response'></textarea>" +
        "<textarea hidden name='g-recaptcha-response'></textarea>"
      );
      return 'waiting';
    `);
    assert.equal(unresolved.ok, true, unresolved.error);
    assert.equal(unresolved.challenges?.[0]?.provider, "recaptcha");

    const partial = await bw.run(`
      await page.locator('[name="g-recaptcha-response"]').first().evaluate(
        element => { element.value = 'first-provider-response'; }
      );
      return 'one widget remains';
    `);
    assert.equal(partial.challenges?.[0]?.provider, "recaptcha");

    const solved = await bw.run(`
      await page.locator('[name="g-recaptcha-response"]').evaluateAll(
        elements => elements.forEach(
          (element, index) => { element.value = 'provider-response-' + index; }
        )
      );
      return 'continue original task';
    `);
    assert.equal(solved.ok, true, solved.error);
    assert.equal(solved.result, "continue original task");
    assert.equal(solved.challenges, undefined);
  } finally {
    await bw.close();
  }
});

test("failed snippets preserve bot-challenge evidence for recovery", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<h1>Verify you are human to continue</h1>');
      throw new Error('blocked action');
    `);
    assert.equal(result.ok, false);
    assert.match(result.error, /blocked action/);
    assert.equal(result.challenges?.[0]?.type, "bot_challenge");
    assert.ok(result.artifacts?.some((artifact) => artifact.kind === "captcha"));
    assert.ok(Array.isArray(result.pages));
  } finally {
    await bw.close();
  }
});

test("a missing locator fails before the run deadline and preserves the page", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const seeded = await bw.run(
      "await page.setContent('<p id=kept>still here</p>'); return true",
    );
    assert.equal(seeded.ok, true, seeded.error);

    const started = Date.now();
    const missed = await bw.run(
      "await page.getByRole('button', {name:'never appears'}).click(); return true",
      { timeout: 25_000 },
    );
    assert.equal(missed.ok, false);
    assert.match(missed.error, /Timeout 10000ms exceeded/);
    assert.ok(Date.now() - started < 20_000, `locator miss took ${Date.now() - started}ms`);

    const recovered = await bw.run("return page.locator('#kept').textContent()");
    assert.equal(recovered.ok, true, recovered.error);
    assert.equal(recovered.result, "still here");
  } finally {
    await bw.close();
  }
});

test("timed-out challenge runs report that the page must be reopened", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(
      `
        await page.setContent('<h1>Verify you are human to continue</h1>');
        await new Promise(() => {});
      `,
      { timeout: 5 },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/i);
    assert.equal(result.challenges?.[0]?.solve?.resumeOnClear, false);
    assert.equal(result.challenges?.[0]?.solve?.reopenRequired, true);
    assert.equal(result.challenges?.[0]?.recovery?.pagePreserved, false);
    assert.match(result.warnings?.join(" ") || "", /next browser call, reopen/i);

    const restarted = await bw.run("return page.url()");
    assert.equal(restarted.ok, true, restarted.error);
  } finally {
    await bw.close();
  }
});

test("timeout restart flushes recent persistent-profile changes", opts, async () => {
  const server = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>Profile flush</title><h1>Profile flush</h1>");
  });
  const home = tempHome();
  try {
    const seed = new BetterWright({ home, headless: true });
    try {
      const stored = await seed.run(`
        await page.goto(${JSON.stringify(server.origin)});
        return page.evaluate(() => {
          document.cookie = 'seeded=alive; Max-Age=3600; Path=/; SameSite=Lax';
          return document.cookie;
        });
      `);
      assert.equal(stored.ok, true, stored.error);
      assert.match(stored.result, /seeded=alive/);
    } finally {
      await seed.close();
    }

    const bw = new BetterWright({ home, headless: true });
    try {
      const stored = await bw.run(`
        await page.goto(${JSON.stringify(server.origin)});
        return page.evaluate(() => {
          document.cookie = 'recent=alive; Max-Age=3600; Path=/; SameSite=Lax';
          return document.cookie;
        });
      `);
      assert.equal(stored.ok, true, stored.error);
      assert.equal(stored.profileMode, "persistent");
      assert.match(stored.result, /seeded=alive/);
      assert.match(stored.result, /recent=alive/);

      const timedOut = await bw.run("await new Promise(() => {})", {
        timeout: 5,
      });
      assert.equal(timedOut.ok, false);
      assert.match(timedOut.error, /timed out/i);

      const restarted = await bw.run(`
        await page.goto(${JSON.stringify(server.origin)});
        return page.evaluate(() => document.cookie);
      `);
      assert.equal(restarted.ok, true, restarted.error);
      assert.equal(restarted.profileMode, "persistent");
      assert.match(restarted.result, /seeded=alive/);
      assert.match(restarted.result, /recent=alive/);
    } finally {
      await bw.close();
    }
  } finally {
    await server.close();
  }
});

test("captcha.click activates a checkbox-style challenge and returns a fresh snapshot", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<button id="verify" style="width:300px;height:80px;padding:0">Verify you are human</button><script>window.pointerMoves=0;document.addEventListener("pointermove",()=>window.pointerMoves++);</script>');
      await page.locator('#verify').evaluate(element => {
        element.addEventListener('click', event => {
          const rect = element.getBoundingClientRect();
          window.clickRatio = (event.clientX - rect.left) / rect.width;
          if (window.clickRatio <= 0.2) element.textContent = 'Verified';
        });
      });
      const bounds = await page.locator('#verify').boundingBox();
      await captcha.click(bounds);
      return {
        text: await page.locator('#verify').textContent(),
        pointerMoves: await page.evaluate(() => window.pointerMoves),
        clickRatio: await page.evaluate(() => window.clickRatio),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.text, "Verified");
    assert.ok(result.result.pointerMoves >= 18, result.result.pointerMoves);
    assert.ok(result.result.clickRatio >= 0.12, result.result.clickRatio);
    assert.ok(result.result.clickRatio <= 0.18, result.result.clickRatio);
  } finally {
    await bw.close();
  }
});

test("captcha.inspect emits a challenge image for model vision", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<div id="challenge" style="width:300px;height:180px">Select every bus</div>');
      const bounds = await page.locator('#challenge').boundingBox();
      return captcha.inspect(bounds);
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.kind, "captcha");
    assert.match(result.result.instruction, /inspect the attached challenge/i);
    assert.equal(result.artifacts?.[0]?.kind, "captcha");
  } finally {
    await bw.close();
  }
});

test("captcha.drag performs a smooth pointer drag and returns a fresh snapshot", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <button id="handle" style="position:absolute;left:40px;top:40px;width:40px;height:40px">Slide</button>
        <p id="status" aria-live="polite">Waiting</p>
        <script>
          let started = false;
          document.querySelector('#handle').addEventListener('mousedown', () => { started = true; });
          document.addEventListener('mouseup', event => {
            if (started && event.clientX > 200) document.querySelector('#status').textContent = 'Dragged';
          });
        </script>
      \`);
      const bounds = await page.locator('#handle').boundingBox();
      const from = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
      return captcha.drag(from, {x: 260, y: from.y}, {steps: 12});
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result, /Dragged/);
  } finally {
    await bw.close();
  }
});

test("captcha.readText emits only a cropped image artifact for Pi vision", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<div id="code" style="font:32px monospace;width:220px;height:70px">A7K9</div>');
      const bounds = await page.locator('#code').boundingBox();
      return captcha.readText(bounds);
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.kind, "captcha");
    assert.match(result.result.instruction, /attached CAPTCHA crop/i);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].kind, "captcha");
    assert.deepEqual(fs.readFileSync(result.artifacts[0].path).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  } finally {
    await bw.close();
  }
});

test("human helpers use shaped pointer, keyboard, and wheel events", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <button id="go" style="margin:80px;width:180px;height:50px">Go</button>
        <input id="name" style="display:block;margin:40px;width:240px;height:40px" value="old">
        <div id="bio" contenteditable="true" style="display:block;margin:40px;width:240px;height:40px">stale words</div>
        <div style="height:2400px"></div>
        <p id="status">Waiting</p>
        <script>
          window.pointerMoves = 0;
          window.wheelEvents = 0;
          document.addEventListener('pointermove', () => window.pointerMoves++);
          document.addEventListener('wheel', () => window.wheelEvents++);
          document.querySelector('#go').addEventListener('click', () => {
            document.querySelector('#status').textContent = 'Clicked';
          });
        </script>
      \`);
      await human.click(page.locator('#go'));
      await human.type('#name', 'Ada');
      await human.type('#bio', 'Lovelace');
      await human.scroll(600, {steps: 6});
      return page.evaluate(() => ({
        status: document.querySelector('#status').textContent,
        value: document.querySelector('#name').value,
        bio: document.querySelector('#bio').textContent,
        pointerMoves: window.pointerMoves,
        wheelEvents: window.wheelEvents,
        scrollY,
      }));
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.status, "Clicked");
    assert.equal(result.result.value, "Ada");
    // The clear must actually remove pre-existing text — on the Chromium
    // fork a synthesized Control+A never ran the select-all editing command,
    // so "old"/"stale words" used to survive underneath the typed text.
    assert.equal(result.result.bio, "Lovelace");
    assert.ok(result.result.pointerMoves >= 18, result.result.pointerMoves);
    assert.ok(result.result.wheelEvents >= 2, result.result.wheelEvents);
    assert.ok(result.result.scrollY > 0, result.result.scrollY);
  } finally {
    await bw.close();
  }
});

test("human.type clears even when Backspace is swallowed", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <input id="name" value="old" style="width:240px;height:40px">
        <script>
          document.querySelector('#name').addEventListener('keydown', (event) => {
            if (event.key === 'Backspace' || event.key === 'Delete') event.preventDefault();
          });
        </script>
      \`);
      const typed = await human.type('#name', 'hello');
      return {
        typed,
        value: await page.evaluate(() => document.querySelector('#name').value),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.typed.typed, 5);
    assert.equal(result.result.value, "hello");
  } finally {
    await bw.close();
  }
});

test("human.type inserts into a rich-text editor that swallows key events", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <div id="editor" contenteditable="true" style="width:400px;height:80px"></div>
        <script>
          document.querySelector('#editor').addEventListener('keydown', (event) => {
            if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
              event.preventDefault();
            }
          });
        </script>
      \`);
      const typed = await human.type('#editor', 'hello from human');
      return {
        typed,
        text: await page.evaluate(() => document.querySelector('#editor').textContent),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.typed.typed, 16);
    assert.equal(result.result.text, "hello from human");
  } finally {
    await bw.close();
  }
});

test("human.type retries when key events only land a prefix", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <input id="name" style="width:240px;height:40px">
        <script>
          const name = document.querySelector('#name');
          name.addEventListener('keydown', (event) => {
            if (event.key.length === 1 && name.value.length >= 3) event.preventDefault();
          });
        </script>
      \`);
      const typed = await human.type('#name', 'hello');
      return {
        typed,
        value: await page.evaluate(() => document.querySelector('#name').value),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.typed.typed, 5);
    assert.equal(result.result.value, "hello");
  } finally {
    await bw.close();
  }
});

test("human.type restores a contenteditable before retrying a partial append", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <div id="editor" contenteditable="true" style="width:400px;height:80px">Ada</div>
        <script>
          const editor = document.querySelector('#editor');
          let accepted = 0;
          editor.addEventListener('keydown', (event) => {
            if (event.key.length !== 1) return;
            event.preventDefault();
            if (accepted < 1) {
              accepted += 1;
              editor.textContent += event.key;
            }
          });
        </script>
      \`);
      const typed = await human.type('#editor', 'Ada', {clear: false});
      return {
        typed,
        text: await page.evaluate(() => document.querySelector('#editor').textContent),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.typed.typed, 3);
    assert.equal(result.result.text, "AdaAda");
  } finally {
    await bw.close();
  }
});

test("human.type retries a partial append onto existing matching text", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <input id="name" value="Ada" style="width:240px;height:40px">
        <script>
          const name = document.querySelector('#name');
          let accepted = 0;
          name.addEventListener('keydown', (event) => {
            if (event.key.length !== 1) return;
            event.preventDefault();
            if (accepted < 1) {
              accepted += 1;
              name.value += event.key;
            }
          });
        </script>
      \`);
      const typed = await human.type('#name', 'Ada', {clear: false});
      return {
        typed,
        value: await page.evaluate(() => document.querySelector('#name').value),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.typed.typed, 3);
    assert.equal(result.result.value, "AdaAda");
  } finally {
    await bw.close();
  }
});

test("human.type appends when the field already contains the requested text", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <input id="name" value="Ada" style="width:240px;height:40px">
        <script>
          document.querySelector('#name').addEventListener('keydown', (event) => {
            if (event.key.length === 1) event.preventDefault();
          });
        </script>
      \`);
      const typed = await human.type('#name', 'Ada', {clear: false});
      return {
        typed,
        value: await page.evaluate(() => document.querySelector('#name').value),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.typed.typed, 3);
    assert.equal(result.result.value, "AdaAda");
  } finally {
    await bw.close();
  }
});

test("human.type throws when the field stays empty", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <div id="editor" contenteditable="true" style="width:400px;height:80px"></div>
        <script>
          const editor = document.querySelector('#editor');
          new MutationObserver(() => { editor.textContent = ''; }).observe(editor, {
            childList: true, subtree: true, characterData: true,
          });
          editor.addEventListener('keydown', (event) => {
            if (event.key.length === 1) event.preventDefault();
          });
          editor.addEventListener('beforeinput', (event) => event.preventDefault());
        </script>
      \`);
      await human.type('#editor', 'hello');
    `);
    assert.equal(result.ok, false);
    assert.match(String(result.error), /did not change the field/i);
  } finally {
    await bw.close();
  }
});

test("interactive snapshots expose refs that aria-ref locators can act on", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const snap = await bw.run(`
      await page.setContent(\`
        <h1>Title</h1><p>Lots of static prose.</p>
        <button id="go">Go</button>
        <script>
          document.querySelector('#go').addEventListener('click', () => {
            document.querySelector('h1').textContent = 'Done';
          });
        </script>
      \`);
      return snapshot({interactive: true});
    `);
    assert.equal(snap.ok, true, snap.error);
    assert.match(snap.result, /button "Go" \[ref=(e\d+)\]/);
    assert.ok(!snap.result.includes("static prose"), snap.result);
    const ref = snap.result.match(/button "Go" \[ref=(e\d+)\]/)[1];
    const clicked = await bw.run(`
      await page.locator('aria-ref=${ref}').click();
      return page.locator('h1').textContent();
    `);
    assert.equal(clicked.ok, true, clicked.error);
    assert.equal(clicked.result, "Done");
  } finally {
    await bw.close();
  }
});

test("WebMCP discovers and invokes a real page-published tool without exposing CDP", opts, async () => {
  const site = await listen((_request, response) => {
    response.writeHead(200, {"content-type": "text/html"});
    response.end(`<!doctype html>
      <h1>WebMCP fixture</h1>
      <p id="status">waiting</p>
      <script>
        const modelContext = navigator.modelContext || document.modelContext;
        modelContext.registerTool({
          name: "calculateSum",
          description: "Add two numbers.",
          inputSchema: {
            type: "object",
            properties: {a: {type: "number"}, b: {type: "number"}},
            required: ["a", "b"],
          },
          annotations: {readOnly: true, untrustedContent: false},
          execute: ({a, b}) => {
            document.querySelector("#status").textContent = "invoked";
            return {a, b, sum: Number(a) + Number(b)};
          },
        });
      </script>`);
  });
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(site.origin)});
      const tools = await webmcp.tools({timeout: 1000});
      const invocation = await webmcp.invoke(
        "calculateSum",
        {a: 19, b: 23},
        {frameId: tools[0].frameId, timeout: 5000},
      );
      return {
        tools,
        invocation,
        visibleState: await page.locator("#status").innerText(),
        cdpType: typeof context.newCDPSession,
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.tools.length, 1);
    assert.equal(result.result.tools[0].name, "calculateSum");
    assert.equal(result.result.tools[0].trust, "untrusted_external_data");
    // Chromium normalizes annotations before emitting the descriptor (the
    // pinned build currently reports an explicit boolean here even when the
    // registration supplied true), so this pins preservation, not a browser
    // implementation detail.
    assert.ok(isBoolean(result.result.tools[0].annotations.readOnly));
    assert.equal(result.result.invocation.status, "Completed");
    assert.deepEqual(result.result.invocation.output, {a: 19, b: 23, sum: 42});
    assert.equal(result.result.invocation.trust, "untrusted_external_data");
    assert.equal(result.result.visibleState, "invoked");
    assert.equal(result.result.cdpType, "undefined");
  } finally {
    await bw.close();
    await site.close();
  }
});

test("snapshot compresses wrappers and urls but keeps refs actionable", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <div><div><a href="/docs">Docs</a></div></div>
        <p>First.</p><p>Second.</p>
      \`);
      const plain = await snapshot();
      const withUrls = await snapshot({urls: true});
      return {plain, withUrls};
    `);
    assert.equal(result.ok, true, result.error);
    // Wrapper divs are unwrapped, /url dropped, paragraphs merged into text.
    assert.match(result.result.plain, /link "Docs" \[ref=e\d+\]/);
    assert.ok(!result.result.plain.includes("/url"), result.result.plain);
    assert.match(result.result.plain, /text: First\. Second\./);
    assert.match(result.result.withUrls, /\/url: \/docs/);
  } finally {
    await bw.close();
  }
});

test("oversized snapshots return scoping hints instead of a cut-off tree", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      const rows = Array.from({length: 200}, (_, i) =>
        \`<li><a href="/item/\${i}">Item number \${i} with some label text</a></li>\`).join("");
      await page.setContent(\`<ul>\${rows}</ul>\`);
      return snapshot({maxChars: 1000});
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result, /Snapshot is \d+ chars, over the 1000 limit/);
    assert.match(result.result, /interactive: true/);
    assert.ok(!result.result.includes("[ref="), result.result);
  } finally {
    await bw.close();
  }
});

test("snapshot diff returns only what changed", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<button id="go">Go</button><p id="status">Idle</p>');
      const first = await snapshot({diff: true});
      const unchanged = await snapshot({diff: true});
      await page.locator('#status').evaluate(el => { el.textContent = 'Running'; });
      const changed = await snapshot({diff: true});
      return {first, unchanged, changed};
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result.first, /button "Go"/);
    assert.match(result.result.unchanged, /no changes since previous snapshot/);
    assert.match(result.result.changed, /diff vs previous snapshot \(\+\d+ -\d+\)/);
    assert.match(result.result.changed, /\+.*Running/);
    assert.ok(!result.result.changed.includes('button "Go"'), result.result.changed);
  } finally {
    await bw.close();
  }
});

test("snapshot scopes to a selector", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<nav><a href="#x">Away</a></nav><main id="m"><button>In</button></main>');
      return snapshot({selector: '#m'});
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result, /button "In"/);
    assert.ok(!result.result.includes("Away"), result.result);
  } finally {
    await bw.close();
  }
});

test("empty envelope collections are omitted, not sent as []", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run("return 1 + 1");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, 2);
    assert.ok(!("console" in result), "console should be omitted when empty");
    assert.ok(!("events" in result), "events should be omitted when empty");
    assert.ok(!("artifacts" in result), "artifacts should be omitted when empty");
  } finally {
    await bw.close();
  }
});

test("model code cannot reach CDP or Playwright private channels", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      return {
        pageContext: typeof page.context,
        contextCdp: typeof context.newCDPSession,
        pageChannel: typeof page._channel,
        contextBrowser: typeof context.browser,
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result, {
      pageContext: "undefined",
      contextCdp: "undefined",
      pageChannel: "undefined",
      contextBrowser: "undefined",
    });
  } finally {
    await bw.close();
  }
});

test("page.on collects page console and pageerror for the current snippet", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const issueRepro = await bw.run(`
      const messages = [];
      page.on("console", (message) => messages.push(message.text()));
      return { onType: typeof page.on, messages };
    `);
    assert.equal(issueRepro.ok, true, issueRepro.error);
    assert.deepEqual(issueRepro.result, { onType: "function", messages: [] });

    const captured = await bw.run(`
      const messages = [];
      const errors = [];
      page.on("console", (message) => messages.push({
        type: message.type(),
        text: message.text(),
      }));
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent(\`<script>
        console.log("hello from page");
        console.warn("careful");
        throw new Error("page boom");
      </script>\`);
      return { messages, errors };
    `);
    assert.equal(captured.ok, true, captured.error);
    assert.ok(
      captured.result.messages.some((item) => item.type === "log" && item.text.includes("hello from page")),
      JSON.stringify(captured.result.messages),
    );
    assert.ok(
      captured.result.messages.some((item) => item.type === "warning" && item.text.includes("careful")),
      JSON.stringify(captured.result.messages),
    );
    assert.ok(
      captured.result.errors.some((text) => text.includes("page boom")),
      JSON.stringify(captured.result.errors),
    );

    const onceOnly = await bw.run(`
      const seen = [];
      page.once("console", (message) => seen.push(message.text()));
      await page.evaluate(() => { console.log("first"); console.log("second"); });
      return seen;
    `);
    assert.equal(onceOnly.ok, true, onceOnly.error);
    assert.deepEqual(onceOnly.result, ["first"]);

    const detached = await bw.run(`
      const seen = [];
      const listener = (message) => seen.push(message.text());
      page.on("console", listener);
      page.off("console", listener);
      await page.evaluate(() => console.log("should not collect"));
      return seen;
    `);
    assert.equal(detached.ok, true, detached.error);
    assert.deepEqual(detached.result, []);
  } finally {
    await bw.close();
  }
});

test("page.on listeners do not leak into the next snippet", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const first = await bw.run(`
      page.on("console", (message) => {
        state.n = (state.n || 0) + 1;
        state.last = message.text();
      });
      await page.evaluate(() => console.log("one"));
      return { n: state.n, last: state.last };
    `);
    assert.equal(first.ok, true, first.error);
    assert.deepEqual(first.result, { n: 1, last: "one" });

    const second = await bw.run(`
      await page.evaluate(() => console.log("two"));
      return { n: state.n, last: state.last };
    `);
    assert.equal(second.ok, true, second.error);
    assert.deepEqual(second.result, { n: 1, last: "one" });
  } finally {
    await bw.close();
  }
});

test("page.on still refuses routing events and cannot strip worker listeners", opts, async () => {
  const server = await listen((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<p>ok</p>");
  });
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const result = await bw.run(`
      const surface = {
        on: typeof page.on,
        once: typeof page.once,
        off: typeof page.off,
        route: typeof page.route,
        removeAllListeners: typeof page.removeAllListeners,
        prependListener: typeof page.prependListener,
        contextOn: typeof context.on,
      };
      let requestError = "";
      try { page.on("request", () => {}); }
      catch (error) { requestError = error.message; }
      await page.goto(${JSON.stringify(server.origin)});
      const requests = await site.requests();
      return { surface, requestError, requestCount: requests.length };
    `);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result.surface, {
      on: "function",
      once: "function",
      off: "function",
      route: "undefined",
      removeAllListeners: "undefined",
      prependListener: "undefined",
      contextOn: "undefined",
    });
    assert.match(result.result.requestError, /can only listen for console and pageerror/);
    assert.ok(result.result.requestCount > 0, JSON.stringify(result.result));
  } finally {
    await bw.close();
    await server.close();
  }
});

test("returned Playwright objects cannot serialize host internals", opts, async () => {
  const variable = "BETTERWRIGHT_SERIALIZER_SENTINEL";
  const sentinel = `serializer-secret-${Date.now()}`;
  const previous = process.env[variable];
  process.env[variable] = sentinel;
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const contextResult = await bw.run("return context");
    assert.equal(contextResult.ok, true, contextResult.error);
    assert.deepEqual(contextResult.result, { type: "BrowserContext" });

    const locatorResult = await bw.run("return page.locator('body')");
    assert.equal(locatorResult.ok, true, locatorResult.error);
    assert.deepEqual(locatorResult.result, {
      type: "Locator",
      locator: "locator('body')",
    });

    const serialized = JSON.stringify([contextResult, locatorResult]);
    assert.ok(!serialized.includes(sentinel), serialized);
    assert.doesNotMatch(
      serialized,
      /_connection|_channel|newCDPSession|executablePath|process\.env/,
    );
  } finally {
    await bw.close();
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("model navigation cannot open browser-internal control pages", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const chrome = await bw.run(
      "await page.goto('chrome://version'); return page.locator('body').innerText()",
    );
    assert.equal(chrome.ok, false);
    assert.match(chrome.error, /scheme is not available: chrome:/);
    assert.doesNotMatch(JSON.stringify(chrome), /remote-debugging|fingerprint=/i);

    const devtools = await bw.run(
      "await openPage('devtools://devtools/bundled/inspector.html'); return 'opened'",
    );
    assert.equal(devtools.ok, false);
    assert.match(devtools.error, /scheme is not available: devtools:/);
  } finally {
    await bw.close();
  }
});

test("an image-grid challenge is solvable with aria-ref tile clicks and Verify", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    // A synthetic reCAPTCHA-style grid: three "correct" tiles must be selected,
    // then Verify reveals success. Exercises the documented flow — snapshot for
    // refs, click tiles by aria-ref, click Verify — without touching a provider.
    const result = await bw.run(`
      await page.setContent(\`
        <div role="dialog" aria-label="Select all images with bicycles">
          <button aria-label="tile 0" data-correct="1"></button>
          <button aria-label="tile 1"></button>
          <button aria-label="tile 2" data-correct="1"></button>
          <button aria-label="tile 3"></button>
          <button aria-label="tile 4" data-correct="1"></button>
          <button id="verify">Verify</button>
          <p id="status" aria-live="polite">Unsolved</p>
        </div>
        <script>
          const chosen = new Set();
          for (const b of document.querySelectorAll('button[aria-label^="tile"]')) {
            b.addEventListener('click', () => { b.dataset.on = '1'; chosen.add(b); });
          }
          document.querySelector('#verify').addEventListener('click', () => {
            const correct = [...document.querySelectorAll('button[data-correct]')];
            const ok = correct.every(b => b.dataset.on === '1') &&
              [...chosen].every(b => b.dataset.correct === '1');
            document.querySelector('#status').textContent = ok ? 'Verified' : 'Try again';
          });
        </script>
      \`);
      const tree = await snapshot({interactive: true});
      const refFor = (label) =>
        (tree.match(new RegExp('"' + label + '" \\\\[ref=(e\\\\d+)\\\\]')) || [])[1];
      for (const label of ['tile 0', 'tile 2', 'tile 4']) {
        await human.click(page.locator('aria-ref=' + refFor(label)));
      }
      await human.click(page.locator('aria-ref=' + refFor('Verify')));
      return page.locator('#status').textContent();
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, "Verified");
  } finally {
    await bw.close();
  }
});

// --- Named profiles: separate identities in one home -----------------------

test("two named profiles browse concurrently, both persistent", opts, async () => {
  const home = tempHome();
  const social = new BetterWright({ home, profile: "social", headless: true });
  const review = new BetterWright({ home, profile: "review", headless: true });
  try {
    const [a, b] = await Promise.all([
      social.run("await page.goto('about:blank'); return 'social'"),
      review.run("await page.goto('about:blank'); return 'review'"),
    ]);
    assert.equal(a.ok, true, a.error);
    assert.equal(b.ok, true, b.error);
    // Neither was pushed onto the signed-out ephemeral fallback.
    assert.equal(a.profileMode, "persistent");
    assert.equal(b.profileMode, "persistent");
    assert.ok(fs.existsSync(path.join(home, "browser", "profiles", "social")));
    assert.ok(fs.existsSync(path.join(home, "browser", "profiles", "review")));
    assert.equal(fs.existsSync(path.join(home, "browser", "profile")), false);
  } finally {
    await Promise.all([social.close(), review.close()]);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cookies are per profile, and survive a restart of the same profile", opts, async () => {
  // The point of a named profile is a separate, *persistent* cookie jar. A
  // local server keeps this test offline and loopback-only.
  const server = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>jar</title><p>cookie jar</p>");
  });
  const { origin } = server;

  const home = tempHome();
  const social = new BetterWright({ home, profile: "social", headless: true });
  const review = new BetterWright({ home, profile: "review", headless: true });
  try {
    const set = await social.run(
      `await page.goto(${JSON.stringify(origin)}); ` +
        "await page.evaluate(() => { document.cookie = 'bw=social; path=/; max-age=3600'; }); " +
        "return page.evaluate(() => document.cookie)",
    );
    assert.equal(set.ok, true, set.error);
    assert.match(set.result, /bw=social/);

    const other = await review.run(
      `await page.goto(${JSON.stringify(origin)}); return page.evaluate(() => document.cookie)`,
    );
    assert.equal(other.ok, true, other.error);
    assert.doesNotMatch(other.result, /bw=social/, "the other profile must not see the cookie");

    // Reopen "social" after closing it: a named profile persists like the
    // default one, rather than being an ephemeral directory per launch.
    await social.close();
    const again = new BetterWright({ home, profile: "social", headless: true });
    try {
      const back = await again.run(
        `await page.goto(${JSON.stringify(origin)}); return page.evaluate(() => document.cookie)`,
      );
      assert.equal(back.ok, true, back.error);
      assert.match(back.result, /bw=social/, "the profile did not persist its cookie jar");
    } finally {
      await again.close();
    }
  } finally {
    await Promise.all([social.close(), review.close()]);
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a second browser on the SAME profile falls back to ephemeral", opts, async () => {
  const home = tempHome();
  const first = new BetterWright({ home, profile: "social", headless: true });
  const second = new BetterWright({ home, profile: "social", headless: true });
  try {
    const a = await first.run("return 'first'");
    assert.equal(a.ok, true, a.error);
    assert.equal(a.profileMode, "persistent");
    const b = await second.run("return 'second'");
    assert.equal(b.ok, true, b.error);
    assert.equal(b.profileMode, "ephemeral");
  } finally {
    await Promise.all([first.close(), second.close()]);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
