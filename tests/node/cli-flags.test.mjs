import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { NetworkPolicy } from "../../src/policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "bin", "betterwright.mjs");

// bin/betterwright.mjs runs main() on import (it is the CLI entrypoint), so
// the exported flag helpers are exercised in a subprocess: import the CLI with
// a benign argv (`--version`, synchronous and side-effect free), neuter
// process.exit and console.log, then call the helpers with the argv under
// test and print the results as JSON.
function callHelpers(calls) {
  const script = [
    `process.argv = [process.argv[0], ${JSON.stringify(cli)}, "--version"];`,
    "const write = process.stdout.write.bind(process.stdout);",
    "console.log = () => {};",
    "process.exit = () => {};",
    `const mod = await import(${JSON.stringify(pathToFileURL(cli).href)});`,
    `const calls = ${JSON.stringify(calls)};`,
    "const results = calls.map(({ fn, argv, flag, fallback }) => mod[fn](argv, flag, fallback));",
    "write(JSON.stringify(results));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `helper subprocess failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

// A realistic argv prefix: node, script path, subcommand.
const argvFor = (...tokens) => ["node", cli, "run", ...tokens];

test("regression: --block-host=evil.com produces a non-empty block list that blocks the host", () => {
  const [blockHosts] = callHelpers([
    {
      fn: "collectValues",
      argv: argvFor("--block-host=evil.com", "https://example.com"),
      flag: "--block-host",
    },
  ]);
  assert.deepEqual(blockHosts, ["evil.com"]);

  // End-to-end contract: the parsed list actually blocks the host instead of
  // failing open like the old empty list did.
  const policy = new NetworkPolicy({ blockHosts });
  assert.equal(policy.check("https://evil.com/login").allowed, false);
  assert.equal(policy.check("https://sub.evil.com/").allowed, false);
  assert.equal(policy.check("https://example.com/").allowed, true);
});

test("mixed space and assigned forms are all collected, in argv order", () => {
  const [blocked, allowed] = callHelpers([
    {
      fn: "collectValues",
      argv: argvFor("--block-host", "a.com", "--block-host=b.com", "--block-host", "c.com"),
      flag: "--block-host",
    },
    {
      fn: "collectValues",
      argv: argvFor("--allow-host=x.com", "--allow-host", "y.com"),
      flag: "--allow-host",
    },
  ]);
  assert.deepEqual(blocked, ["a.com", "b.com", "c.com"]);
  assert.deepEqual(allowed, ["x.com", "y.com"]);
});

test("a trailing value flag with no value is ignored and does not crash", () => {
  const [hosts, session] = callHelpers([
    { fn: "collectValues", argv: argvFor("--block-host"), flag: "--block-host" },
    { fn: "flagValue", argv: argvFor("--session"), flag: "--session", fallback: "default" },
  ]);
  assert.deepEqual(hosts, []);
  assert.equal(session, "default");
});

test("--block-host= collects an explicit empty entry, which the policy treats as inert", () => {
  const [hosts] = callHelpers([
    { fn: "collectValues", argv: argvFor("--block-host="), flag: "--block-host" },
  ]);
  assert.deepEqual(hosts, [""]);

  // An empty entry matches nothing, so it can never fail open: it does not
  // widen an allow list (private host stays blocked) and does not block
  // unrelated hosts.
  const allowing = new NetworkPolicy({ allowHosts: [""], allowPrivateNetwork: false });
  assert.equal(allowing.check("https://192.168.1.10/").allowed, false);
  const nonEmptyAllow = new NetworkPolicy({
    allowHosts: ["192.168.1.10"],
    allowPrivateNetwork: false,
  });
  assert.equal(nonEmptyAllow.check("https://192.168.1.10/").allowed, true);
  const blocking = new NetworkPolicy({ blockHosts: [""] });
  assert.equal(blocking.check("https://example.com/").allowed, true);
});

test("values containing = or a port survive intact", () => {
  const [hosts, proxy] = callHelpers([
    { fn: "collectValues", argv: argvFor("--block-host=a.com:8080"), flag: "--block-host" },
    {
      fn: "flagValue",
      argv: argvFor("--upstream-proxy=http://user:pass@proxy.example:3128/?opt=1"),
      flag: "--upstream-proxy",
    },
  ]);
  assert.deepEqual(hosts, ["a.com:8080"]);
  assert.equal(proxy, "http://user:pass@proxy.example:3128/?opt=1");
});

test("a longer flag sharing the prefix never matches (--block-hostile vs --block-host)", () => {
  const [hosts, single] = callHelpers([
    {
      fn: "collectValues",
      argv: argvFor("--block-hostile=evil.com", "--block-hostile", "evil.com"),
      flag: "--block-host",
    },
    {
      fn: "flagValue",
      argv: argvFor("--block-hostile=evil.com"),
      flag: "--block-host",
      fallback: "unmatched",
    },
  ]);
  assert.deepEqual(hosts, []);
  assert.equal(single, "unmatched");
});

test("flagValue keeps space-form precedence and supports both syntaxes", () => {
  const [assigned, spaceWins, firstSpace, explicitEmpty, missing] = callHelpers([
    { fn: "flagValue", argv: argvFor("--model=openrouter/vendor/model"), flag: "--model" },
    { fn: "flagValue", argv: argvFor("--model=a", "--model", "b"), flag: "--model" },
    { fn: "flagValue", argv: argvFor("--model", "a", "--model=b"), flag: "--model" },
    { fn: "flagValue", argv: argvFor("--session="), flag: "--session", fallback: "default" },
    { fn: "flagValue", argv: argvFor(), flag: "--model", fallback: "fallback" },
  ]);
  assert.equal(assigned, "openrouter/vendor/model");
  // The `--flag value` form wins over `--flag=value` regardless of order,
  // matching the CLI's historical precedence.
  assert.equal(spaceWins, "b");
  assert.equal(firstSpace, "a");
  // `--flag=` is an explicit empty value, not the fallback.
  assert.equal(explicitEmpty, "");
  assert.equal(missing, "fallback");
});
