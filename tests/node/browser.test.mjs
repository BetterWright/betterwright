// End-to-end Node tests. Skipped unless managed CloakBrowser is installed, so the
// policy suite still runs on machines without the runtime installed.
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { cloakRuntime } from "../../src/doctor.mjs";
import { BetterWright, NetworkPolicy, runAgentTask } from "../../src/index.mjs";

const ready = (await cloakRuntime()).installed;
// On a laptop without the runtime, skipping is friendly. In CI it would mean
// the entire integration suite silently reports green without running, so the
// workflows set BETTERWRIGHT_REQUIRE_BROWSER=1 to turn that into a failure.
if (!ready && process.env.BETTERWRIGHT_REQUIRE_BROWSER) {
  throw new Error(
    "BETTERWRIGHT_REQUIRE_BROWSER is set but managed CloakBrowser is unavailable — " +
      "the browser integration suite would silently skip. Run `betterwright setup`.",
  );
}
const opts = { skip: ready ? false : "browser runtime not installed" };

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-test-"));
}

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
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
      const turn =
        typeof scripted === "function" ? await scripted(request) : scripted;
      assert.ok(turn, `unexpected agent turn ${index}`);
      return { text: "", usage: null, ...turn };
    },
  };
}

class LimitedBetterWright extends BetterWright {
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

test("browser capture saves an accepted model login through real Cloak", opts, async () => {
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
  const bw = new LimitedBetterWright(
    {
      home,
      headless: true,
      downloadPolicy: "allow",
      policy: new NetworkPolicy({ allowLoopback: true }),
    },
    { maxArtifactBytes: maxDownloadBytes, maxDownloadBytes },
  );
  let maxObserved = 0;
  const observer = setInterval(() => {
    maxObserved = Math.max(maxObserved, directorySize(path.join(home, "artifacts")));
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
      maxObserved <= maxDownloadBytes + chunk.length * 4,
      `download grew to ${maxObserved} bytes before cancellation`,
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
    assert.equal(downloadRequests, 1);
    assert.equal(directorySize(path.join(home, "artifacts")), 0);
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
      await human.scroll(600, {steps: 6});
      return page.evaluate(() => ({
        status: document.querySelector('#status').textContent,
        value: document.querySelector('#name').value,
        pointerMoves: window.pointerMoves,
        wheelEvents: window.wheelEvents,
        scrollY,
      }));
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.status, "Clicked");
    assert.equal(result.result.value, "Ada");
    assert.ok(result.result.pointerMoves >= 18, result.result.pointerMoves);
    assert.ok(result.result.wheelEvents >= 2, result.result.wheelEvents);
    assert.ok(result.result.scrollY > 0, result.result.scrollY);
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
