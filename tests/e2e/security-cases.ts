import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  confinedUpstream,
  credentialSite,
  denied,
  excludesSecret,
  result,
  savedLogin,
  syntheticSecret,
} from "./security-fixtures.js";
import type { E2ECase } from "./types.js";

export const cases: E2ECase[] = [
  {
    id: "security.vm-node-globals",
    group: "security",
    title: "Snippet globals cannot access Node, host processes, or module loading",
    requiresBrowser: true,
    async run(ctx) {
      const envelope = await ctx.run(`
        await page.setContent('<h1 id="marker">VM fixture</h1>');
        const globals = [typeof process, typeof require, typeof module, typeof Buffer, typeof fs];
        const failures = [];
        for (const operation of [() => process.cwd(), () => require('node:fs'), () => import('node:fs')]) {
          try { await operation(); failures.push(false); } catch { failures.push(true); }
        }
        await page.locator('#marker').evaluate(element => element.textContent = 'Browser still usable');
        return {globals, failures, heading: await page.locator('#marker').textContent()};
      `);
      assert.deepEqual(result(envelope), {
        globals: Array(5).fill("undefined"), failures: [true, true, true], heading: "Browser still usable",
      });
    },
  },
  {
    id: "security.vm-private-routing",
    group: "security",
    title: "CDP, private channels, routing, and context mutation stay inaccessible",
    requiresBrowser: true,
    async run(ctx) {
      const site = await credentialSite(ctx);
      const envelope = await ctx.run(`
        const hidden = [page.context, page._channel, page._connection, page.request, page.route,
          page.routeWebSocket, page.unroute, page.exposeFunction, page.exposeBinding,
          context.browser, context.newCDPSession, context.newPage, context.cookies,
          context.storageState, context.addCookies, context.clearCookies, context.close,
          context.tracing, context.route, page.locator('body')._frame];
        let eventDenied = false;
        try { page.on('request', () => {}); } catch { eventDenied = true; }
        await page.goto(${JSON.stringify(site.origin)});
        return {hidden: hidden.map(value => typeof value), eventDenied, title: await page.title()};
      `);
      assert.deepEqual(result(envelope), {
        hidden: Array(20).fill("undefined"), eventDenied: true, title: "Security fixture",
      });
      assert.equal(site.state.requests.get("/"), 1);
    },
  },
  {
    id: "security.vm-constructor-prototype",
    group: "security",
    title: "Constructor chains cannot compile host code or expose wrapped prototypes",
    requiresBrowser: true,
    async run(ctx) {
      const envelope = await ctx.run(`
        await page.setContent('<h1>Prototype fixture</h1>');
        const attempts = [() => eval('typeof process'), () => Function('return process')(),
          () => ({}).constructor.constructor('return process')(),
          () => URL.constructor('return process')(),
          () => new URLSearchParams().constructor.constructor('return process')()];
        const blocked = attempts.map(operation => { try { operation(); return false; } catch { return true; } });
        return {blocked, pagePrototype: Object.getPrototypeOf(page),
          locatorPrototype: Object.getPrototypeOf(page.locator('h1')),
          hidden: [typeof page.constructor, typeof page.__proto__, typeof page.locator('h1').constructor],
          heading: await page.locator('h1').textContent()};
      `);
      assert.deepEqual(result(envelope), {
        blocked: Array(5).fill(true), pagePrototype: null, locatorPrototype: null,
        hidden: Array(3).fill("undefined"), heading: "Prototype fixture",
      });
    },
  },
  {
    id: "security.request-response-headers",
    group: "security",
    title: "Request and response wrappers hide raw cookie headers and private channels",
    requiresBrowser: true,
    async run(ctx) {
      let cookieRequests = 0;
      const cookie = syntheticSecret(ctx);
      const site = await ctx.serve((request, response) => {
        if (request.headers.cookie === `fixture=${cookie}`) cookieRequests += 1;
        response.setHeader("set-cookie", `fixture=${cookie}; HttpOnly; SameSite=Lax; Path=/`);
        response.setHeader("x-fixture", "public-metadata");
        response.end('<title>Header fixture</title><link rel="icon" href="data:,">');
      });
      const envelope = await ctx.run(`
        await page.goto(${JSON.stringify(site.origin)});
        const pendingRequest = page.waitForRequest(${JSON.stringify(`${site.origin}/again`)});
        const response = await page.goto(${JSON.stringify(`${site.origin}/again`)});
        const request = await pendingRequest;
        return {
          status: response.status(),
          requestMethods: ['allHeaders', 'headersArray', 'headerValue', '_channel'].map(key => typeof request[key]),
          responseMethods: ['allHeaders', 'headersArray', 'headerValue', 'headerValues', '_channel', 'request'].map(key => typeof response[key]),
          requestHeaders: await request.headers(), responseHeaders: await response.headers(),
          title: await page.title(),
        };
      `);
      const value = result(envelope);
      assert.equal(value.status, 200);
      assert.equal(value.title, "Header fixture");
      assert.deepEqual(value.requestMethods, Array(4).fill("undefined"));
      assert.deepEqual(value.responseMethods, Array(6).fill("undefined"));
      assert.equal(Object.hasOwn(value.requestHeaders, "cookie"), false);
      assert.equal(Object.hasOwn(value.responseHeaders, "set-cookie"), false);
      assert.equal(value.responseHeaders["x-fixture"], "public-metadata");
      assert.ok(cookieRequests >= 1);
      excludesSecret(envelope, cookie);
    },
  },
  {
    id: "security.internal-navigation",
    group: "security",
    title: "Host file and browser-internal navigations fail without disturbing a safe page",
    requiresBrowser: true,
    async run(ctx) {
      const sentinel = syntheticSecret(ctx);
      const file = path.join(ctx.workDir, "private-document.html");
      await writeFile(file, `<h1>${sentinel}</h1>`);
      for (const url of [pathToFileURL(file).href, "chrome://version", "chrome://settings"]) {
        result(await ctx.run("await page.setContent('<h1>Safe page</h1>'); return page.locator('h1').textContent();"));
        const blocked = await ctx.run(`await page.goto(${JSON.stringify(url)}); return page.locator('body').innerText();`);
        denied(blocked, /blocked|scheme|not allowed|unsupported|denied/i);
        excludesSecret(blocked, sentinel);
        assert.equal(result(await ctx.run("return page.locator('h1').textContent();")), "Safe page");
      }
      assert.equal(result(await ctx.run("await page.goto('data:text/html,<h1>Safe data URL</h1>'); return page.locator('h1').textContent();")), "Safe data URL");
    },
  },
  {
    id: "security.upload-paths",
    group: "security",
    title: "File uploads reject outside paths, traversal, and symlinks but allow artifacts",
    requiresBrowser: true,
    async run(ctx) {
      const outside = path.join(ctx.home, "outside-upload.txt");
      const secret = syntheticSecret(ctx);
      await mkdir(ctx.home, { recursive: true });
      await writeFile(outside, secret);
      const allowed = result(await ctx.run("await page.setContent('<input id=upload type=file>'); return artifactPath('allowed.txt');"));
      await writeFile(allowed, "allowed local artifact");
      const linked = path.join(path.dirname(allowed), "outside-link.txt");
      await symlink(outside, linked);
      const traversal = `${path.dirname(allowed)}/../../outside-upload.txt`;
      for (const candidate of [outside, traversal, linked]) {
        const blocked = await ctx.run(`await page.locator('#upload').setInputFiles(${JSON.stringify(candidate)});`);
        denied(blocked, /artifact directory/i);
        excludesSecret(blocked, secret);
        assert.equal(result(await ctx.run("return page.locator('#upload').evaluate(element => element.files.length);")), 0);
      }
      const uploaded = await ctx.run(`
        await page.locator('#upload').setInputFiles(${JSON.stringify(allowed)});
        return page.locator('#upload').evaluate(element => element.files[0].text());
      `);
      assert.equal(result(uploaded), "allowed local artifact");
      result(await ctx.run("await page.locator('#upload').setInputFiles([]); return true;"));
      const chooser = await ctx.run(`
        const pending = page.waitForEvent('filechooser');
        await page.locator('#upload').click();
        await (await pending).setFiles(${JSON.stringify(outside)});
      `);
      denied(chooser, /artifact directory/i);
      assert.equal(result(await ctx.run("return page.locator('#upload').evaluate(element => element.files.length);")), 0);
    },
  },
  {
    id: "security.script-read-paths",
    group: "security",
    title: "Script and stylesheet paths cannot read files outside the artifact directory",
    requiresBrowser: true,
    async run(ctx) {
      const script = path.join(ctx.workDir, "outside.js");
      const style = path.join(ctx.workDir, "outside.css");
      await writeFile(script, "globalThis.outsideScriptRan = true;");
      await writeFile(style, "body { --outside-style: read; }");
      const site = await credentialSite(ctx);
      result(await ctx.run(`await page.goto(${JSON.stringify(site.origin)}); return true;`));
      for (const code of [
        `await page.addInitScript({path: ${JSON.stringify(script)}});`,
        `await page.addScriptTag({path: ${JSON.stringify(script)}});`,
        `await page.addStyleTag({path: ${JSON.stringify(style)}});`,
      ]) denied(await ctx.run(code), /artifact directory/i);
      const before = result(await ctx.run(`
        await page.reload();
        return page.evaluate(() => ({ran: window.outsideScriptRan === true,
          style: getComputedStyle(document.body).getPropertyValue('--outside-style')}));
      `));
      assert.deepEqual(before, { ran: false, style: "" });
      const allowed = result(await ctx.run("return artifactPath('allowed-init.js');"));
      await writeFile(allowed, "globalThis.allowedScriptRan = 'local artifact';");
      assert.equal(result(await ctx.run(`
        await page.addInitScript({path: ${JSON.stringify(allowed)}});
        await page.reload(); return page.evaluate(() => window.allowedScriptRan);
      `)), "local artifact");
    },
  },
  {
    id: "security.artifact-write-paths",
    group: "security",
    title: "Browser writes reject traversal and keep screenshots and PDFs inside artifacts",
    requiresBrowser: true,
    async run(ctx) {
      const outside = path.join(ctx.home, "outside.pdf");
      await mkdir(ctx.home, { recursive: true });
      await writeFile(outside, "do not overwrite");
      const allowed = result(await ctx.run("await page.setContent('<h1>PDF fixture</h1>'); return artifactPath('allowed.pdf');"));
      for (const candidate of [outside, `${path.dirname(allowed)}/../../outside.pdf`]) {
        denied(await ctx.run(`await page.pdf({path: ${JSON.stringify(candidate)}});`), /artifactPath|screenshot|artifact/i);
        assert.equal(await readFile(outside, "utf8"), "do not overwrite");
      }
      result(await ctx.run(`await page.pdf({path: ${JSON.stringify(allowed)}}); return true;`));
      assert.equal((await readFile(allowed)).subarray(0, 5).toString(), "%PDF-");
      const envelope = await ctx.run("return screenshot({name: '../../escaped-proof.png'});");
      const screenshot = result(envelope);
      const relative = path.relative(path.join(ctx.home, "artifacts"), screenshot.path);
      assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative));
      assert.deepEqual([...(await readFile(screenshot.path)).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(envelope.artifacts.some((artifact) => artifact.path === screenshot.path));
    },
  },
  {
    id: "security.metadata-floor",
    group: "security",
    title: "Metadata addresses remain blocked despite allowlisting and never reach a local upstream",
    requiresBrowser: true,
    async run(ctx) {
      const proxy = await confinedUpstream(ctx);
      const args = ["--no-launch-identity", "--upstream-proxy", proxy.origin,
        "--allow-host", "169.254.169.254", "--allow-host", "169.254.170.2",
        "--allow-host", "100.100.100.200", "--allow-host", "metadata.google.internal"];
      assert.equal(result(await ctx.run(`await page.goto(${JSON.stringify(proxy.origin)}); return page.title();`, { args })), "Confined upstream");
      const probes = ["169.254.169.254", "169.254.170.2", "100.100.100.200", "metadata.google.internal"];
      for (const host of probes) {
        denied(await ctx.run(`await page.goto(${JSON.stringify(`http://${host}/e2e-metadata`)});`, { args }), /metadata|blocked|denied/i);
      }
      assert.ok(proxy.requests.some((request) => request.startsWith("GET / ")));
      for (const host of probes) assert.equal(proxy.authorities.includes(`${host}:80`), false);
      assert.equal(result(await ctx.run(`await page.goto(${JSON.stringify(proxy.origin)}); return page.title();`, { args })), "Confined upstream");
    },
  },
  {
    id: "security.private-network-policy",
    group: "security",
    title: "Private-network denial stops transport while a separate default policy reaches the fixture",
    requiresBrowser: true,
    async run(ctx) {
      const proxy = await confinedUpstream(ctx);
      const args = ["--no-launch-identity", "--upstream-proxy", proxy.origin];
      const url = "http://10.77.0.123/private-fixture";
      denied(await ctx.run(`await page.goto(${JSON.stringify(url)});`, {
        profile: "private-denied", args: [...args, "--block-private-network"],
      }), /private|blocked|denied/i);
      assert.equal(proxy.authorities.includes("10.77.0.123:80"), false);
      const allowed = await ctx.run(`await page.goto(${JSON.stringify(url)}); return page.title();`, {
        profile: "private-allowed", args,
      });
      assert.equal(allowed.ok, true, JSON.stringify({error: allowed.error, authorities: proxy.authorities, requests: proxy.requests}));
      assert.equal(allowed.result, "Confined upstream");
      assert.ok(proxy.authorities.includes("10.77.0.123:80"));
      assert.ok(proxy.requests.includes("GET /private-fixture HTTP/1.1"));
    },
  },
  {
    id: "security.loopback-policy",
    group: "security",
    title: "Loopback denial covers numeric, localhost, and mapped IPv6 URLs with an allow-host control",
    requiresBrowser: true,
    async run(ctx) {
      const site = await credentialSite(ctx);
      const port = new URL(site.origin).port;
      for (const origin of [site.origin, site.alternateOrigin, `http://[::ffff:127.0.0.1]:${port}`]) {
        denied(await ctx.run(`await page.goto(${JSON.stringify(`${origin}/denied`)});`, {
          profile: "loopback-denied", args: ["--block-loopback"],
        }), /loopback|blocked|denied/i);
      }
      assert.equal(site.state.requests.get("/denied") || 0, 0);
      assert.equal(result(await ctx.run(`await page.goto(${JSON.stringify(`${site.origin}/allowed`)}); return page.title();`, {
        profile: "loopback-allowed", args: ["--block-loopback", "--allow-host", new URL(site.origin).host],
      })), "Security fixture");
      assert.equal(site.state.requests.get("/allowed"), 1);
    },
  },
  {
    id: "security.blocked-host-subresources",
    group: "security",
    title: "A blocked local hostname cannot be fetched or reached through a redirect",
    requiresBrowser: true,
    async run(ctx) {
      let blockedHits = 0;
      let redirectHits = 0;
      const target = await ctx.serve((_request, response) => {
        blockedHits += 1;
        response.end("blocked target reached");
      });
      const site = await ctx.serve((request, response) => {
        if (request.url === "/redirect") {
          redirectHits += 1;
          response.writeHead(302, { location: `${target.alternateOrigin}/denied` });
          response.end();
          return;
        }
        response.setHeader("content-type", "text/html");
        response.end('<title>Allowed local page</title><link rel="icon" href="data:,">');
      });
      const args = ["--block-host", "localhost", "--allow-host", "localhost"];
      const fetch = result(await ctx.run(`
        await page.goto(${JSON.stringify(site.origin)});
        const failed = await page.evaluate(async (url) => {
          try { await fetch(url, {mode: 'no-cors'}); return false; } catch { return true; }
        }, ${JSON.stringify(`${target.alternateOrigin}/denied`)});
        return {failed, title: await page.title()};
      `, { args }));
      assert.deepEqual(fetch, { failed: true, title: "Allowed local page" });
      assert.equal(blockedHits, 0);
      denied(await ctx.run(`await page.goto(${JSON.stringify(`${site.origin}/redirect`)});`, { args }), /blocked|denied|ERR_FAILED|ERR_SOCKS_CONNECTION_FAILED/i);
      assert.equal(redirectHits, 1);
      assert.equal(blockedHits, 0);
      assert.equal(result(await ctx.run(`await page.goto(${JSON.stringify(`${target.origin}/positive`)}); return page.locator('body').textContent();`, { args })), "blocked target reached");
      assert.ok(blockedHits >= 1);
    },
  },
  {
    id: "security.vault-metadata-storage",
    group: "security",
    title: "Saved credentials expose metadata only and are encrypted in owner-only vault files",
    requiresBrowser: true,
    async run(ctx) {
      const { secret, record, site } = await savedLogin(ctx);
      const accounts = result(await ctx.run("return credentials.list({text: 'E2E account', category: 'login'});"));
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].id, record.id);
      assert.equal(accounts[0].origin, site.origin);
      assert.equal(accounts[0].username, "fixture-user");
      for (const key of ["secret", "password", "fields", "notes"]) assert.equal(Object.hasOwn(accounts[0], key), false);
      const listed = await ctx.json(["vault", "list", "--json"]);
      const shown = await ctx.json(["vault", "show", record.id, "--json"]);
      const audit = await ctx.json(["vault", "audit", "--json"]);
      excludesSecret([listed, shown, audit], secret);
      assert.equal(listed.credentials.length, 1);
      assert.equal(listed.credentials[0].id, record.id);
      const root = path.join(ctx.home, "vault");
      const encrypted = await readFile(path.join(root, "vault.enc"));
      assert.equal(encrypted.includes(Buffer.from(secret)), false);
      assert.equal((await readFile(path.join(root, "audit.jsonl"), "utf8")).includes(secret), false);
      assert.equal((await stat(root)).mode & 0o077, 0);
      for (const file of ["vault.key", "vault.enc", "audit.jsonl"]) {
        assert.equal((await stat(path.join(root, file))).mode & 0o077, 0);
      }
      const refused = await ctx.command(["vault", "show", record.id, "--reveal"]);
      assert.equal(refused.code, 1);
      excludesSecret(refused, secret);
      assert.match(refused.stderr, /terminal|TTY/i);
    },
  },
  {
    id: "security.credential-fill-submit",
    group: "security",
    title: "Inspect and trusted fill omit secrets and submit only on an explicit request",
    requiresBrowser: true,
    async run(ctx) {
      const { secret, record, site } = await savedLogin(ctx);
      const inspection = result(await ctx.run("return credentials.inspect();"));
      assert.equal(inspection.status, "ready");
      assert.equal(inspection.fields.password.autocomplete, "current-password");
      excludesSecret(inspection, secret);
      const filled = await ctx.run(`return credentials.fill({id: ${JSON.stringify(record.id)}});`);
      assert.deepEqual(result(filled).filled, ["username", "password"]);
      assert.equal(result(filled).submitted, false);
      excludesSecret(filled, secret);
      assert.deepEqual(result(await ctx.run(`return page.evaluate(() => ({
        username: document.querySelector('#username').value,
        length: document.querySelector('#password').value.length, submits: window.submits,
      }));`)), { username: "fixture-user", length: secret.length, submits: 0 });
      assert.equal(site.state.submissions, 0);
      const submitted = await ctx.run(`
        const fill = await credentials.fill({id: ${JSON.stringify(record.id)}, submit: true});
        await page.getByRole('heading', {name: 'Signed in'}).waitFor();
        return {fill, heading: await page.locator('#status').textContent()};
      `);
      assert.equal(result(submitted).fill.submitted, true);
      assert.equal(result(submitted).heading, "Signed in");
      assert.equal(site.state.accepted, 1);
      assert.equal(site.state.rejected, 0);
      excludesSecret(submitted, secret);
    },
  },
  {
    id: "security.credential-output-redaction",
    group: "security",
    title: "Handled secrets are scrubbed from result values, keys, console history, and errors",
    requiresBrowser: true,
    async run(ctx) {
      const { secret, record } = await savedLogin(ctx);
      const envelope = await ctx.run(`
        await credentials.fill({id: ${JSON.stringify(record.id)}});
        const value = await page.locator('#password').inputValue();
        console.log('synthetic secret', value);
        const consoleReady = page.waitForEvent('console', {
          predicate: message => message.type() === 'warning' && message.text().startsWith('e2e-redaction:'),
          timeout: 5000,
        });
        await page.evaluate(() => console.warn('e2e-redaction:' + document.querySelector('#password').value));
        const observed = (await consoleReady).text();
        return {value, observed, nested: [{password: value}], [value]: value,
          history: (await page.consoleMessages()).map(message => message.text())};
      `);
      const value = result(envelope);
      excludesSecret(envelope, secret);
      assert.match(value.value, /redact/i, "the returned DOM password must be redacted");
      assert.ok((envelope.console || []).length >= 1, "snippet console output must be captured");
      assert.match(JSON.stringify(envelope.console), /redact/i, "snippet console output must redact the password");
      assert.match(value.observed, /e2e-redaction:.*redact/i, "the observed page console event must redact the password");
      assert.ok(value.history.some((line) => /e2e-redaction:.*redact/i.test(line)), "page console history must contain the synchronized redacted warning");
      const error = await ctx.run("throw new Error('credential-error:' + await page.locator('#password').inputValue());");
      denied(error, /credential-error:.*redact/i);
      excludesSecret(error, secret);
      assert.equal(result(await ctx.run("return page.locator('#password').evaluate(element => element.value.length);")), secret.length);
    },
  },
  {
    id: "security.credential-exact-origin",
    group: "security",
    title: "Exact-origin credentials cannot fill another hostname or port and recover at the original site",
    requiresBrowser: true,
    async run(ctx) {
      const { record, site, secret } = await savedLogin(ctx);
      const other = await credentialSite(ctx, secret);
      for (const origin of [site.alternateOrigin, other.origin]) {
        const listed = await ctx.run(`await page.goto(${JSON.stringify(`${origin}/login`)}); return credentials.list();`);
        assert.deepEqual(result(listed), []);
        denied(await ctx.run(`await credentials.fill({id: ${JSON.stringify(record.id)}, submit: true});`), /match|not found|available|scope/i);
        assert.equal(result(await ctx.run("return page.locator('#password').inputValue();")), "");
      }
      assert.equal(site.state.submissions, 0);
      assert.equal(other.state.submissions, 0);
      const recovered = await ctx.run(`
        await page.goto(${JSON.stringify(`${site.origin}/login`)});
        await credentials.fill({id: ${JSON.stringify(record.id)}, submit: true});
        await page.getByRole('heading', {name: 'Signed in'}).waitFor(); return true;
      `);
      assert.equal(result(recovered), true);
      assert.equal(site.state.accepted, 1);
      excludesSecret(recovered, secret);
    },
  },
  {
    id: "security.credential-host-and-never",
    group: "security",
    title: "Host matching permits a second port while never-matching records remain metadata-only",
    requiresBrowser: true,
    async run(ctx) {
      const { record, secret } = await savedLogin(ctx, "host");
      const other = await credentialSite(ctx, secret);
      const filled = await ctx.run(`
        await page.goto(${JSON.stringify(`${other.origin}/login`)});
        await credentials.fill({id: ${JSON.stringify(record.id)}, submit: true});
        await page.getByRole('heading', {name: 'Signed in'}).waitFor();
        return credentials.save({username: 'never-user', password: ${JSON.stringify(secret)}, matchMode: 'never'});
      `);
      const never = result(filled);
      assert.equal(other.state.accepted, 1);
      const accounts = result(await ctx.run("return credentials.list();"));
      assert.deepEqual(accounts.map((account) => account.id), [record.id]);
      result(await ctx.run("await page.locator('#password').fill(''); return true;"));
      denied(await ctx.run(`await credentials.fill({id: ${JSON.stringify(never.id)}});`), /match|not found|available|scope/i);
      assert.equal(result(await ctx.run("return page.locator('#password').inputValue();")), "");
      const owner = await ctx.json(["vault", "list", "--json"]);
      assert.equal(owner.credentials.length, 2);
      assert.ok(owner.credentials.some((account) => account.id === never.id));
      excludesSecret(owner, secret);
    },
  },
  {
    id: "security.credential-overwrite-metadata",
    group: "security",
    title: "Snippet secret overwrites fail while metadata updates and removal still work",
    requiresBrowser: true,
    async run(ctx) {
      const { record, secret, site } = await savedLogin(ctx);
      const replacement = syntheticSecret(ctx);
      for (const code of [
        `await credentials.save({username: 'fixture-user', password: ${JSON.stringify(replacement)}});`,
        `await credentials.update({id: ${JSON.stringify(record.id)}, password: ${JSON.stringify(replacement)}});`,
        `await credentials.update({id: ${JSON.stringify(record.id)}, notes: ${JSON.stringify(replacement)}});`,
      ]) {
        const blocked = await ctx.run(code);
        denied(blocked, /overwrite|replace|secret|rotation|generateAndFill/i);
        excludesSecret(blocked, replacement);
      }
      const metadata = result(await ctx.run(`return credentials.update({id: ${JSON.stringify(record.id)}, label: 'Renamed fixture'});`));
      assert.equal(metadata.label, "Renamed fixture");
      const filled = await ctx.run(`
        await credentials.fill({id: ${JSON.stringify(record.id)}, submit: true});
        await page.getByRole('heading', {name: 'Signed in'}).waitFor();
        return credentials.remove({id: ${JSON.stringify(record.id)}});
      `);
      result(filled);
      excludesSecret(filled, secret);
      assert.equal(site.state.accepted, 1);
      assert.deepEqual(result(await ctx.run("return credentials.list();")), []);
      assert.deepEqual((await ctx.json(["vault", "list", "--json"])).credentials, []);
    },
  },
  {
    id: "security.credential-errors-recovery",
    group: "security",
    title: "Missing site, missing record, and ambiguous account errors leave forms unchanged",
    requiresBrowser: true,
    async run(ctx) {
      denied(await ctx.run("return credentials.list();"), /HTTP|origin|site|navigate/i);
      const { record, site, secret } = await savedLogin(ctx);
      denied(await ctx.run("await credentials.fill({id: 'e2e-missing-record'});"), /match|not found|available/i);
      const second = syntheticSecret(ctx);
      result(await ctx.run(`return credentials.save({username: 'other-user', password: ${JSON.stringify(second)}});`));
      denied(await ctx.run("await credentials.fill({});"), /multiple|ambiguous|select|specify/i);
      assert.deepEqual(result(await ctx.run(`return page.evaluate(() => [
        document.querySelector('#username').value, document.querySelector('#password').value, window.submits,
      ]);`)), ["", "", 0]);
      const recovered = await ctx.run(`
        await credentials.fill({id: ${JSON.stringify(record.id)}, submit: true});
        await page.getByRole('heading', {name: 'Signed in'}).waitFor(); return true;
      `);
      assert.equal(result(recovered), true);
      excludesSecret(recovered, secret);
      assert.equal(site.state.accepted, 1);
    },
  },
  {
    id: "security.credential-ambiguous-form",
    group: "security",
    title: "Ambiguous forms fail closed and explicit selectors fill only the selected form",
    requiresBrowser: true,
    async run(ctx) {
      const { record, site, secret } = await savedLogin(ctx);
      result(await ctx.run(`await page.goto(${JSON.stringify(`${site.origin}/ambiguous`)}); return true;`));
      denied(await ctx.run(`await credentials.fill({id: ${JSON.stringify(record.id)}});`), /ambiguous|multiple|selector|form/i);
      assert.deepEqual(result(await ctx.run("return page.locator('input[type=password]').evaluateAll(inputs => inputs.map(input => input.value.length));")), [0, 0]);
      const filled = await ctx.run(`
        await credentials.fill({id: ${JSON.stringify(record.id)}, usernameSelector: '#username-two', passwordSelector: '#password-two'});
        return page.locator('input[type=password]').evaluateAll(inputs => inputs.map(input => input.value.length));
      `);
      assert.deepEqual(result(filled), [0, secret.length]);
      assert.equal(site.state.submissions, 0);
      excludesSecret(filled, secret);
    },
  },
  {
    id: "security.generated-commit",
    group: "security",
    title: "Generated credentials remain pending until verified signup success and explicit commit",
    requiresBrowser: true,
    async run(ctx) {
      const site = await credentialSite(ctx);
      const generated = result(await ctx.run(`
        await page.goto(${JSON.stringify(`${site.origin}/signup`)});
        return credentials.generateAndFill({username: 'generated-user', matchMode: 'exact-origin'});
      `));
      assert.ok(generated.pendingId);
      assert.equal(generated.expired, false);
      assert.equal(generated.origin, site.origin);
      assert.equal(generated.matchMode, "exact-origin");
      assert.equal(Object.hasOwn(generated, "secret"), false);
      const state = result(await ctx.run(`return {
        accounts: await credentials.list(), pending: await credentials.listPending(),
        form: await page.evaluate(() => ({length: document.querySelector('#password').value.length,
          matches: document.querySelector('#password').value === document.querySelector('#confirm').value,
          submits: window.submits})),
      };`));
      assert.deepEqual(state.accounts, []);
      assert.equal(state.pending.length, 1);
      assert.equal(state.pending[0].pendingId, generated.pendingId);
      assert.ok(state.form.length >= 16);
      assert.equal(state.form.matches, true);
      assert.equal(state.form.submits, 0);
      denied(await ctx.run("await credentials.fill({username: 'generated-user'});"), /match|not found|available|form|password/i);
      const committed = result(await ctx.run(`
        await page.getByRole('button', {name: 'Create account'}).click();
        await page.getByRole('heading', {name: 'Account created'}).waitFor();
        return credentials.commitGenerated({pendingId: ${JSON.stringify(generated.pendingId)}});
      `));
      assert.equal(committed.committed, true);
      assert.equal(site.state.accepted, 1);
      assert.deepEqual(result(await ctx.run("return credentials.listPending();")), []);
      const accounts = result(await ctx.run("return credentials.list();"));
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].username, "generated-user");
      assert.equal(accounts[0].matchMode, "exact-origin");
      const login = await ctx.run(`
        await page.goto(${JSON.stringify(`${site.origin}/login`)});
        await credentials.fill({id: ${JSON.stringify(accounts[0].id)}, submit: true});
        await page.getByRole('heading', {name: 'Signed in'}).waitFor(); return true;
      `);
      assert.equal(result(login), true);
      assert.equal(site.state.accepted, 2);
    },
  },
  {
    id: "security.generated-discard",
    group: "security",
    title: "Discard removes only the requested pending credential and invalid finalization is recoverable",
    requiresBrowser: true,
    async run(ctx) {
      const site = await credentialSite(ctx);
      const generated = result(await ctx.run(`
        await page.goto(${JSON.stringify(`${site.origin}/signup`)});
        return credentials.generateAndFill({username: 'discard-user', matchMode: 'exact-origin'});
      `));
      denied(await ctx.run("await credentials.commitGenerated({});"), /pendingId/i);
      denied(await ctx.run("await credentials.discardGenerated({pendingId: 'missing-pending-id'});"), /pending|not found/i);
      const pending = result(await ctx.run("return credentials.listPending();"));
      assert.deepEqual(pending.map((entry) => entry.pendingId), [generated.pendingId]);
      const discarded = result(await ctx.run(`return credentials.discardGenerated({pendingId: ${JSON.stringify(generated.pendingId)}});`));
      assert.equal(discarded.discarded, true);
      assert.deepEqual(result(await ctx.run("return {accounts: await credentials.list(), pending: await credentials.listPending()};")), { accounts: [], pending: [] });
      denied(await ctx.run(`await credentials.commitGenerated({pendingId: ${JSON.stringify(generated.pendingId)}});`), /pending|not found/i);
      assert.equal(site.state.submissions, 0);
      const owner = await ctx.json(["vault", "list", "--json"]);
      assert.deepEqual(owner.credentials, []);
      assert.deepEqual(owner.pendingCredentials, []);
    },
  },
  {
    id: "security.generated-error-recovery",
    group: "security",
    title: "A failed post-generation snippet retains recoverable pending metadata across sessions",
    requiresBrowser: true,
    async run(ctx) {
      const site = await credentialSite(ctx);
      const failed = await ctx.run(`
        await page.goto(${JSON.stringify(`${site.origin}/signup`)});
        await credentials.generateAndFill({username: 'recover-user', matchMode: 'exact-origin'});
        throw new Error('synthetic post-generation failure');
      `);
      denied(failed, /synthetic post-generation failure/);
      assert.ok(failed.pendingCredential?.pendingId);
      const pendingId = failed.pendingCredential.pendingId;
      const recovered = result(await ctx.run(`
        await page.goto(${JSON.stringify(`${site.origin}/signup`)});
        return {pending: await credentials.listPending(), active: await credentials.list()};
      `, { session: "pending-recovery" }));
      assert.deepEqual(recovered.active, []);
      assert.deepEqual(recovered.pending.map((entry) => entry.pendingId), [pendingId]);
      assert.equal(Object.hasOwn(recovered.pending[0], "secret"), false);
      const discarded = result(await ctx.run(`return credentials.discardGenerated({pendingId: ${JSON.stringify(pendingId)}});`, { session: "pending-recovery" }));
      assert.equal(discarded.discarded, true);
      assert.deepEqual(result(await ctx.run("return credentials.listPending();")), []);
      assert.equal(site.state.submissions, 0);
    },
  },
  {
    id: "security.generated-rotation",
    group: "security",
    title: "Generated rotation fills the current secret and preserves the existing record and scope",
    requiresBrowser: true,
    async run(ctx) {
      const { record, site, secret } = await savedLogin(ctx);
      const generated = await ctx.run(`
        await page.goto(${JSON.stringify(`${site.origin}/rotate`)});
        return credentials.generateAndFill({id: ${JSON.stringify(record.id)}});
      `);
      const pending = result(generated);
      excludesSecret(generated, secret);
      const state = result(await ctx.run(`return page.evaluate(() => ({
        currentLength: document.querySelector('#current').value.length,
        newLength: document.querySelector('#password').value.length,
        changed: document.querySelector('#current').value !== document.querySelector('#password').value,
        matches: document.querySelector('#password').value === document.querySelector('#confirm').value,
      }));`));
      assert.equal(state.currentLength, secret.length);
      assert.ok(state.newLength >= 16);
      assert.equal(state.changed, true);
      assert.equal(state.matches, true);
      const committed = result(await ctx.run(`
        await page.getByRole('button', {name: 'Change password'}).click();
        await page.getByRole('heading', {name: 'Password changed'}).waitFor();
        return credentials.commitGenerated({pendingId: ${JSON.stringify(pending.pendingId)}});
      `));
      assert.equal(committed.committed, true);
      assert.equal(committed.id, record.id);
      assert.equal(site.state.accepted, 1);
      const accounts = result(await ctx.run("return credentials.list();"));
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].id, record.id);
      assert.equal(accounts[0].matchMode, "exact-origin");
      assert.equal(accounts[0].origin, site.origin);
      assert.deepEqual(result(await ctx.run("return credentials.listPending();")), []);
    },
  },
  {
    id: "security.concurrent-download-approval",
    group: "security",
    title: "Concurrent CLI sessions do not share a per-run download approval",
    requiresBrowser: true,
    async run(ctx) {
      const site = await credentialSite(ctx);
      await Promise.all(["approved", "unapproved"].map(async (session) => {
        const opened = await ctx.run(`
          await page.goto(${JSON.stringify(site.origin)});
          await page.evaluate(value => window.sessionMarker = value, ${JSON.stringify(session)});
          return page.title();
        `, { session });
        assert.equal(result(opened), "Security fixture");
      }));
      const [approved, unapproved] = await Promise.all([
        ctx.run(`await page.locator('#download').click(); await page.waitForTimeout(1400);
          return page.evaluate(() => window.sessionMarker);`, { session: "approved", args: ["--approve-downloads"] }),
        ctx.run(`await page.waitForTimeout(200); await page.locator('#download').click();
          await page.waitForTimeout(800); return page.evaluate(() => window.sessionMarker);`, { session: "unapproved" }),
      ]);
      assert.equal(result(approved), "approved");
      assert.equal(result(unapproved), "unapproved");
      const files = (approved.artifacts || []).filter((artifact) => artifact.kind === "download");
      assert.equal(files.length, 1);
      assert.equal((unapproved.artifacts || []).filter((artifact) => artifact.kind === "download").length, 0);
      assert.equal(await readFile(files[0].path, "utf8"), "local security download fixture");
      assert.ok((site.state.requests.get("/download") || 0) >= 2);
      const artifactRoot = path.join(ctx.home, "artifacts");
      await mkdir(artifactRoot, { recursive: true });
      const entries = await readdir(artifactRoot, { recursive: true, withFileTypes: true });
      const retained = entries.filter((entry) => entry.isFile());
      assert.equal(retained.length, 1, "only the approved session may retain downloaded bytes");
      const later = await ctx.run("await page.locator('#download').click(); await page.waitForTimeout(400); return true;", { session: "approved" });
      assert.equal(result(later), true);
      assert.equal((later.artifacts || []).filter((artifact) => artifact.kind === "download").length, 0);
    },
  },
];
