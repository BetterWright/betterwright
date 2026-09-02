// Argv parsing shared by the BetterWright CLI (bin/betterwright.ts). Pure
// functions with no side effects, kept out of the bin entrypoint because that
// file runs main() on import — anything tests (or future callers) need to
// import lives here instead.

// Every value given for a repeatable flag, in argv order, accepting both
// `--flag value` and `--flag=value`. Single source of truth for value-flag
// parsing (flagValue builds on it). A trailing `--flag` with no value is
// ignored; `--flag=` yields an empty string, which NetworkPolicy treats as
// matching nothing, so it can never widen an allow list or mute a block list.
export function collectValues(argv, flag) {
  const assigned = `${flag}=`;
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) {
      if (i + 1 < argv.length) values.push(argv[i + 1]);
    } else if (argv[i].startsWith(assigned)) {
      values.push(argv[i].slice(assigned.length));
    }
  }
  return values;
}

// First value for a flag: `--flag value` wins when present (historical
// precedence), then the first `--flag=value`; `fallback` when neither form
// carries a value. `--flag=` is an explicit empty value, not the fallback.
export function flagValue(argv, flag, fallback?) {
  const index = argv.indexOf(flag);
  if (index !== -1 && index + 1 < argv.length) return argv[index + 1];
  return collectValues(argv, flag)[0] ?? fallback;
}

// Flags that consume the next token as their value in the space-separated
// form, so firstPositional can tell a flag's argument from a positional.
export const VALUE_FLAGS = new Set([
  // `run -c "<code>"`: without this the snippet reads as a positional, i.e. a
  // filename. readSnippet checks -c first so nothing is broken today, but the
  // two parsers should agree rather than depend on that ordering.
  "-c",
  "--allow-host",
  "--allow-cloud",
  "--api-key-env",
  "--base-url",
  "--block-host",
  // `run --browser steel script.js` must read script.js as the file, not
  // steel: the browser choice and its key are values, never positionals.
  "--browser",
  "--browser-key",
  "--connect",
  "--disconnect",
  "--category",
  "--delay",
  "--domain",
  "--effort",
  "--endpoint",
  "--expose",
  "--host",
  "--key-delay",
  "--limit",
  "--locale",
  "--model",
  "--model-id",
  "--platform",
  "--port",
  "--profile",
  "--protocol",
  "--provider",
  "--public-host",
  "--query",
  "--reasoning",
  "--session",
  "--session-id",
  "--status",
  "--source-profile",
  "--key-env",
  "--add",
  "--remove",
  "--cdp-url",
  "--docs",
  "--display-name",
  "--timezone",
  "--upstream-proxy",
]);

// Every positional, with value-flag arguments skipped so `--query github list`
// cannot be mistaken for a subcommand. `firstPositional` is this, bounded to
// one result.
export function positionalArgs(tokens) {
  const values = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("-")) {
      values.push(token);
      continue;
    }
    if (!token.includes("=") && VALUE_FLAGS.has(token)) index += 1;
  }
  return values;
}

export function firstPositional(tokens) {
  return positionalArgs(tokens)[0];
}
