# Worker architecture

`src/worker.ts` is the process entrypoint. It owns stdin/stdout RPC, session
queues, browser launch and shutdown, execution orchestration, network guards,
download approvals, and secret tracking. Do not import it into tests: importing
it installs process handlers and emits the ready handshake.

The worker constructs these internal modules before accepting messages:

| Module | Responsibility and owned state |
| --- | --- |
| `worker-session.ts` | Session construction and the shared page limit. The worker owns the session registry. |
| `worker-live-view.ts` | Live-view instance, preferred session, chat, asks, and handoffs. |
| `worker-artifacts.ts` | Artifact paths and quotas, recording ownership, screenshots, and annotations. |
| `worker-snapshots.ts` | Snapshot generation, password-value scrubbing, and per-page diff caches. |
| `worker-realm.ts` | Playwright facades, restricted methods and paths, VM globals, and result serialization. Owns facade-to-object identity. |
| `worker-human.ts` | Trusted input targeting, clearing, and typing recovery. |
| `worker-site.ts` | Request history, guarded same-origin HTTP requests, and WebAgents discovery caches. |
| `challenge-scan.ts` | Challenge metadata collection, scan gating, and session reporting. |
| `captcha-runtime.ts` | Browser CAPTCHA interaction and puzzle capture. Uses the pure algorithms in `captcha-solver.ts`. |
| `worker-sandbox.ts` | Composes the model-callable APIs for one execution using the trusted operations above. |
| `credential-fill.ts` | Credential resolution, trusted filling, and pending-credential operations. |

Factories receive the operations they need. Browser and configuration getters
are evaluated at use time, so a factory does not retain an obsolete context
across launches. The modules do not import the worker entrypoint.

## Ordering contracts

- Execute, credential operations, and session close use per-session queues.
  Separate sessions can run concurrently.
- RPC replies, live-view control, asks, and handoffs bypass those queues.
  Queueing an RPC reply behind the operation waiting for it would deadlock.
- Cookie Sync uses its own global busy gate.
- Execution joins credential tasks and flushes page events before accepting
  the result. Result envelopes refresh cookie secrets before redaction.
- Download permissions are browser-wide and reference-counted; approval is
  still checked against the owning session.
- Recording finalization, parking, context close, and profile release retain
  their existing ordering in the entrypoint.
- Explicit live-view stop notifies viewers. Worker shutdown passes
  `{ notify: false }` so viewers can reconnect after worker replacement.
- Callbacks serialized into a page must be self-contained. They cannot close
  over imported host helpers.

## Verification

Run `bun run lint`, `bun run typecheck`, `bun run check:build`, and
`bun run test:types`. The formatter is disabled; match the existing hand style.

Run `BETTERWRIGHT_REQUIRE_BROWSER=1 bun run test` for the unit and managed-browser
suites. `test:unit` omits `tests/node/browser.test.ts` and is insufficient for a
worker refactor. The `worker-*.test.ts` files also verify that extracted modules
can be imported without worker process wiring.

For black-box coverage of the built CLI:

```sh
bun tests/e2e/run.ts --binary bun \
  --binary-arg "$PWD/dist/bin/betterwright.js" --require-all
```

Do not rebuild `dist/` while browser tests are running. Each new worker process
loads the built modules, including dynamic imports during an execution.
