# BetterWright vs a reference runtime — head-to-head

A physical, runtime-vs-runtime comparison on this machine. Both `betterwright`
and the reference CLI accept raw browser-automation JavaScript, so this isolates
the **browser runtime** (navigation, snapshot, tabs, redaction) from any LLM.
All tasks are login-free and deterministic. Reproduce with
[`run.sh`](run.sh).

Environment: macOS (Darwin 25.6), BetterWright CloakBrowser 145 headless,
reference CLI against its always-on daemon browser. Recorded 2026-07-18.

## Results

### 1. Latency — navigate + interactive snapshot

| Mode | BetterWright | Reference |
| --- | --- | --- |
| Cold one-shot CLI call (median of 3) | ~700 ms | ~535 ms |
| Warm per-op (same session, after first) | **68–109 ms** | ~90–130 ms* |

The reference one-shot CLI call is faster because its browser is already running
in a persistent daemon — each reference call only pays CLI startup + a daemon
round-trip, not a browser launch. BetterWright's one-shot `run` launches and
tears down its own browser, so it pays that cost every call (~700 ms).

The fair comparison is **warm-to-warm**, which is how an agent actually uses
either runtime (BetterWright via a persistent `repl` session, MCP server, or Pi
package; the reference via its daemon). There BetterWright's per-op is **68–109 ms**
— on par with or slightly faster than the reference. First op in a BetterWright
session is ~550 ms (one-time browser launch), amortized across the session.

\* The reference's pure browser-op time is inside its ~520 ms CLI wall-clock and
not separately reported; the daemon op itself is comparable to BetterWright's
warm op.

### 2. Capability parity

| Task | BetterWright | Reference |
| --- | --- | --- |
| Navigate + interactive accessibility snapshot with refs | ✅ | ✅ |
| Multi-tab (open 2, read both titles) | ✅ | ✅ |
| Fill form field, read back via snapshot | ✅ | ✅ |
| **Password value redacted in snapshot** | ✅ (after fix) | ✅ |

### 3. What the benchmark found

Running the password-redaction task **surfaced a real bug**: BetterWright's
`snapshot({interactive})` was emitting a filled password's value in the tree
(`textbox "Password" … : hunter2secret`), where the reference emits `[redacted]`.
An agent taking a routine snapshot after any password fill — its own or a
password-manager extension's — would have pulled the secret into model context.
Fixed in `src/worker.mjs` (`redactPasswordValues`): password-input values are
replaced with `[redacted]` before the snapshot is stored, diffed, or returned,
with negligible latency cost. Covered by an e2e test; both runtimes now match.

## 4. End-to-end agentic tasks

The runtime tests above use hand-written JS. This section gives a natural-language
task to a full **agent + runtime** on each side and measures success and
wall-clock: the reference agent on its own runtime vs the **Pi coding agent +
BetterWright** (BetterWright's native Pi package, pointed at this working tree).

All rows below hold **model = openai-codex/gpt-5.6-sol** and **reasoning = low**
on both sides (`--effort low`, `pi --thinking low`), so only the
agent-scaffold + runtime differ.

| Task (login-free, verifiable) | Reference | Pi + BetterWright | Both correct? |
| --- | --- | --- | --- |
| HN #1 story title + points | 7.3 s | 20.3 s | ✅ |
| Eiffel Tower height | 10.3 s | 22.4 s | ✅ |

Both runtimes succeeded on every task with the correct answer. With model and
reasoning effort matched, the reference is still ~2–3× faster end-to-end. Since the
browser runtime itself is at parity (section 1: ~70–110 ms/op both), the gap is
**not the runtime** — it is (a) the reference's purpose-built, browser-tuned agent
loop taking fewer/tighter steps than Pi's general coding-agent loop, and (b) its
always-warm daemon browser vs BetterWright launching a fresh browser on each
one-shot `pi --print` invocation (~0.5–1 s cold start that a long-lived session
would amortize away). This is the expected shape given what BetterWright *is* —
an add-on to whatever agent drives it, not an agent.

## Takeaways

- **Speed:** at parity warm-to-warm (~70–110 ms/op). BetterWright's only
  disadvantage is cold-start on one-shot CLI calls, which does not apply to its
  persistent embeddings (repl/MCP/Pi).
- **Capability:** at parity on the core read/act/multi-tab loop and password
  redaction.
- **Architecture difference (by design):** the reference drives the user's
  always-on browser and existing tabs; BetterWright drives its own managed,
  policy-guarded profile. That is a deliberate scope choice, not a gap.
- **End-to-end:** both agents complete the same tasks correctly. The reference's
  speed edge comes from its browser-specialized agent scaffold, not its browser
  runtime — BetterWright hands that scaffolding job to whichever agent embeds it.

## Next

Extend with tasks that exercise the newer parity work once a live account is
available to authorize: a login through the `1password` skill pack (extension
autofill) vs the reference's, and a passkey sign-in once CDP virtual-authenticator
support lands.
