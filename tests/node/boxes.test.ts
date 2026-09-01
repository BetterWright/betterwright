// Cloud box management: configure --connect saves a mock API key, then
// `boxes start/list/show/stop` drive a simulated REST API for every
// lifecycle provider. No sockets, no real credentials.

import assert from "node:assert/strict";
import test from "node:test";

import { loadBrowserConfig } from "../../dist/src/browser-config.js";
import {
  REST_BROWSER_PROVIDER_NAMES,
  browserProviderInfo,
  createProviderSession,
  getProviderSession,
  listProviderSessions,
  resolveBrowserProvider,
  stopProviderSession,
} from "../../dist/src/browser-providers.js";
import { runBoxesCommand } from "../../dist/src/boxes-cli.js";
import { runConfigure } from "../../dist/src/configure.js";
import {
  createProviderApiMock,
  MOCK_PROVIDER_KEYS,
} from "./helpers/provider-api-mock.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function recorder() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    log: (line) => out.push(String(line)),
    error: (line) => err.push(String(line)),
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

async function connect(home, provider, key) {
  const io = recorder();
  const code = await runConfigure(["--connect", provider, "--browser-key", key], {
    home,
    env: {},
    ...io,
  });
  assert.equal(code, 0, io.stderr());
  return io;
}

const REST = [
  ["kernel", MOCK_PROVIDER_KEYS.kernel],
  ["browserbase", MOCK_PROVIDER_KEYS.browserbase],
  ["steel", MOCK_PROVIDER_KEYS.steel],
  ["anchor", MOCK_PROVIDER_KEYS.anchor],
  ["hyperbrowser", MOCK_PROVIDER_KEYS.hyperbrowser],
  ["browser-use", MOCK_PROVIDER_KEYS["browser-use"]],
];

test("the six SDK-backed providers advertise REST lifecycle", () => {
  assert.deepEqual([...REST_BROWSER_PROVIDER_NAMES], [
    "browser-use",
    "kernel",
    "browserbase",
    "steel",
    "anchor",
    "hyperbrowser",
  ]);
  for (const [name] of REST) {
    assert.equal(browserProviderInfo(name).lifecycle, "rest");
  }
  for (const name of ["browserless", "brightdata", "oxylabs"]) {
    assert.equal(browserProviderInfo(name).lifecycle, "connect");
  }
});

test("configure --connect saves a key without changing the launch default", async () => {
  const home = makeTempDir("bw-boxes-connect-");
  const io = await connect(home, "kernel", MOCK_PROVIDER_KEYS.kernel);
  assert.match(io.stdout(), /Connected Kernel \(kernel\)/);
  assert.match(io.stdout(), /boxes list --browser kernel/);
  const config = loadBrowserConfig(home);
  assert.equal(config.default, undefined);
  assert.deepEqual(config.accounts.kernel, { apiKey: MOCK_PROVIDER_KEYS.kernel });
  assert.doesNotMatch(io.stdout(), new RegExp(MOCK_PROVIDER_KEYS.kernel));
});

test("configure --show --json masks connected keys", async () => {
  const home = makeTempDir("bw-boxes-show-");
  await connect(home, "steel", "super-secret-steel-key");
  const io = recorder();
  assert.equal(await runConfigure(["--show", "--json"], { home, env: {}, ...io }), 0);
  const report = JSON.parse(io.stdout());
  assert.equal(report.accounts.steel.apiKey, "***");
  assert.doesNotMatch(io.stdout(), /super-secret-steel-key/);
});

test("configure --disconnect forgets a saved key", async () => {
  const home = makeTempDir("bw-boxes-disc-");
  await connect(home, "kernel", MOCK_PROVIDER_KEYS.kernel);
  const io = recorder();
  assert.equal(await runConfigure(["--disconnect", "kernel"], { home, env: {}, ...io }), 0);
  assert.match(io.stdout(), /Disconnected kernel/);
  assert.equal(loadBrowserConfig(home).accounts.kernel, undefined);
});

test("configure connect <name> positional form works", async () => {
  const home = makeTempDir("bw-boxes-pos-");
  const io = recorder();
  assert.equal(
    await runConfigure(["connect", "browserbase", "--key-env", "BROWSERBASE_API_KEY"], {
      home,
      env: { BROWSERBASE_API_KEY: MOCK_PROVIDER_KEYS.browserbase },
      ...io,
    }),
    0,
  );
  assert.deepEqual(loadBrowserConfig(home).accounts.browserbase, {
    keyEnv: "BROWSERBASE_API_KEY",
  });
});

test("setting a named default with a key also connects the account", async () => {
  const home = makeTempDir("bw-boxes-default-");
  const io = recorder();
  await runConfigure(["--browser", "hyperbrowser", "--browser-key", MOCK_PROVIDER_KEYS.hyperbrowser], {
    home,
    env: {},
    ...io,
  });
  const config = loadBrowserConfig(home);
  assert.equal(config.default.provider, "hyperbrowser");
  assert.deepEqual(config.accounts.hyperbrowser, { apiKey: MOCK_PROVIDER_KEYS.hyperbrowser });
});

for (const [provider, key] of REST) {
  test(`${provider}: connect, start, list, show, stop against a mock API`, async () => {
    const home = makeTempDir(`bw-boxes-${provider}-`);
    await connect(home, provider, key);
    const api = createProviderApiMock();
    const io = recorder();
    const started = await runBoxesCommand(["start", "--browser", provider], {
      home,
      env: {},
      fetchJson: api.fetchJson,
      ...io,
    });
    assert.equal(started, 0, io.stderr());
    assert.match(io.stdout(), /Started/);
    assert.doesNotMatch(io.stdout(), new RegExp(key));

    const listed = recorder();
    assert.equal(
      await runBoxesCommand(["list", "--json", "--browser", provider], {
        home,
        env: {},
        fetchJson: api.fetchJson,
        ...listed,
      }),
      0,
      listed.stderr(),
    );
    const list = JSON.parse(listed.stdout());
    assert.equal(list.boxes.length, 1);
    const id = list.boxes[0].id;
    assert.ok(id);
    assert.equal(list.boxes[0].provider, provider);
    assert.doesNotMatch(listed.stdout(), new RegExp(key));
    if (list.boxes[0].cdpUrl) {
      assert.match(list.boxes[0].cdpUrl, /\*\*\*|wss:/);
      assert.doesNotMatch(list.boxes[0].cdpUrl, new RegExp(key));
    }

    const shown = recorder();
    assert.equal(
      await runBoxesCommand(["show", id, "--browser", provider], {
        home,
        env: {},
        fetchJson: api.fetchJson,
        ...shown,
      }),
      0,
      shown.stderr(),
    );
    assert.match(shown.stdout(), new RegExp(id));
    assert.doesNotMatch(shown.stdout(), new RegExp(key));

    const stopped = recorder();
    assert.equal(
      await runBoxesCommand(["stop", id, "--browser", provider], {
        home,
        env: {},
        fetchJson: api.fetchJson,
        ...stopped,
      }),
      0,
      stopped.stderr(),
    );
    assert.match(stopped.stdout(), /Stopped/);

    const empty = recorder();
    assert.equal(
      await runBoxesCommand(["list", "--json", "--browser", provider], {
        home,
        env: {},
        fetchJson: api.fetchJson,
        ...empty,
      }),
      0,
    );
    assert.equal(JSON.parse(empty.stdout()).boxes.length, 0);
  });
}

test("a wrong mock key is refused with HTTP 401", async () => {
  const home = makeTempDir("bw-boxes-401-");
  await connect(home, "kernel", "k_wrong");
  const api = createProviderApiMock();
  const io = recorder();
  assert.equal(
    await runBoxesCommand(["start", "--browser", "kernel"], {
      home,
      env: {},
      fetchJson: api.fetchJson,
      ...io,
    }),
    1,
  );
  assert.match(io.stderr(), /HTTP 401/);
});

test("connect-only providers cannot start or stop boxes", async () => {
  for (const name of ["browserless", "brightdata", "oxylabs"]) {
    const home = makeTempDir(`bw-boxes-${name}-`);
    const key = name === "brightdata" ? "brd-customer-x-zone-y:pw" : name === "oxylabs" ? "user:pass" : "bl_token";
    await connect(home, name, key);
    const io = recorder();
    assert.equal(
      await runBoxesCommand(["start", "--browser", name], { home, env: {}, ...io }),
      1,
    );
    assert.match(io.stderr(), /no managed sessions/);
  }
});

test("boxes list without a provider walks every connected REST account", async () => {
  const home = makeTempDir("bw-boxes-all-");
  await connect(home, "kernel", MOCK_PROVIDER_KEYS.kernel);
  await connect(home, "steel", MOCK_PROVIDER_KEYS.steel);
  const api = createProviderApiMock();
  await runBoxesCommand(["start", "--browser", "kernel"], {
    home,
    env: {},
    fetchJson: api.fetchJson,
    ...recorder(),
  });
  await runBoxesCommand(["start", "--browser", "steel"], {
    home,
    env: {},
    fetchJson: api.fetchJson,
    ...recorder(),
  });
  const io = recorder();
  assert.equal(
    await runBoxesCommand(["list", "--json"], { home, env: {}, fetchJson: api.fetchJson, ...io }),
    0,
    io.stderr(),
  );
  const boxes = JSON.parse(io.stdout()).boxes;
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes.map((box) => box.provider).sort(), ["kernel", "steel"]);
});

test("boxes start uses a well-known env var when nothing is saved", async () => {
  const home = makeTempDir("bw-boxes-env-");
  const api = createProviderApiMock();
  const io = recorder();
  assert.equal(
    await runBoxesCommand(["start", "--browser", "kernel"], {
      home,
      env: { KERNEL_API_KEY: MOCK_PROVIDER_KEYS.kernel },
      fetchJson: api.fetchJson,
      ...io,
    }),
    0,
    io.stderr(),
  );
  assert.match(io.stdout(), /Started Kernel box/);
});

test("kernel --session-id attaches via GET instead of minting", async () => {
  const api = createProviderApiMock();
  const created = api.mint("kernel", {
    status: "active",
    cdp_ws_url: "wss://onkernel.example/devtools/existing",
    browser_live_view_url: "https://live.onkernel.example/existing",
  });
  const resolved = resolveBrowserProvider(
    { provider: "kernel", apiKey: MOCK_PROVIDER_KEYS.kernel, sessionOptions: { sessionId: created.id } },
    { env: {} },
  );
  const plan = await resolved.plan.create({ fetchJson: api.fetchJson });
  assert.equal(plan.sessionId, created.id);
  assert.equal(plan.cdpUrl, "wss://onkernel.example/devtools/existing");
  assert.equal(
    api.calls.at(-1).url,
    `https://api.onkernel.com/browsers/${created.id}`,
  );
  assert.equal(api.calls.at(-1).method, "GET");
});

test("steel launch without a session id still uses the connect URL", () => {
  const resolved = resolveBrowserProvider(
    { provider: "steel", apiKey: MOCK_PROVIDER_KEYS.steel },
    { env: {} },
  );
  assert.equal(resolved.plan.create, undefined);
  assert.match(resolved.plan.cdpUrl, /^wss:\/\/connect\.steel\.dev\/\?apiKey=/);
});

test("boxes stop of an unknown id is a 404", async () => {
  const home = makeTempDir("bw-boxes-404-");
  await connect(home, "kernel", MOCK_PROVIDER_KEYS.kernel);
  const api = createProviderApiMock();
  const io = recorder();
  assert.equal(
    await runBoxesCommand(["stop", "missing", "--browser", "kernel"], {
      home,
      env: {},
      fetchJson: api.fetchJson,
      ...io,
    }),
    1,
  );
  assert.match(io.stderr(), /HTTP 404/);
});

test("boxes without a subcommand prints usage", async () => {
  const io = recorder();
  assert.equal(await runBoxesCommand([], { ...io }), 1);
  assert.match(io.stderr(), /Usage: betterwright boxes/);
});

test("an unknown boxes command prints usage", async () => {
  const io = recorder();
  assert.equal(await runBoxesCommand(["frobnicate"], { ...io }), 1);
  assert.match(io.stderr(), /Unknown boxes command "frobnicate"/);
});

test("configure --connect without a key fails before writing", async () => {
  const home = makeTempDir("bw-boxes-nokey-");
  const io = recorder();
  assert.equal(await runConfigure(["--connect", "kernel"], { home, env: {}, ...io }), 1);
  assert.match(io.stderr(), /--browser-key/);
  assert.deepEqual(loadBrowserConfig(home).accounts, {});
});

test("boxes start with no connected provider explains how to connect", async () => {
  const home = makeTempDir("bw-boxes-none-");
  const io = recorder();
  assert.equal(await runBoxesCommand(["start"], { home, env: {}, ...io }), 1);
  assert.match(io.stderr(), /No connected REST provider/);
  assert.match(io.stderr(), /configure --connect/);
});

test("boxes start --json never includes the API key", async () => {
  const home = makeTempDir("bw-boxes-json-");
  await connect(home, "kernel", MOCK_PROVIDER_KEYS.kernel);
  const api = createProviderApiMock();
  const io = recorder();
  assert.equal(
    await runBoxesCommand(["start", "--json", "--browser", "kernel"], {
      home,
      env: {},
      fetchJson: api.fetchJson,
      ...io,
    }),
    0,
    io.stderr(),
  );
  const row = JSON.parse(io.stdout());
  assert.equal(row.provider, "kernel");
  assert.ok(row.id);
  assert.match(row.cdpUrl, /wss:\/\//);
  assert.doesNotMatch(io.stdout(), new RegExp(MOCK_PROVIDER_KEYS.kernel));
  assert.equal(row.apiKey, undefined);
});

test("boxes list --status filters Browserbase sessions", async () => {
  const home = makeTempDir("bw-boxes-status-");
  await connect(home, "browserbase", MOCK_PROVIDER_KEYS.browserbase);
  const api = createProviderApiMock();
  assert.equal(
    await runBoxesCommand(["start", "--browser", "browserbase"], {
      home,
      env: {},
      fetchJson: api.fetchJson,
      ...recorder(),
    }),
    0,
  );
  const running = recorder();
  assert.equal(
    await runBoxesCommand(["list", "--json", "--browser", "browserbase", "--status", "RUNNING"], {
      home,
      env: {},
      fetchJson: api.fetchJson,
      ...running,
    }),
    0,
  );
  assert.equal(JSON.parse(running.stdout()).boxes.length, 1);
  const idle = recorder();
  assert.equal(
    await runBoxesCommand(["list", "--json", "--browser", "browserbase", "--status", "COMPLETED"], {
      home,
      env: {},
      fetchJson: api.fetchJson,
      ...idle,
    }),
    0,
  );
  assert.equal(JSON.parse(idle.stdout()).boxes.length, 0);
});

test("boxes --browser-key overrides a saved wrong key", async () => {
  const home = makeTempDir("bw-boxes-override-");
  await connect(home, "kernel", "k_wrong");
  const api = createProviderApiMock();
  const io = recorder();
  assert.equal(
    await runBoxesCommand(["start", "--browser", "kernel", "--browser-key", MOCK_PROVIDER_KEYS.kernel], {
      home,
      env: {},
      fetchJson: api.fetchJson,
      ...io,
    }),
    0,
    io.stderr(),
  );
  assert.match(io.stdout(), /Started Kernel box/);
});

test("boxes list of a connect-only provider is refused", async () => {
  const home = makeTempDir("bw-boxes-list-co-");
  await connect(home, "browserless", "bl_token");
  const io = recorder();
  assert.equal(
    await runBoxesCommand(["list", "--browser", "browserless"], { home, env: {}, ...io }),
    1,
  );
  assert.match(io.stderr(), /no managed sessions/);
});

test("boxes show and stop require an id", async () => {
  const home = makeTempDir("bw-boxes-need-id-");
  await connect(home, "kernel", MOCK_PROVIDER_KEYS.kernel);
  const show = recorder();
  assert.equal(await runBoxesCommand(["show"], { home, env: {}, ...show }), 1);
  assert.match(show.stderr(), /boxes show <id>/);
  const stop = recorder();
  assert.equal(await runBoxesCommand(["stop"], { home, env: {}, ...stop }), 1);
  assert.match(stop.stderr(), /boxes stop <id>/);
});

test("SDK session helpers round-trip every REST provider against the mock API", async () => {
  for (const [provider, key] of REST) {
    const api = createProviderApiMock();
    const created = await createProviderSession(provider, {
      apiKey: key,
      fetchJson: api.fetchJson,
    });
    assert.ok(created.id, `${provider} create returned no id`);
    assert.equal(created.provider, provider);
    const listed = await listProviderSessions(provider, {
      apiKey: key,
      fetchJson: api.fetchJson,
    });
    assert.equal(listed.length, 1, `${provider} list`);
    assert.equal(listed[0].id, created.id);
    const shown = await getProviderSession(provider, created.id, {
      apiKey: key,
      fetchJson: api.fetchJson,
    });
    assert.equal(shown.id, created.id);
    const stopped = await stopProviderSession(provider, created.id, {
      apiKey: key,
      fetchJson: api.fetchJson,
    });
    assert.deepEqual(stopped, { provider, id: created.id });
    assert.equal(
      (await listProviderSessions(provider, { apiKey: key, fetchJson: api.fetchJson })).length,
      0,
      `${provider} list after stop`,
    );
  }
});

test("SDK helpers refuse connect-only providers", async () => {
  await assert.rejects(
    () => createProviderSession("browserless", { apiKey: "tok" }),
    /no managed sessions/,
  );
});
