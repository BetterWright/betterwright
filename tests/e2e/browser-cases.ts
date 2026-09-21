import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  animationHtml,
  checkboxHtml,
  documentHtml,
  formHtml,
  gridHtml,
  serveBrowserFixture,
} from "./browser-fixtures.js";
import type { E2ECase, E2EContext } from "./types.js";

function browserCase(id: string, title: string, run: E2ECase["run"]): E2ECase {
  return { id: `browser.${id}`, group: "browser", title, requiresBrowser: true, run };
}

function result(envelope: any): any {
  assert.equal(envelope.ok, true, envelope.error);
  return envelope.result;
}

function rejected(envelope: any, pattern: RegExp): void {
  assert.equal(envelope.ok, false);
  assert.match(envelope.error, pattern);
}

async function png(file: string): Promise<{ width: number; height: number }> {
  const bytes = await readFile(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(bytes.subarray(12, 16).toString(), "IHDR");
  const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  assert.ok(dimensions.width > 0 && dimensions.height > 0);
  return dimensions;
}

function encoder(ctx: E2EContext, codecs: string[]): string {
  const executable = process.env.BETTERWRIGHT_FFMPEG_PATH || "ffmpeg";
  const probe = spawnSync(executable, ["-encoders"], { encoding: "utf8", timeout: 5_000 });
  if (probe.error || probe.status !== 0) ctx.skip("FFmpeg is unavailable; recording requires an installed encoder");
  for (const codec of codecs) {
    if (!new RegExp(`\\b${codec}\\b`).test(probe.stdout)) ctx.skip(`FFmpeg lacks required ${codec} encoder`);
  }
  return executable;
}

function decodeVideo(executable: string, file: string): string[] {
  const decoded = spawnSync(executable, ["-v", "error", "-i", file, "-f", "framemd5", "-"], {
    encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(decoded.status, 0, decoded.stderr);
  const hashes = decoded.stdout.split("\n").filter(line => /^\d+,/.test(line)).map(line => line.split(",").at(-1)?.trim());
  assert.ok(hashes.length > 1, "recording must decode to multiple frames");
  return hashes.filter((hash): hash is string => hash !== undefined);
}

export const cases: E2ECase[] = [
  browserCase("navigation-history", "Navigation follows redirects, reloads, and traverses history", async ctx => {
    let visits = 0;
    const server = await serveBrowserFixture(ctx, {
      "/": documentHtml('<h1>First page</h1><a href="/redirect">Continue</a>', "First"),
      "/redirect": (_request, response) => { response.writeHead(302, { location: "/second" }).end(); },
      "/second": (_request, response) => {
        visits++;
        response.setHeader("content-type", "text/html");
        response.end(documentHtml(`<h1>Second page</h1><p id="visits">${visits}</p>`, "Second"));
      },
    });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)}, {timeout:5000});
      await page.getByRole('link', {name:'Continue'}).click({timeout:5000});
      await page.waitForURL('**/second', {timeout:5000});
      const second = {title: await page.title(), url: page.url()};
      await page.goBack({timeout:5000});
      const back = await page.title();
      await page.goForward({timeout:5000});
      await page.reload({timeout:5000});
      return {second, back, current: await page.title(), visits: Number(await page.locator('#visits').innerText())};
    `));
    assert.deepEqual(actual.second, { title: "Second", url: `${server.origin}/second` });
    assert.equal(actual.back, "First");
    assert.equal(actual.current, "Second");
    assert.ok(actual.visits >= 2);
  }),

  browserCase("dom-ready", "Default navigation does not wait for stalled subresources", async ctx => {
    const server = await serveBrowserFixture(ctx, {
      "/": documentHtml('<h1>Ready before image load</h1><img src="/pending.png" alt="Pending fixture">'),
      "/pending.png": (_request, _response) => {},
    });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)}, {timeout: 3000});
      return {heading: await page.locator('h1').innerText(), loaded: await page.evaluate(() => document.readyState)};
    `));
    assert.equal(actual.heading, "Ready before image load");
    assert.equal(actual.loaded, "interactive");
  }),

  browserCase("forms", "Form locators update live values and submit once", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": formHtml });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      await page.getByLabel('Display name').fill('Ada');
      await page.getByLabel('Plan', {exact:true}).selectOption('pro');
      await page.getByLabel('Accept terms').check();
      await page.getByLabel('Notes').fill('Updated notes');
      await page.getByRole('button', {name:'Create account'}).click();
      return {status: await page.getByRole('status').innerText(), notes: await page.getByLabel('Notes').inputValue(), submissions: await page.evaluate(() => window.submissions)};
    `));
    assert.deepEqual(actual, { status: "Created Ada on pro; terms=true", notes: "Updated notes", submissions: 1 });
  }),

  browserCase("human-unicode", "Human helpers preserve Unicode, append text, click, and scroll", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml(`
      <label>Message <input id="message" value="replace me"></label><button id="save">Save</button><p role="status"></p>
      <div style="height:2400px"></div>
      <script>document.querySelector('#save').onclick=()=>document.querySelector('[role=status]').textContent=document.querySelector('#message').value</script>
    `) });
    const text = "Café 日本語 🧪 مرحبا";
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      await human.type('#message', ${JSON.stringify(text)}, {minDelay:0, maxDelay:0});
      await human.type(page.getByLabel('Message'), ' + done', {clear:false, minDelay:0, maxDelay:0});
      await human.click(page.getByRole('button', {name:'Save'}));
      await human.scroll(600, {steps:4});
      await page.waitForFunction(() => window.scrollY > 0);
      return {value: await page.getByLabel('Message').inputValue(), status: await page.getByRole('status').innerText(), scrolled: await page.evaluate(() => window.scrollY > 0)};
    `));
    assert.deepEqual(actual, { value: `${text} + done`, status: `${text} + done`, scrolled: true });
  }),

  browserCase("rich-text", "Human typing recovers when a rich editor swallows key events", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml(`
      <div id="editor" contenteditable="true" role="textbox" aria-label="Editor" style="min-height:60px">Draft</div>
      <script>document.querySelector('#editor').addEventListener('keydown', event => { if (event.key.length === 1) event.preventDefault(); });</script>
    `) });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      await human.type('#editor', ' + café', {clear:false, minDelay:0, maxDelay:0});
      return page.getByRole('textbox', {name:'Editor'}).innerText();
    `));
    assert.equal(actual, "Draft + café");
  }),

  browserCase("human-append-fields", "Normal human typing appends at the end of inputs and multiline editors", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml(`
      <label>Single line <input id="single" value="Original text"></label>
      <label>Multiline <textarea id="multiline">First line\nSecond line</textarea></label>
      <label>Email <input id="email" type="email" value="reader@example"></label>
      <div id="editable" role="textbox" aria-label="Rich draft" contenteditable="true" style="min-height:80px"><div>First line</div><div>Second line</div></div>
    `) });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      await human.type('#single', ' appended', {clear:false,minDelay:10,maxDelay:10});
      await human.type('#multiline', ' appended', {clear:false,minDelay:10,maxDelay:10});
      await human.type('#email', '.test', {clear:false,minDelay:10,maxDelay:10});
      await human.type('#editable', ' appended', {clear:false,minDelay:10,maxDelay:10});
      return {single:await page.locator('#single').inputValue(), multiline:await page.locator('#multiline').inputValue(), email:await page.locator('#email').inputValue(), editable:await page.locator('#editable').innerText()};
    `));
    assert.deepEqual(actual, {
      single: "Original text appended",
      multiline: "First line\nSecond line appended",
      email: "reader@example.test",
      editable: "First line\nSecond line appended",
    });
  }),

  browserCase("frames", "Frame locators and frame-scoped batches reach cross-origin content", async ctx => {
    const server = await serveBrowserFixture(ctx, {
      "/": (_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end(documentHtml(`<iframe name="billing" title="Billing" src="${server.alternateOrigin}/frame"></iframe>`));
      },
      "/frame": documentHtml('<label>Region <select><option>US</option><option>EU</option></select></label><button onclick="this.textContent=\'Saved\'">Save region</button>'),
    });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      const frame = page.frameLocator('iframe');
      await frame.getByLabel('Region').selectOption({label:'EU'});
      await frame.getByRole('button', {name:'Save region'}).click();
      const batch = await controls.batch([{id:'region', action:'read', target:{frameName:'billing', label:'Region'}}]);
      return {batch, tree: await snapshot({interactive:true}), saved: await frame.getByRole('button').innerText()};
    `));
    assert.equal(actual.batch.results.region.value, "EU");
    assert.equal(actual.saved, "Saved");
    assert.match(actual.tree, /Saved/);
    assert.match(actual.tree, /ref=f\d+e\d+/);
  }),

  browserCase("shadow-dom", "Locators and semantic controls reach an open shadow root", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml(`
      <div id="host"></div><script>
        const root = document.querySelector('#host').attachShadow({mode:'open'});
        root.innerHTML = '<label>Shadow name <input></label><button>Save shadow</button><p role="status">Waiting</p>';
        root.querySelector('button').onclick = () => root.querySelector('[role=status]').textContent = 'Saved ' + root.querySelector('input').value;
      </script>
    `) });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      await page.getByLabel('Shadow name').fill('Root');
      await page.getByRole('button', {name:'Save shadow'}).click();
      return {status: await page.getByRole('status').innerText(), batch: await controls.batch([{id:'name',action:'read',target:{label:'Shadow name'},value:'Root'}])};
    `));
    assert.equal(actual.status, "Saved Root");
    assert.equal(actual.batch.results.name.value, "Root");
  }),

  browserCase("tabs", "Tab handles switch the active page and close only the selected tab", async ctx => {
    const server = await serveBrowserFixture(ctx, {
      "/": documentHtml("<h1>First</h1>", "First"),
      "/second": documentHtml("<h1>Second</h1>", "Second"),
    });
    const envelope = await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      const first = page;
      const second = await openPage(${JSON.stringify(`${server.origin}/second`)});
      const count = pages.length;
      await usePage(second);
      const active = await page.title();
      await usePage(first);
      await closePage(second);
      return {count, active, remaining: pages.length, title: await page.title()};
    `);
    assert.deepEqual(result(envelope), { count: 2, active: "Second", remaining: 1, title: "First" });
    assert.equal(envelope.pages.filter((entry: any) => entry.active).length, 1);
    assert.equal(envelope.pages.find((entry: any) => entry.active).title, "First");
  }),

  browserCase("popup", "Target-blank popups are adopted into the session", async ctx => {
    const server = await serveBrowserFixture(ctx, {
      "/": documentHtml('<a href="/popup" target="_blank">Open popup</a>', "Parent"),
      "/popup": documentHtml("<h1>Popup ready</h1>", "Popup"),
    });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      const waiting = page.waitForEvent('popup');
      await page.getByRole('link', {name:'Open popup'}).click();
      const popup = await waiting;
      await popup.getByRole('heading', {name:'Popup ready'}).waitFor();
      await usePage(popup);
      const title = await page.title();
      const count = pages.length;
      await closePage();
      return {title, count, remaining: pages.length, parent: await page.title()};
    `));
    assert.deepEqual(actual, { title: "Popup", count: 2, remaining: 1, parent: "Parent" });
  }),

  browserCase("dialogs", "Prepared dialog responses accept prompts and dismiss confirmations", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml(`
      <button id="prompt" onclick="document.querySelector('output').textContent=prompt('Name?','default')">Prompt</button>
      <button id="confirm" onclick="document.querySelector('output').textContent=String(confirm('Continue?'))">Confirm</button>
      <button id="alert" onclick="alert('Notice');document.querySelector('output').textContent='Alert closed'">Alert</button><output></output>
    `) });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      dialogs.acceptNext('Zoë');
      await page.locator('#prompt').click();
      const prompt = await page.locator('output').innerText();
      dialogs.dismissNext();
      await page.locator('#confirm').click();
      const confirm = await page.locator('output').innerText();
      dialogs.acceptNext();
      await page.locator('#alert').click();
      return {prompt, confirm, alert: await page.locator('output').innerText()};
    `));
    assert.deepEqual(actual, { prompt: "Zoë", confirm: "false", alert: "Alert closed" });
  }),

  browserCase("persistent-session", "State, DOM, and session storage persist across binary invocations", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": formHtml });
    result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      state.counter = 41;
      await page.getByLabel('Display name').fill('Unsubmitted draft');
      await page.evaluate(() => sessionStorage.setItem('draft', 'saved'));
      return page.title();
    `, { session: "persistent" }));
    assert.deepEqual(result(await ctx.run(`return {
      counter: ++state.counter, draft: await page.getByLabel('Display name').inputValue(),
      storage: await page.evaluate(() => sessionStorage.getItem('draft')), pages: pages.length
    }`, { session: "persistent" })), { counter: 42, draft: "Unsubmitted draft", storage: "saved", pages: 1 });
  }),

  browserCase("session-isolation", "Sessions isolate tabs and state while sharing profile cookies", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml("<h1>Shared identity</h1>") });
    result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)}); state.owner = 'alpha';
      await page.evaluate(() => { document.cookie = 'shared=alpha; Path=/'; sessionStorage.setItem('owner', 'alpha'); });
      return page.url();
    `, { session: "alpha" }));
    const beta = result(await ctx.run(`
      const initialUrl = page.url(); await page.goto(${JSON.stringify(server.origin)});
      return {initialUrl, state: state.owner ?? null, cookie: await page.evaluate(() => document.cookie), storage: await page.evaluate(() => sessionStorage.getItem('owner'))};
    `, { session: "beta" }));
    assert.equal(beta.initialUrl, "about:blank");
    assert.equal(beta.state, null);
    assert.equal(beta.storage, null);
    assert.match(beta.cookie, /shared=alpha/);
    assert.equal(result(await ctx.run("return state.owner", { session: "alpha" })), "alpha");
  }),

  browserCase("profiles", "Named profiles keep separate cookie and local-storage identities", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml("<h1>Profile</h1>") });
    for (const profile of ["alice", "bob"]) {
      const actual = result(await ctx.run(`
        await page.goto(${JSON.stringify(server.origin)});
        const before = await page.evaluate(() => ({cookie:document.cookie, storage:localStorage.getItem('owner')}));
        await page.evaluate(owner => {document.cookie='owner='+owner+'; Path=/';localStorage.setItem('owner',owner)}, ${JSON.stringify(profile)});
        return before;
      `, { profile }));
      assert.deepEqual(actual, { cookie: "", storage: null });
    }
    for (const profile of ["alice", "bob"]) {
      assert.deepEqual(result(await ctx.run("return page.evaluate(() => ({cookie:document.cookie, storage:localStorage.getItem('owner')}))", { profile })), {
        cookie: `owner=${profile}`, storage: profile,
      });
    }
  }),

  browserCase("cookie-restart", "Persistent cookies and local storage survive a clean daemon restart", async ctx => {
    let observedCookie = "";
    const server = await serveBrowserFixture(ctx, {
      "/": documentHtml("<h1>Persisted identity</h1>"),
      "/echo": (request, response) => {
        observedCookie = request.headers.cookie || "";
        response.setHeader("content-type", "text/plain");
        response.end(observedCookie);
      },
    });
    result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      await page.evaluate(() => {document.cookie='persistent=survives; Max-Age=3600; Path=/';localStorage.setItem('marker','survives')});
      state.volatile = true; return page.url();
    `, { profile: "restart" }));
    const closed = await ctx.command(["close", "--all"]);
    assert.equal(closed.code, 0, closed.stderr);
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      return {volatile: state.volatile ?? null, storage: await page.evaluate(() => localStorage.getItem('marker')), echo: await page.evaluate(() => fetch('/echo').then(response => response.text()))};
    `, { profile: "restart" }));
    assert.equal(actual.volatile, null);
    assert.equal(actual.storage, "survives");
    assert.match(actual.echo, /persistent=survives/);
    assert.match(observedCookie, /persistent=survives/);
  }),

  browserCase("snapshot-refs", "Snapshot refs are actionable and selector scopes exclude unrelated content", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml('<aside>Outside sentinel</aside><main id="main"><button onclick="this.textContent=\'Saved\'">Save record</button><a href="/target">Details</a></main>') });
    const initial = result(await ctx.run(`await page.goto(${JSON.stringify(server.origin)}); return snapshot({interactive:true});`));
    const ref = /button "Save record"[^\n]*\[ref=(e\d+)\]/.exec(initial)?.[1];
    assert.ok(ref, initial);
    const actual = result(await ctx.run(`
      await page.locator(${JSON.stringify(`aria-ref=${ref}`)}).click();
      return {scoped: await snapshot({selector:'#main', urls:true}), button: await page.getByRole('button').innerText()};
    `));
    assert.equal(actual.button, "Saved");
    assert.match(actual.scoped, /Saved/);
    assert.match(actual.scoped, /\/url: \/target/);
    assert.doesNotMatch(actual.scoped, /Outside sentinel/);
  }),

  browserCase("snapshot-diff", "Snapshot diffs distinguish unchanged and updated page state", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml('<p role="status">Pending</p><button onclick="document.querySelector(\'[role=status]\').textContent=\'Complete\'">Finish</button>') });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      const first = await snapshot({diff:true});
      const unchanged = await snapshot({diff:true});
      await page.getByRole('button', {name:'Finish'}).click();
      const changed = await snapshot({diff:true});
      return {first, unchanged, changed};
    `));
    assert.match(actual.first, /Pending/);
    assert.match(actual.unchanged, /no changes since previous snapshot/);
    assert.match(actual.changed, /\+.*Complete/);
    assert.match(actual.changed, /-.*Pending/);
  }),

  browserCase("snapshot-limits", "Oversized snapshots provide diagnostics and scoped retries recover", async ctx => {
    const items = Array.from({ length: 350 }, (_, index) => `<button>Record ${index} ${"detail ".repeat(8)}</button>`).join("");
    const server = await serveBrowserFixture(ctx, { "/": documentHtml(`<main>${items}</main><section id="small"><button>Only scoped control</button></section>`) });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      return {smallLimit: await snapshot({maxChars:1000}), capped: await snapshot({maxChars:100000}), scoped: await snapshot({selector:'#small', maxChars:1000})};
    `));
    assert.match(actual.smallLimit, /over the 1000 limit/i);
    assert.match(actual.smallLimit, /selector|ref/);
    assert.match(actual.capped, /20000|20,000/);
    assert.match(actual.scoped, /Only scoped control/);
    assert.doesNotMatch(actual.scoped, /Record 0/);
  }),

  browserCase("controls-inspect", "Control inspectors report checked, disabled, selected, and redacted values", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml(`
      <label>Account <input value="Ada"></label><label>Passphrase <input type="password" value="synthetic-password"></label>
      <label><input type="checkbox" checked> Enabled</label><label>Plan <select><option>Free</option><option selected>Pro</option></select></label>
      <label>Locked <input disabled value="locked"></label>
    `) });
    const actual = result(await ctx.run(`await page.goto(${JSON.stringify(server.origin)}); return {controls:await controls.inspect(), tree:await snapshot({interactive:true})};`));
    const controls = actual.controls.frames.flatMap((frame: any) => frame.controls);
    assert.ok(controls.some((control: any) => control.value === "Ada"));
    assert.ok(controls.some((control: any) => control.checked === true));
    assert.ok(controls.some((control: any) => control.value === "Pro"));
    assert.ok(controls.some((control: any) => control.disabled === true && control.value === "locked"));
    assert.ok(controls.some((control: any) => control.type === "password" && control.value === "[redacted]"));
    assert.doesNotMatch(JSON.stringify(actual), /synthetic-password/);
  }),

  browserCase("overlays", "Overlay dismissal rejects optional cookies and preserves task dialogs", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml(`
      <div role="dialog" aria-label="Cookie consent" style="position:fixed;inset:0;background:white;z-index:10">
        <p>Cookie consent: We use cookies for analytics and advertising</p>
        <button onclick="window.consent='all';this.parentElement.remove()">Accept all</button>
        <button onclick="window.consent='essential';this.parentElement.remove()">Essential cookies only</button>
      </div>
      <div role="dialog" aria-label="Delete record"><p>Delete this record?</p><button>Confirm deletion</button></div>
    `) });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)}); const dismissed = await overlays.dismiss();
      return {dismissed, consent: await page.evaluate(() => window.consent), taskDialog: await page.getByRole('dialog', {name:'Delete record'}).isVisible()};
    `));
    assert.equal(actual.consent, "essential");
    assert.equal(actual.taskDialog, true);
    assert.ok(actual.dismissed.dismissed.some((entry: any) => entry.kind === "cookie"));
  }),

  browserCase("media-inspect", "Media inspection identifies paused audio and video without external resources", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml('<h1>Local media</h1><video aria-label="Demo video" controls></video><audio aria-label="Demo audio" controls></audio>') });
    const actual = result(await ctx.run(`await page.goto(${JSON.stringify(server.origin)}); return media.inspect();`));
    const entries = actual.frames.flatMap((frame: any) => frame.media);
    for (const kind of ["video", "audio"]) {
      const entry = entries.find((item: any) => item.kind === kind);
      assert.ok(entry);
      assert.equal(entry.title, `Demo ${kind}`);
      assert.equal(entry.paused, true);
      assert.equal(entry.currentTime, 0);
    }
  }),

  browserCase("console-events", "Page console and errors are collected once without leaking listeners", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml('<script>console.warn("fixture-warning");throw new Error("fixture-boom")</script>') });
    const first = await ctx.run(`
      state.events = [];
      page.on('console', message => state.events.push({type:message.type(), text:message.text()}));
      page.once('pageerror', error => state.events.push({type:'pageerror', text:error.message}));
      await page.goto(${JSON.stringify(server.origin)});
      console.log('snippet-only');
      return state.events;
    `);
    const messages = result(first);
    assert.ok(messages.some((entry: any) => entry.type === "warning" && entry.text === "fixture-warning"));
    assert.ok(messages.some((entry: any) => entry.type === "pageerror" && entry.text === "fixture-boom"));
    assert.match(JSON.stringify(first.console), /snippet-only/);
    const next = result(await ctx.run("await page.evaluate(() => console.log('later-page-message')); return state.events;"));
    assert.deepEqual(next, messages);
  }),

  browserCase("console-history", "Console history is bounded and scoped to the current navigation", async ctx => {
    const server = await serveBrowserFixture(ctx, {
      "/": documentHtml('<script>console.warn("old-warning");throw new Error("old-error")</script>'),
      "/next": documentHtml('<script>console.info("new-navigation")</script>'),
    });
    result(await ctx.run(`await page.goto(${JSON.stringify(server.origin)}); await page.evaluate(() => {for(let i=0;i<220;i++)console.debug('noise-'+i)}); return true;`));
    const history = result(await ctx.run("return {count:(await page.consoleMessages()).length, errors:(await page.pageErrors()).map(error => error.message)};"));
    assert.ok(history.count > 0 && history.count <= 200);
    assert.ok(history.errors.includes("old-error"));
    const fresh = result(await ctx.run(`await page.goto(${JSON.stringify(`${server.origin}/next`)}); return {
      messages:(await page.consoleMessages({filter:'since-navigation'})).map(message => message.text()),
      errors:(await page.pageErrors({filter:'since-navigation'})).map(error => error.message)
    };`));
    assert.ok(fresh.messages.includes("new-navigation"));
    assert.ok(!fresh.messages.some((text: string) => /noise-|old-warning/.test(text)));
    assert.deepEqual(fresh.errors, []);
  }),

  browserCase("screenshots", "PNG and JPEG screenshots contain real image bytes and annotation metadata", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml('<h1>Screenshot proof</h1><button>Visible control</button><div style="height:1800px;background:linear-gradient(red,blue)"></div>') });
    const envelope = await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      return {plain:await screenshot({kind:'proof',name:'proof'}), annotated:await screenshot({name:'annotated.png',annotate:true}), jpeg:await screenshot({name:'full.jpg',type:'jpeg',fullPage:true,quality:70})};
    `);
    const actual = result(envelope);
    const dimensions = await png(actual.plain.path);
    assert.deepEqual(await png(actual.annotated.path), dimensions);
    assert.ok(actual.annotated.annotations >= 1);
    assert.equal(actual.plain.media, `MEDIA:${actual.plain.path}`);
    const jpeg = await readFile(actual.jpeg.path);
    assert.deepEqual([...jpeg.subarray(0, 3)], [255, 216, 255]);
    assert.deepEqual([...jpeg.subarray(-2)], [255, 217]);
    assert.equal(envelope.artifacts.length, 3);
    assert.ok(envelope.artifacts.every((artifact: any) => artifact.path.startsWith(`${ctx.home}${path.sep}`)));
  }),

  browserCase("artifact-paths", "Artifact names cannot escape the managed artifact directory", async ctx => {
    const escaped = path.join(ctx.workDir, "escaped.png");
    const envelope = await ctx.run(`await page.setContent('<h1>Bounded output</h1>'); return screenshot({name:${JSON.stringify(escaped)}});`);
    if (envelope.ok) {
      const artifact = result(envelope);
      assert.notEqual(artifact.path, escaped);
      assert.ok(artifact.path.startsWith(path.join(ctx.home, "artifacts") + path.sep));
      await png(artifact.path);
    } else {
      rejected(envelope, /artifact|filename|path|name/i);
    }
    await assert.rejects(stat(escaped), { code: "ENOENT" });
  }),

  browserCase("uploads", "Artifact uploads preserve bytes and reject host files outside the artifact root", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml('<label>Attachment <input type="file"></label>') });
    const allowed = path.join(ctx.home, "artifacts", "upload.txt");
    const denied = path.join(ctx.workDir, "outside.txt");
    await mkdir(path.dirname(allowed), { recursive: true });
    await writeFile(allowed, "uploaded café 日本語");
    await writeFile(denied, "outside fixture");
    rejected(await ctx.run(`await page.goto(${JSON.stringify(server.origin)}); await page.getByLabel('Attachment').setInputFiles(${JSON.stringify(denied)});`), /artifact directory/i);
    const actual = result(await ctx.run(`
      await page.getByLabel('Attachment').setInputFiles(${JSON.stringify(allowed)});
      return page.getByLabel('Attachment').evaluate(async element => ({name:element.files[0].name, text:await element.files[0].text(), count:element.files.length}));
    `));
    assert.deepEqual(actual, { name: "upload.txt", text: "uploaded café 日本語", count: 1 });
  }),

  browserCase("downloads", "Downloads require per-run approval and saved artifacts retain exact bytes", async ctx => {
    const body = "downloaded café 日本語\n";
    const server = await serveBrowserFixture(ctx, {
      "/": documentHtml('<a href="/report.txt" download>Download report</a>'),
      "/report.txt": (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-disposition": 'attachment; filename="report.txt"' });
        response.end(body);
      },
    });
    const code = `
      await page.goto(${JSON.stringify(server.origin)});
      const waiting = page.waitForEvent('download');
      await page.getByRole('link', {name:'Download report'}).click();
      const download = await waiting;
      return {name:download.suggestedFilename(), failure:await download.failure()};
    `;
    const blocked = await ctx.run(code);
    result(blocked);
    assert.equal((blocked.artifacts || []).filter((artifact: any) => artifact.kind === "download").length, 0);
    const approved = await ctx.run(code, { args: ["--approve-downloads"] });
    assert.deepEqual(result(approved), { name: "report.txt", failure: null });
    const files = (approved.artifacts || []).filter((artifact: any) => artifact.kind === "download");
    assert.equal(files.length, 1);
    assert.equal(await readFile(files[0].path, "utf8"), body);
    const revoked = await ctx.run(code);
    result(revoked);
    assert.equal((revoked.artifacts || []).filter((artifact: any) => artifact.kind === "download").length, 0);
  }),

  browserCase("ui-batch", "A semantic UI transaction verifies its exact live result", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": formHtml });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      return controls.batch({operations:[
        {id:'name',action:'fill',target:{label:'Display name'},value:'Ada'},
        {id:'plan',action:'select',target:{label:'Plan',exact:true},value:'pro'},
        {id:'terms',action:'check',target:{label:'Accept terms'}},
        {id:'submit',action:'click',target:{role:'button',name:'Create account',exact:true}},
        {id:'verify',action:'read',target:{role:'status'},value:'Created Ada on pro; terms=true'}
      ],allowWrites:true,minIntervalMs:0});
    `));
    assert.equal(actual.protocol, "ui-batch/1");
    assert.equal(actual.pageUpdated, true);
    assert.equal(actual.results.verify.text, "Created Ada on pro; terms=true");
    assert.equal(actual.results.terms.checked, true);
    assert.equal(result(await ctx.run("return page.evaluate(() => window.submissions)")), 1);
  }),

  browserCase("ui-batch-guards", "UI batches validate write authorization and ambiguity before acting", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml('<button onclick="window.clicks++">Save</button><button onclick="window.clicks++">Save</button><p role="status">Ready</p><script>window.clicks=0</script>') });
    result(await ctx.run(`await page.goto(${JSON.stringify(server.origin)}); return true;`));
    const operations = "[{id:'save',action:'click',target:{role:'button',name:'Save',exact:true}},{id:'verify',action:'read',target:{role:'status'},value:'Ready'}]";
    rejected(await ctx.run(`return controls.batch(${operations})`), /allowWrites:true/);
    rejected(await ctx.run(`return controls.batch(${operations}, {allowWrites:true})`), /matched 2 elements/);
    rejected(await ctx.run(`return controls.batch([{id:'save',action:'click',target:{role:'button',name:'Save',nth:0}},{id:'verify',action:'read',target:{role:'status'}}], {allowWrites:true})`), /non-empty expected value/);
    assert.equal(result(await ctx.run("return page.evaluate(() => window.clicks)")), 0);
  }),

  browserCase("ui-batch-stop", "A failed asserted read does not replay or continue completed writes", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml(`
      <button id="submit" onclick="window.submissions++;document.querySelector('#status').textContent='Order 42 confirmed'">Submit</button>
      <button id="later" onclick="window.later++">Later</button><p id="status">Waiting</p><p>Unrelated success</p>
      <script>window.submissions=0;window.later=0</script>
    `) });
    const envelope = await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      return controls.batch({operations:[
        {id:'submit',action:'click',target:{css:'#submit'}},
        {id:'wrong',action:'read',target:{css:'#status'},value:'Unrelated success'},
        {id:'later',action:'click',target:{css:'#later'}},
        {id:'verify',action:'read',target:{css:'#status'},value:'Order 42 confirmed'}
      ],allowWrites:true,minIntervalMs:0});
    `);
    rejected(envelope, /wrong|expected|Unrelated success/i);
    const actual = result(await ctx.run("return {status:await page.locator('#status').innerText(), counts:await page.evaluate(() => ({submissions:window.submissions,later:window.later}))}"));
    assert.deepEqual(actual, { status: "Order 42 confirmed", counts: { submissions: 1, later: 0 } });
  }),

  browserCase("site-tools", "Site tools discover assets and make cookie-bearing same-origin JSON requests", async ctx => {
    let requestBody: any;
    let requestCookie = "";
    const server = await serveBrowserFixture(ctx, {
      "/": documentHtml('<script src="/app.js"></script><h1>Site tools</h1>'),
      "/app.js": (_request, response) => {
        response.setHeader("content-type", "application/javascript");
        response.end('window.fixtureMarker = "asset-needle";');
      },
      "/api": (request, response) => {
        requestCookie = request.headers.cookie || "";
        let body = "";
        request.setEncoding("utf8");
        request.on("data", chunk => { body += chunk; });
        request.on("end", () => {
          requestBody = JSON.parse(body);
          response.writeHead(200, { "content-type": "application/json", "set-cookie": "returned=ready; Path=/; SameSite=Lax" });
          response.end(JSON.stringify({ received: requestBody, accepted: true }));
        });
      },
    });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      await page.evaluate(() => {document.cookie='client=present; Path=/'});
      return {assets:await site.assets(), requests:await site.requests({urlIncludes:'app.js'}), source:await site.read('/app.js',{find:'asset-needle',contextChars:40,maxMatches:1}), response:await site.request('/api',{method:'POST',json:{count:3},response:'json'}), cookie:await page.evaluate(() => document.cookie)};
    `));
    assert.match(JSON.stringify(actual.assets), /app\.js/);
    assert.match(JSON.stringify(actual.requests), /app\.js/);
    assert.match(JSON.stringify(actual.source), /asset-needle/);
    assert.equal(actual.response.status, 200);
    assert.deepEqual(actual.response.json, { received: { count: 3 }, accepted: true });
    assert.deepEqual(requestBody, { count: 3 });
    assert.match(requestCookie, /client=present/);
    assert.match(actual.cookie, /returned=ready/);
    rejected(await ctx.run(`return site.read(${JSON.stringify(`${server.alternateOrigin}/app.js`)})`), /origin/i);
  }),

  browserCase("webagents", "WebAgents discovery enforces write consent and refreshes workflow state", async ctx => {
    let status = "open";
    const workflows: any[] = [];
    const server = await serveBrowserFixture(ctx, {
      "/": (_request, response) => { response.setHeader("content-type", "text/html"); response.end(documentHtml(`<p role="status">${status}</p>`)); },
      "/webagents.md": (_request, response) => {
        response.setHeader("content-type", "text/markdown");
        response.end('```webagents\n{"version":"0.1","workflow":{"endpoint":"/workflow"},"actions":{"resolve":{"effect":"write"},"status":{"effect":"read"}}}\n```');
      },
      "/workflow": (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", chunk => { body += chunk; });
        request.on("end", () => {
          workflows.push(JSON.parse(body));
          status = "resolved";
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ status }));
        });
      },
    });
    const directory = result(await ctx.run(`await page.goto(${JSON.stringify(server.origin)}); return webagents.discover();`));
    assert.equal(directory.protocol, "webagents/0.1");
    assert.equal(directory.trust, "untrusted_external_data");
    assert.deepEqual(directory.actions.map((action: any) => action.name).sort(), ["resolve", "status"]);
    rejected(await ctx.run("return webagents.batch([{id:'resolve',action:'resolve',input:{}}])"), /allowWrites/i);
    assert.equal(workflows.length, 0);
    const actual = result(await ctx.run(`
      const batch = await webagents.batch([{id:'resolve',action:'resolve',input:{}},{id:'verify',action:'status',input:{}}], {allowWrites:true});
      return {batch, visible:await page.getByRole('status').innerText()};
    `));
    assert.equal(actual.batch.result.status, "resolved");
    assert.equal(actual.batch.pageUpdated, true);
    assert.equal(actual.visible, "resolved");
    assert.equal(workflows.length, 1);
    assert.deepEqual(workflows[0].operations[1].dependsOn, ["resolve"]);
  }),

  browserCase("webmcp", "WebMCP discovers and executes a real page-published tool", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": documentHtml(`
      <p role="status">Waiting</p><script>
        const modelContext = navigator.modelContext || document.modelContext;
        if (modelContext) modelContext.registerTool({
          name:'calculateSum',description:'Add two numbers',
          inputSchema:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b']},
          annotations:{readOnly:true},
          execute:({a,b})=>{document.querySelector('[role=status]').textContent='Invoked';return {sum:Number(a)+Number(b)}}
        });
      </script>
    `) });
    const available = result(await ctx.run(`await page.goto(${JSON.stringify(server.origin)}); return page.evaluate(() => Boolean(navigator.modelContext || document.modelContext));`));
    if (!available) ctx.skip("The selected browser does not expose the WebMCP registration API");
    const actual = result(await ctx.run(`
      const tools = await webmcp.tools({timeout:3000});
      const tool = tools.find(tool => tool.name === 'calculateSum');
      if (!tool) throw new Error('Registered calculateSum tool is missing');
      return {tool, invocation:await webmcp.invoke(tool.name,{a:19,b:23},{frameId:tool.frameId,timeout:5000}), visible:await page.getByRole('status').innerText()};
    `));
    assert.equal(actual.tool.trust, "untrusted_external_data");
    assert.equal(actual.invocation.status, "Completed");
    assert.deepEqual(actual.invocation.output, { sum: 42 });
    assert.equal(actual.invocation.trust, "untrusted_external_data");
    assert.equal(actual.visible, "Invoked");
  }),

  browserCase("captcha-evidence", "Visible CAPTCHA evidence survives a failed snippet", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": checkboxHtml });
    const envelope = await ctx.run(`await page.goto(${JSON.stringify(server.origin)}); throw new Error('fixture failure with challenge');`);
    rejected(envelope, /fixture failure with challenge/);
    assert.ok(envelope.challenges.length >= 1);
    const artifact = envelope.artifacts.find((entry: any) => entry.kind === "captcha");
    assert.ok(artifact);
    await png(artifact.path);
    const detected = result(await ctx.run("return captcha.detect()"));
    assert.equal(detected.present, true);
    assert.equal(detected.cleared, false);
  }),

  browserCase("captcha-checkbox", "The local CAPTCHA solver clears a checkbox without an external solver", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": checkboxHtml });
    const actual = result(await ctx.run(`
      await page.goto(${JSON.stringify(server.origin)});
      const solved = await captcha.solve({timeoutMs:15000,maxStages:2});
      return {solved, token:await page.locator('[name="bw-captcha-response"]').inputValue(), title:await page.title(), status:await page.getByRole('status').innerText()};
    `));
    assert.equal(actual.solved.status, "ready");
    assert.equal(actual.solved.cleared, true);
    assert.equal(actual.solved.local, true);
    assert.equal(actual.solved.externalApi, false);
    assert.ok(actual.solved.attempts.length >= 1);
    assert.equal(actual.token, "bw_local_fixture_token");
    assert.equal(actual.title, "Verified");
    assert.equal(actual.status, "Verification complete");
  }),

  browserCase("captcha-grid", "An image-grid CAPTCHA returns a real crop and accepts fixture tile picks", async ctx => {
    const server = await serveBrowserFixture(ctx, { "/": gridHtml });
    const initial = result(await ctx.run(`await page.goto(${JSON.stringify(server.origin)}); return captcha.solve({timeoutMs:15000,maxStages:2});`));
    assert.equal(initial.status, "processing");
    assert.equal(initial.stage, "image_grid");
    assert.equal(initial.tiles.length, 9);
    assert.deepEqual(initial.grid, { rows: 3, cols: 3 });
    await png(initial.artifact.path);
    const picks = initial.tiles.filter((tile: any) => tile.label === "traffic light").map((tile: any) => tile.index);
    assert.equal(picks.length, 3);
    const actual = result(await ctx.run(`
      const solved = await captcha.solve({tiles:${JSON.stringify(picks)},timeoutMs:15000});
      return {solved,token:await page.locator('[name="bw-captcha-response"]').inputValue(),status:await page.getByRole('status').innerText()};
    `));
    assert.equal(actual.solved.cleared, true);
    assert.equal(actual.token, "bw_grid_fixture_token");
    assert.equal(actual.status, "Grid complete");
  }),

  {
    id: "recording.mp4", group: "recording", title: "MP4 recording preserves draft state and contains changing decoded frames", requiresBrowser: true,
    async run(ctx) {
      const executable = encoder(ctx, ["libx264"]);
      const server = await serveBrowserFixture(ctx, { "/": animationHtml });
      const started = result(await ctx.run(`
        await page.goto(${JSON.stringify(server.origin)});
        await page.getByLabel('Draft').fill('Unsubmitted draft'); state.marker='preserved';
        return recording.start({name:'first.mp4',fps:10,maxWidth:480,maxHeight:320,maxDurationMs:10000});
      `));
      assert.equal(started.state, "recording");
      const envelope = await ctx.run(`
        const before = await page.evaluate(() => window.frameNumber);
        await page.waitForFunction(before => window.frameNumber >= before + 20, before, {timeout:5000});
        const saved = await recording.stop();
        return {saved,repeated:await recording.stop(),draft:await page.getByLabel('Draft').inputValue(),marker:state.marker};
      `);
      const actual = result(envelope);
      assert.equal(actual.saved.state, "completed");
      assert.deepEqual(actual.repeated, actual.saved);
      assert.equal(actual.draft, "Unsubmitted draft");
      assert.equal(actual.marker, "preserved");
      assert.ok(actual.saved.outputFrames > 1);
      assert.equal((await stat(actual.saved.path)).size, actual.saved.bytes);
      const bytes = await readFile(actual.saved.path);
      assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
      assert.ok(new Set(decodeVideo(executable, actual.saved.path)).size > 1);
      assert.ok(envelope.artifacts.some((artifact: any) => artifact.path === actual.saved.path && artifact.mimeType === "video/mp4"));
    },
  },

  {
    id: "recording.restart", group: "recording", title: "Recording restart finalizes MP4 and starts an isolated WebM take", requiresBrowser: true,
    async run(ctx) {
      const executable = encoder(ctx, ["libx264", "libvpx"]);
      const server = await serveBrowserFixture(ctx, { "/": animationHtml });
      const first = result(await ctx.run(`await page.goto(${JSON.stringify(server.origin)}); return recording.start({name:'first.mp4',fps:10,maxWidth:480,maxHeight:320});`, { session: "recorded" }));
      assert.deepEqual(result(await ctx.run("return recording.status()", { session: "other" })), { state: "idle" });
      rejected(await ctx.run("return recording.start()", { session: "recorded" }), /already active/);
      const restarted = await ctx.run("return recording.restart({name:'second.webm',fps:10,maxWidth:480,maxHeight:320})", { session: "recorded" });
      const second = result(restarted);
      assert.equal(second.state, "recording");
      assert.notEqual(second.path, first.path);
      assert.ok(restarted.artifacts.some((artifact: any) => artifact.path === first.path));
      const stopped = result(await ctx.run(`
        const before=await page.evaluate(() => window.frameNumber);
        await page.waitForFunction(before => window.frameNumber >= before+20,before,{timeout:5000});
        return recording.stop();
      `, { session: "recorded" }));
      assert.equal(stopped.state, "completed");
      assert.deepEqual([...(await readFile(second.path)).subarray(0, 4)], [26, 69, 223, 163]);
      decodeVideo(executable, first.path);
      decodeVideo(executable, second.path);
    },
  },

  {
    id: "recording.cli", group: "recording", title: "CLI record commands share the session and tab closure flushes the video", requiresBrowser: true,
    async run(ctx) {
      const executable = encoder(ctx, ["libx264"]);
      const server = await serveBrowserFixture(ctx, { "/": animationHtml });
      result(await ctx.run(`await page.goto(${JSON.stringify(server.origin)}); return page.title();`, { session: "movie" }));
      const started = await ctx.json(["record", "start", "cli.mp4", "--session", "movie", "--fps", "10", "--max-width", "480", "--max-height", "320"]);
      const status = result(await ctx.run("return recording.status()", { session: "movie" }));
      assert.equal(status.state, "recording", JSON.stringify(started));
      const actual = result(await ctx.run(`
        const before=await page.evaluate(() => window.frameNumber);
        await page.waitForFunction(before => window.frameNumber >= before+20,before,{timeout:5000});
        await closePage(); return recording.status();
      `, { session: "movie" }));
      assert.equal(actual.state, "completed");
      assert.equal(actual.path, status.path);
      assert.equal((await stat(actual.path)).size, actual.bytes);
      decodeVideo(executable, actual.path);
    },
  },
];
