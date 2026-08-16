import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isParked,
  parkingEnabled,
  parkPage,
  parkSession,
  unparkPage,
  unparkSession,
} from "../../dist/src/page-park.js";
import { isString } from "../../dist/src/untrusted-value.js";

/** A Playwright Page stand-in that records the CDP traffic parking generates. */
function fakePage({ closed = false }: any = {}) {
  const sent = [];
  const page: any = {
    sent,
    isClosed: () => closed,
    close() {
      closed = true;
    },
  };
  page.newCDPSession = async () => {
    page.sessions = (page.sessions || 0) + 1;
    return {
      send: async (method, params) => {
        sent.push(params === undefined ? method : { method, ...params });
        if (page.failOn === method) throw new Error(`refused ${method}`);
        return {};
      },
    };
  };
  return page;
}

const deps = (page) => ({ newCDPSession: () => page.newCDPSession() });

test("parking freezes the native page lifecycle and stops animation timelines", async () => {
  const page = fakePage();
  assert.equal(await parkPage(page, deps(page)), true);
  assert.equal(isParked(page), true);
  assert.deepEqual(page.sent, [
    "Animation.enable",
    { method: "Animation.setPlaybackRate", playbackRate: 0 },
    { method: "Page.setWebLifecycleState", state: "frozen" },
  ]);
});

test("parking never purges V8 memory — the call crashes the pinned fork", async () => {
  const page = fakePage();
  await parkPage(page, deps(page));
  const methods = page.sent.map((entry) => (isString(entry) ? entry : entry.method));
  assert.ok(!methods.some((method) => String(method).startsWith("Memory.")));
});

test("unparking activates the lifecycle before restoring playback", async () => {
  const page = fakePage();
  await parkPage(page, deps(page));
  page.sent.length = 0;
  assert.equal(await unparkPage(page), true);
  assert.equal(isParked(page), false);
  assert.deepEqual(page.sent, [
    { method: "Page.setWebLifecycleState", state: "active" },
    { method: "Animation.setPlaybackRate", playbackRate: 1 },
  ]);
});

test("parking twice is a no-op, and so is unparking a page that was never parked", async () => {
  const page = fakePage();
  await parkPage(page, deps(page));
  const after = page.sent.length;
  // Both report whether *this* call changed the page, so a repeat says false
  // and sends nothing — the page is still parked either way.
  assert.equal(await parkPage(page, deps(page)), false);
  assert.equal(isParked(page), true);
  assert.equal(page.sent.length, after);

  const fresh = fakePage();
  assert.equal(await unparkPage(fresh), false);
  assert.deepEqual(fresh.sent, []);
});

test("one CDP session is reused across park/unpark cycles", async () => {
  const page = fakePage();
  for (let i = 0; i < 3; i += 1) {
    await parkPage(page, deps(page));
    await unparkPage(page);
  }
  assert.equal(page.sessions, 1);
});

test("a closed page is skipped rather than parked", async () => {
  const page = fakePage({ closed: true });
  assert.equal(await parkPage(page, deps(page)), false);
  assert.deepEqual(page.sent, []);
});

test("a browser that refuses to park still runs, and stops being asked", async () => {
  const page = fakePage();
  page.failOn = "Animation.enable";
  assert.equal(await parkPage(page, deps(page)), false);
  assert.equal(isParked(page), false);
  // Latched: the second attempt must not pay the failing round trip again.
  const attempted = page.sent.length;
  assert.equal(await parkPage(page, deps(page)), false);
  assert.equal(page.sent.length, attempted);
});

test("a session parks and wakes every open page it owns", async () => {
  const pages = [fakePage(), fakePage(), fakePage({ closed: true })];
  const session = { pages: new Map(pages.map((page, i) => [`page-${i}`, page])) };
  const newCDPSession = (page) => page.newCDPSession();

  assert.equal(await parkSession(session, { newCDPSession }), 2);
  assert.deepEqual(pages.map(isParked), [true, true, false]);
  assert.equal(await unparkSession(session), 2);
  assert.deepEqual(pages.map(isParked), [false, false, false]);
});

test("parking is on by default but never where a human can see the browser", () => {
  const env = {};
  assert.equal(parkingEnabled({ env, headless: true }), true);
  assert.equal(parkingEnabled({ env, headless: false }), false);
  assert.equal(parkingEnabled({ env, headless: true, liveView: true }), false);
});

test("the explicit option wins over the environment in both directions", () => {
  assert.equal(
    parkingEnabled({ config: { parkBackgroundPages: false }, env: {} }),
    false,
  );
  assert.equal(
    parkingEnabled({
      config: { parkBackgroundPages: true },
      env: { BETTERWRIGHT_PARK_BACKGROUND_PAGES: "0" },
    }),
    true,
  );
  // A headed browser is not parked even when both say yes.
  assert.equal(
    parkingEnabled({ config: { parkBackgroundPages: true }, headless: false }),
    false,
  );
});

test("the environment opt-out accepts the usual spellings of off", () => {
  for (const value of ["0", "false", "off", "no", "OFF", " False "]) {
    assert.equal(
      parkingEnabled({ env: { BETTERWRIGHT_PARK_BACKGROUND_PAGES: value } }),
      false,
      `expected ${JSON.stringify(value)} to disable parking`,
    );
  }
  for (const value of ["1", "true", "on", "", "anything"]) {
    assert.equal(
      parkingEnabled({ env: { BETTERWRIGHT_PARK_BACKGROUND_PAGES: value } }),
      true,
      `expected ${JSON.stringify(value)} to leave parking on`,
    );
  }
});

test("a wake that overtakes an unfinished park leaves the page running", async () => {
  // The real shape: parking is fired without being awaited as an execution
  // unwinds, and the next execution's wake arrives before it has landed. The
  // page must end up active — deciding from the state at call time got this
  // wrong, and disabled script underneath running model code.
  const page = fakePage();
  const parking = parkPage(page, deps(page)); // deliberately not awaited
  await unparkPage(page);
  await parking;
  assert.equal(isParked(page), false);
  const lifecycleSends = page.sent.filter(
    (entry) => entry.method === "Page.setWebLifecycleState",
  );
  assert.equal(lifecycleSends[lifecycleSends.length - 1]?.state ?? "active", "active");
});

test("a park countermanded before it runs never touches the browser", async () => {
  const page = fakePage();
  await parkPage(page, deps(page));
  await unparkPage(page);
  page.sent.length = 0;
  const parking = parkPage(page, deps(page));
  await unparkPage(page);
  await parking;
  assert.equal(isParked(page), false);
  assert.deepEqual(page.sent, []);
});

test("repeated park/wake cycles settle in the requested state", async () => {
  const page = fakePage();
  for (let i = 0; i < 5; i += 1) {
    await parkPage(page, deps(page));
    assert.equal(isParked(page), true);
    await unparkPage(page);
    assert.equal(isParked(page), false);
  }
});
