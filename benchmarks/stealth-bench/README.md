# Stealth Bench V1

This runner applies Browser Use's encrypted Stealth Bench task set to
BetterWright without copying or publishing its plaintext tasks. It decrypts the
tasks in memory, launches an isolated browser profile for each attempt, stores
only task metadata and verdicts, and never writes screenshots or model traces.

The pinned public dataset currently contains 80 tasks and has SHA-256
`d9a842e6cf924929b25b39d1d96b6aa9eb89e05fe942598dfda85bf468d7cfda`.
That differs from the original 71-task blog post, so reports must retain the
dataset hash.

```bash
node benchmarks/stealth-bench/runner.mjs \
  --dataset /path/to/browser-use-benchmark/Stealth_Bench_V1.enc \
  --mode headless \
  --task-ids 1,2,3 \
  --output /tmp/betterwright-stealth-headless.json
```

Use `--binary /path/to/Chromium` to test a local fork build and
`--upstream-proxy socks5://...` for an IP-matched proxy run. The runner treats
CAPTCHAs and anti-bot interstitials as blocked; it explicitly does not solve
them, because the measurement is clean access rather than solver performance.

The upstream benchmark repository does not publish a repository-wide license.
Keep its encrypted dataset in the external checkout and do not vendor it here.

