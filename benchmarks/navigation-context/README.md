# Navigation and observation overhead

This local benchmark builds and compares two BetterWright source checkouts with identical
browser binaries, default options, and unchanged native skills. It checks result
parity on article extraction, form submission, table filtering, delayed content,
and explicit control discovery. There are no task-specific runtime or prompt
changes.

```sh
export BETTERWRIGHT_CHROMIUM_PATH=/path/to/BetterChromium
bun benchmarks/navigation-context/run.ts \
  --baseline /path/to/baseline-checkout \
  --candidate /path/to/candidate-checkout \
  --output results.json
```

Install each checkout's locked dependencies first. Source and build inputs must
be committed and clean, including staged, untracked, and ignored files under
the recorded source paths. The harness rebuilds each checkout before importing
its runtime, then records:

- Immutable baseline and candidate commit IDs.
- SHA-256 of the committed baseline-to-variant diff over `src`, `bin`, and
  `types`, including newly added files.
- SHA-256 of Git tree entries for all recorded source/build inputs, plus a
  fingerprint of every generated file in `dist/`.
- Browser and benchmark-code hashes.

The harness checks these inputs and outputs again after measurement. Publishing
`results.json` necessarily creates a later commit than the measured candidate;
a report-only commit is valid when its recorded source tree and runtime diff
are unchanged. The candidate commit identifies the code measured, not the
later commit containing the result file. The provenance regression tests cover
this distinction and reject subsequent runtime changes.

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
The measured baseline is `8a87ae6e44341204803c84085bf72b706a0e92fc`; the measured candidate is
`07141956b22f781cbe8f359828a1ae59926c38f3`. The source/build inputs in subsequent report-only commits must remain identical.

| Workload | Baseline median ms | Candidate median ms | Baseline piped characters | Candidate piped characters |
| --- | ---: | ---: | ---: | ---: |
| Article extraction | 46.4 | 46.8 | 8,855 | 2,740 |
| Form submission | 392.3 | 357.9 | 1,864 | 973 |
| Table filtering | 83.5 | 84.2 | 1,471 | 744 |
| Delayed content | 859.0 | 239.4 | 318 | 236 |
| Explicit directory | 54.2 | 48.0 | 3,056 | 837 |

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
