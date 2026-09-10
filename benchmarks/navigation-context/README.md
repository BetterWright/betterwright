# Navigation and observation overhead

This local benchmark compares two built BetterWright packages with identical
browser binaries, default options, and unchanged native skills. It checks result
parity on article extraction, form submission, table filtering, delayed content,
and explicit control discovery. There are no task-specific runtime or prompt
changes.

```sh
export BETTERWRIGHT_CHROMIUM_PATH=/path/to/BetterChromium
bun benchmarks/navigation-context/run.ts \
  --baseline /path/to/built/baseline \
  --candidate /path/to/built/candidate \
  --output results.json
```

Each workload has one warmup pair and ten measured pairs, alternating which
build goes first. Browser startup is excluded. Unique URL paths cause the same
automatic-discovery opportunity in each sample. The script asserts identical
returned results, including the full explicit control directory.

`pipedEnvelopeChars` applies each build's CLI JSON formatting to its SDK result:
baseline indented, candidate compact. This is a serialization measurement, not
a CLI latency measurement or a token count. The browser integration suite also
executes the CLI in both compact and `--pretty` modes and checks JSON parity.

## Recorded result

[results.json](results.json) records ten samples per workload/build on macOS
arm64, together with source/build identifiers and the browser/fixture hashes.

| Workload | Baseline median ms | Candidate median ms | Baseline piped characters | Candidate piped characters |
| --- | ---: | ---: | ---: | ---: |
| Article extraction | 48.7 | 47.4 | 8,855 | 2,740 |
| Form submission | 368.7 | 372.6 | 1,864 | 973 |
| Table filtering | 66.6 | 72.5 | 1,471 | 744 |
| Delayed content | 850.3 | 225.7 | 318 | 236 |
| Explicit directory | 50.9 | 46.7 | 3,056 | 837 |

All 100 measured executions passed result parity. Piped observations were
25.8–72.6% smaller. The delayed-content fixture has an explicit 800 ms decorative
image delay and renders its required output after 120 ms; both builds wait for
that output. The candidate avoids waiting for the image. The other fixtures
have no delayed resources. Small ordinary-page timing differences include
regressions and do not establish a general action-latency improvement.

The default automatic directory is a bounded discovery hint. The full directory
remains available on demand; truncating discovery can require another model
turn on some pages. These measurements establish smaller observations and less
waiting for irrelevant subresources, not a universal reduction in model cost or
end-to-end completion time. No paid model requests are made by this script.
