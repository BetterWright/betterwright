import assert from "node:assert/strict";
import test from "node:test";

import {
  collectValues,
  firstPositional,
  flagValue,
  positionalArgs,
} from "../../dist/src/cli-flags.js";
import { NetworkPolicy } from "../../dist/src/policy.js";

// A realistic argv prefix: node, script path, subcommand.
const argvFor = (...tokens) => ["node", "dist/bin/betterwright.js", "run", ...tokens];

test("recording value flags do not become recording names or subcommands", () => {
  assert.deepEqual(positionalArgs([
    "--fps", "60", "start", "--max-width", "1280", "--max-height=720",
    "--quality", "80", "--max-duration", "15", "demo.webm", "--session", "recording",
  ]), ["start", "demo.webm"]);
});

test("regression: --block-host=evil.com produces a non-empty block list that blocks the host", () => {
  const blockHosts = collectValues(
    argvFor("--block-host=evil.com", "https://example.com"),
    "--block-host",
  );
  assert.deepEqual(blockHosts, ["evil.com"]);

  // End-to-end contract: the parsed list actually blocks the host instead of
  // failing open like the old empty list did.
  const policy = new NetworkPolicy({ blockHosts });
  assert.equal(policy.check("https://evil.com/login").allowed, false);
  assert.equal(policy.check("https://sub.evil.com/").allowed, false);
  assert.equal(policy.check("https://example.com/").allowed, true);
});

test("mixed space and assigned forms are all collected, in argv order", () => {
  const blocked = collectValues(
    argvFor("--block-host", "a.com", "--block-host=b.com", "--block-host", "c.com"),
    "--block-host",
  );
  const allowed = collectValues(
    argvFor("--allow-host=x.com", "--allow-host", "y.com"),
    "--allow-host",
  );
  assert.deepEqual(blocked, ["a.com", "b.com", "c.com"]);
  assert.deepEqual(allowed, ["x.com", "y.com"]);
});

test("a trailing value flag with no value is ignored and does not crash", () => {
  const hosts = collectValues(argvFor("--block-host"), "--block-host");
  const session = flagValue(argvFor("--session"), "--session", "default");
  assert.deepEqual(hosts, []);
  assert.equal(session, "default");
});

test("--block-host= collects an explicit empty entry, which the policy treats as inert", () => {
  const hosts = collectValues(argvFor("--block-host="), "--block-host");
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
  const hosts = collectValues(argvFor("--block-host=a.com:8080"), "--block-host");
  const proxy = flagValue(
    argvFor("--upstream-proxy=http://user:pass@proxy.example:3128/?opt=1"),
    "--upstream-proxy",
  );
  assert.deepEqual(hosts, ["a.com:8080"]);
  assert.equal(proxy, "http://user:pass@proxy.example:3128/?opt=1");
});

test("a longer flag sharing the prefix never matches (--block-hostile vs --block-host)", () => {
  const hosts = collectValues(
    argvFor("--block-hostile=evil.com", "--block-hostile", "evil.com"),
    "--block-host",
  );
  const single = flagValue(
    argvFor("--block-hostile=evil.com"),
    "--block-host",
    "unmatched",
  );
  assert.deepEqual(hosts, []);
  assert.equal(single, "unmatched");
});

test("flagValue keeps space-form precedence and supports both syntaxes", () => {
  const assigned = flagValue(argvFor("--model=openrouter/vendor/model"), "--model");
  const spaceWins = flagValue(argvFor("--model=a", "--model", "b"), "--model");
  const firstSpace = flagValue(argvFor("--model", "a", "--model=b"), "--model");
  const explicitEmpty = flagValue(argvFor("--session="), "--session", "default");
  const missing = flagValue(argvFor(), "--model", "fallback");
  assert.equal(assigned, "openrouter/vendor/model");
  // The `--flag value` form wins over `--flag=value` regardless of order,
  // matching the CLI's historical precedence.
  assert.equal(spaceWins, "b");
  assert.equal(firstSpace, "a");
  // `--flag=` is an explicit empty value, not the fallback.
  assert.equal(explicitEmpty, "");
  assert.equal(missing, "fallback");
});

test("firstPositional skips value-flag arguments but not assigned or boolean flags", () => {
  // `--session default` consumes its value, so the task is the positional.
  assert.equal(firstPositional(["--session", "default", "the task"]), "the task");
  // The assigned form carries its value inline; nothing extra is consumed.
  assert.equal(firstPositional(["--session=default", "the task"]), "the task");
  // Boolean flags consume nothing, so the next token is positional.
  assert.equal(firstPositional(["--headed", "the task"]), "the task");
  // A value flag's argument must never be mistaken for a positional.
  assert.equal(firstPositional(["--model", "gpt-5.6-sol"]), undefined);
  // The browser choice is a value: `run --browser steel script.js` runs the file.
  assert.equal(firstPositional(["--browser", "steel", "script.js"]), "script.js");
  assert.equal(firstPositional(["--browser", "steel", "--browser-key", "sk-live"]), undefined);
  assert.equal(
    firstPositional(["sync", "chrome", "--domain", "example.com", "--source-profile", "Work"]),
    "sync",
  );
  assert.equal(firstPositional([]), undefined);
});
