# Stealth Bench V1

> Run after `bun run build`. Bun executes the TypeScript harness directly.

This runner applies Browser Use's encrypted Stealth Bench task set to
BetterWright without copying or publishing its plaintext tasks. It decrypts the
tasks in memory, launches an isolated browser profile for each attempt, stores
only task metadata and verdicts, and never writes screenshots or model traces.

The pinned public dataset currently contains 80 tasks and has SHA-256
`d9a842e6cf924929b25b39d1d96b6aa9eb89e05fe942598dfda85bf468d7cfda`.
That differs from the original 71-task blog post, so reports must retain the
dataset hash.

```bash
bun benchmarks/stealth-bench/runner.ts \
  --dataset /path/to/browser-use-benchmark/Stealth_Bench_V1.enc \
  --binary /absolute/path/to/betterchromium \
  --mode headless \
  --task-ids 1,2,3 \
  --output /tmp/betterwright-stealth-headless.json
```

`--binary` is required, must be an existing executable absolute path, and must
report the pinned BetterChromium version. The runner sets only
`BETTERWRIGHT_CHROMIUM_PATH`; it removes any conflicting Chromium root override
so a missing or invalid fork fails closed instead of silently benchmarking
another backend.

Use `--upstream-proxy socks5://user:pass@host:port` for an IP-matched proxy run.
Results retain only the proxy protocol, host, port, and whether authentication
was configured; credentials, URL path, query, and fragment are omitted. Every
report records the encrypted dataset hash, pinned Chromium version and release
build, exact binary SHA-256 and size, mode, model, effort, task selection,
timeout, and safety controls.

The runner treats CAPTCHAs and anti-bot interstitials as blocked. It prohibits
CAPTCHA solving and clicking, rejects screenshot calls/artifacts, keeps task
plaintext in memory only, denies downloads, and stores only task metadata,
verdicts, and hashes. The measurement is clean access rather than solver
performance.

The upstream benchmark repository does not publish a repository-wide license.
Keep its encrypted dataset in the external checkout and do not vendor it here.

