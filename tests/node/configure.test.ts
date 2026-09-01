/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${apiKey}` is the literal placeholder custom cdpUrl templates carry */
// `betterwright configure` — the flag forms and the scripted menu.
//
// Everything here runs against a temp home and injected seams: `prompt`
// answers the menu, `connect` stands in for the CDP handshake, and `fetchJson`
// stands in for a provider's create-session API, so a full pass never opens a
// socket or writes outside the temp directory.

import assert from "node:assert/strict";
import test from "node:test";

import { loadBrowserConfig } from "../../dist/src/browser-config.js";
import { BROWSER_PROVIDER_NAMES } from "../../dist/src/browser-providers.js";
import { runConfigure } from "../../dist/src/configure.js";
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

// Answers the menu in order; `confirm` is derived from `ask` by runConfigure,
// so a script is just the strings a person would type.
function scriptedPrompt(answers) {
  const asked = [];
  return {
    asked,
    async ask(question) {
      asked.push(String(question));
      return answers.shift() ?? "";
    },
  };
}

function menuIndexOf(name) {
  return 2 + BROWSER_PROVIDER_NAMES.indexOf(name); // 1 is the managed fork
}

test("--browser <provider> --key-env round-trips through the config file", async () => {
  const home = makeTempDir("bw-configure-");
  const io = recorder();
  const code = await runConfigure(["--browser", "steel", "--key-env", "MY_STEEL"], {
    home,
    env: { MY_STEEL: "sk-live" },
    ...io,
  });
  assert.equal(code, 0);
  assert.deepEqual(loadBrowserConfig(home).default, { provider: "steel", keyEnv: "MY_STEEL" });
  assert.deepEqual(loadBrowserConfig(home).accounts.steel, { keyEnv: "MY_STEEL" });
  assert.match(io.stdout(), /Default browser: Steel \(steel\), API key from MY_STEEL \(set\)/);
});

test("--browser with a URL stores a CDP endpoint and rejects other protocols", async () => {
  const home = makeTempDir("bw-configure-");
  const io = recorder();
  assert.equal(
    await runConfigure(["--browser", "wss://cdp.example.com/devtools/abc"], { home, env: {}, ...io }),
    0,
  );
  assert.deepEqual(loadBrowserConfig(home).default, { cdpUrl: "wss://cdp.example.com/devtools/abc" });

  const bad = recorder();
  assert.equal(await runConfigure(["--browser", "https://cdp.example.com"], { home, env: {}, ...bad }), 1);
  assert.match(bad.stderr(), /ws:\/\/ or wss:\/\/ URL/);
  // The bad value changed nothing.
  assert.deepEqual(loadBrowserConfig(home).default, { cdpUrl: "wss://cdp.example.com/devtools/abc" });
});

test("--browser-key and --key-env together are refused", async () => {
  const home = makeTempDir("bw-configure-");
  const io = recorder();
  const code = await runConfigure(
    ["--browser", "steel", "--browser-key", "sk-live", "--key-env", "STEEL_API_KEY"],
    { home, env: {}, ...io },
  );
  assert.equal(code, 1);
  assert.match(io.stderr(), /not both/);
  assert.equal(loadBrowserConfig(home).default, undefined);
});

test("--add saves a custom provider, --remove reports what it did", async () => {
  const home = makeTempDir("bw-configure-");
  const io = recorder();
  const added = await runConfigure(
    [
      "--add",
      "my-cloud",
      "--cdp-url",
      "wss://cdp.my-cloud.example/connect?token=${apiKey}",
      "--key-env",
      "MY_CLOUD_TOKEN",
      "--display-name",
      "My Cloud",
      "--docs",
      "https://my-cloud.example/docs",
    ],
    { home, env: {}, ...io },
  );
  assert.equal(added, 0);
  assert.deepEqual(loadBrowserConfig(home).custom["my-cloud"], {
    cdpUrl: "wss://cdp.my-cloud.example/connect?token=${apiKey}",
    keyEnv: "MY_CLOUD_TOKEN",
    displayName: "My Cloud",
    docs: "https://my-cloud.example/docs",
  });

  // A custom name is a valid --browser value once it exists.
  assert.equal(await runConfigure(["--browser", "my-cloud"], { home, env: {}, ...io }), 0);
  assert.deepEqual(loadBrowserConfig(home).default, { provider: "my-cloud" });

  const removed = recorder();
  assert.equal(await runConfigure(["--remove", "my-cloud"], { home, env: {}, ...removed }), 0);
  assert.match(removed.stdout(), /Removed the custom provider "my-cloud"/);
  assert.equal(loadBrowserConfig(home).custom["my-cloud"], undefined);

  const again = recorder();
  assert.equal(await runConfigure(["--remove", "my-cloud"], { home, env: {}, ...again }), 0);
  assert.match(again.stdout(), /No custom provider named "my-cloud"/);
});

test("--add without --cdp-url fails", async () => {
  const home = makeTempDir("bw-configure-");
  const io = recorder();
  assert.equal(await runConfigure(["--add", "my-cloud"], { home, env: {}, ...io }), 1);
  assert.match(io.stderr(), /--cdp-url/);
});

test("--managed clears the default", async () => {
  const home = makeTempDir("bw-configure-");
  const io = recorder();
  await runConfigure(["--browser", "steel", "--browser-key", "sk-live"], { home, env: {}, ...io });
  assert.equal(loadBrowserConfig(home).default?.provider, "steel");
  assert.equal(await runConfigure(["--reset"], { home, env: {}, ...io }), 0);
  assert.equal(loadBrowserConfig(home).default, undefined);
  assert.deepEqual(loadBrowserConfig(home).accounts.steel, { apiKey: "sk-live" });
  assert.match(io.stdout(), /managed BetterChromium fork/);
});

test("--show --json masks stored keys and names env vars", async () => {
  const home = makeTempDir("bw-configure-");
  const quiet = recorder();
  await runConfigure(["--browser", "steel", "--key-env", "MY_STEEL"], { home, env: {}, ...quiet });
  await runConfigure(
    ["--add", "my-cloud", "--cdp-url", "wss://x.example/${apiKey}", "--browser-key", "super-secret"],
    { home, env: {}, ...quiet },
  );

  const io = recorder();
  assert.equal(await runConfigure(["--show", "--json"], { home, env: { MY_STEEL: "sk-live" }, ...io }), 0);
  const report = JSON.parse(io.stdout());
  assert.deepEqual(report.default, {
    provider: "steel",
    keyEnv: "MY_STEEL",
    keyEnvSet: true,
  });
  assert.deepEqual(report.accounts.steel, {
    provider: "steel",
    keyEnv: "MY_STEEL",
    keyEnvSet: true,
  });
  assert.equal(report.custom["my-cloud"].apiKey, "***");
  assert.doesNotMatch(io.stdout(), /super-secret/);

  const text = recorder();
  assert.equal(await runConfigure(["--show"], { home, env: {}, ...text }), 0);
  assert.match(text.stdout(), /Default: {5}Steel \(steel\), API key from MY_STEEL \(not set\)/);
  assert.doesNotMatch(text.stdout(), /super-secret/);
});

test("--test connects through the injected hook and reports the version", async () => {
  const home = makeTempDir("bw-configure-");
  const io = recorder();
  const seen = [];
  const code = await runConfigure(["--browser", "steel", "--browser-key", "sk-live", "--test"], {
    home,
    env: {},
    ...io,
    connect: async (request) => {
      seen.push(request);
      return { version: "Chrome/141.0.0.0" };
    },
  });
  assert.equal(code, 0);
  assert.equal(seen.length, 1);
  assert.match(seen[0].cdpUrl, /^wss:\/\/connect\.steel\.dev\/\?apiKey=sk-live$/);
  assert.equal(seen[0].timeout, 10_000);
  assert.match(io.stdout(), /Chrome\/141\.0\.0\.0/);
});

test("a failed test keeps the saved choice and exits 1", async () => {
  const home = makeTempDir("bw-configure-");
  const io = recorder();
  const code = await runConfigure(["--browser", "steel", "--browser-key", "sk-live", "--test"], {
    home,
    env: {},
    ...io,
    connect: async () => {
      throw new Error("websocket handshake failed");
    },
  });
  assert.equal(code, 1);
  assert.match(io.stderr(), /websocket handshake failed/);
  assert.match(io.stderr(), /saved but unverified/);
  assert.deepEqual(loadBrowserConfig(home).default, { provider: "steel", apiKey: "sk-live" });
});

test("a session-minting provider is created and released around the test", async () => {
  const home = makeTempDir("bw-configure-");
  const io = recorder();
  const calls = [];
  const code = await runConfigure(["--browser", "browserbase", "--browser-key", "bb-live", "--test"], {
    home,
    env: {},
    ...io,
    fetchJson: async (url, request) => {
      calls.push(`${request.method} ${url}`);
      return { id: "session-1", connectUrl: "wss://connect.browserbase.com/session-1" };
    },
    connect: async () => ({ version: "Chrome/141.0.0.0" }),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    "POST https://api.browserbase.com/v1/sessions",
    "POST https://api.browserbase.com/v1/sessions/session-1",
  ]);
});

test("--test with no default says the managed fork is in use", async () => {
  const home = makeTempDir("bw-configure-");
  const io = recorder();
  assert.equal(await runConfigure(["--test"], { home, env: {}, ...io }), 0);
  assert.match(io.stdout(), /managed BetterChromium fork/);
});

test("the menu saves a built-in provider with an environment variable", async () => {
  const home = makeTempDir("bw-configure-");
  const io = recorder();
  const prompt = scriptedPrompt([
    String(menuIndexOf("steel")), // pick Steel
    "2", // read the key from the environment
    "", // accept the suggested STEEL_API_KEY
  ]);
  const code = await runConfigure(["--no-test"], { home, env: {}, prompt, ...io });
  assert.equal(code, 0);
  assert.deepEqual(loadBrowserConfig(home).default, {
    provider: "steel",
    keyEnv: "STEEL_API_KEY",
  });
  assert.deepEqual(loadBrowserConfig(home).accounts.steel, { keyEnv: "STEEL_API_KEY" });
  assert.match(io.stdout(), /Default browser: Steel \(steel\)/);
  // The key was never echoed, the unset variable was called out, and --no-test
  // means nothing was offered.
  assert.match(io.stdout(), /STEEL_API_KEY is not set in this shell/);
  assert.equal(prompt.asked.length, 3);
  assert.doesNotMatch(prompt.asked.join("\n"), /Test the connection/);
});

test("the menu clears the default when the managed fork is picked", async () => {
  const home = makeTempDir("bw-configure-");
  const seed = recorder();
  await runConfigure(["--browser", "steel", "--browser-key", "sk-live"], { home, env: {}, ...seed });
  const io = recorder();
  const code = await runConfigure([], { home, env: {}, prompt: scriptedPrompt(["1"]), ...io });
  assert.equal(code, 0);
  assert.equal(loadBrowserConfig(home).default, undefined);
  assert.match(io.stdout(), /Launches use it again/);
});

test("an empty menu answer changes nothing", async () => {
  const home = makeTempDir("bw-configure-");
  const seed = recorder();
  await runConfigure(["--browser", "steel", "--browser-key", "sk-live"], { home, env: {}, ...seed });
  const io = recorder();
  assert.equal(await runConfigure([], { home, env: {}, prompt: scriptedPrompt([""]), ...io }), 0);
  assert.match(io.stdout(), /Nothing changed/);
  assert.equal(loadBrowserConfig(home).default?.provider, "steel");
});
