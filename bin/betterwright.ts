#!/usr/bin/env bun
// Cheap CLI entry: --version must not load help tables or the worker/daemon
// graph. Commands that do real work load `./cli-main.js` after this router.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

async function main() {
  const tokens = process.argv.slice(2);
  const flags = new Set(tokens.filter((token) => token.startsWith("--")));
  const first = tokens[0];

  if ((!first || first.startsWith("-")) && (flags.has("--version") || tokens.includes("-v"))) {
    console.log(require("../../package.json").version);
    return 0;
  }

  const { firstPositional } = await import("../src/cli-flags.js");
  const { helpFor, MAIN_USAGE, wantsHelp } = await import("../src/cli-help.js");
  const { cliPaint } = await import("../src/cli-theme.js");
  const paint = cliPaint();

  if (!first || first.startsWith("-")) {
    if (wantsHelp(tokens)) {
      console.log(paint.help(MAIN_USAGE));
      return 0;
    }
  } else {
    const command = first;
    const rest = tokens.slice(1);
    const positional = firstPositional(rest);
    if (wantsHelp(rest) && command !== "exec" && command !== "vault") {
      console.log(paint.help(helpFor(command)));
      return 0;
    }
    if (command === "help") {
      if (positional === "vault") {
        const { VAULT_USAGE } = await import("../src/vault-cli.js");
        console.log(paint.help(VAULT_USAGE));
        return 0;
      }
      if (positional === "exec") {
        const { runCli } = await import("./cli-main.js");
        return runCli();
      }
      console.log(paint.help(positional ? helpFor(positional) : MAIN_USAGE));
      return 0;
    }
  }

  const { runCli } = await import("./cli-main.js");
  return runCli();
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  },
);
