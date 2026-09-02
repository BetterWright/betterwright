# Security

BetterWright hands a browser to automated, sometimes model-authored, code. Its
threat model and the controls that enforce it are documented in
[docs/architecture.md](docs/architecture.md#security-model). In short:

- **The network floor** (metadata endpoints and private networks blocked at the
  resolver, transport proxy, and policy layers) is the real boundary and fails
  closed.
- **The sandbox** removes the escape-hatch APIs from model code as defense in
  depth. It is not, and does not claim to be, a `node:vm` security boundary.
- **The credential vault** encrypts records at rest, URL-gates login lookup,
  fills detected forms without returning secrets, and redacts handled values
  from outputs. The filled value still exists in the matched page's DOM, and
  the local key file does not defend against an attacker who can already read
  files as the same OS user. External vault adapters remain available for a
  stronger key-management boundary.

Please read those sections before deploying BetterWright somewhere it can be
driven by untrusted input.

## Cookie Sync is a trusted transfer

Cookie Sync reads authentication cookies from another local browser profile.
It is exposed only through the host SDK and CLI, never as a model tool. Values
do not enter configuration, command arguments, or the profile daemon socket,
and the sync result contains metadata and counts only. Raw request/response
header access is absent from model snippets. Synced bearer-like
values and serialized short cookie pairs are redacted from later result
envelopes, including after a local profile restart. Unsupported browser
isolation is skipped rather than widened, and sync refuses an ephemeral
destination profile.

This output redaction is defense in depth, not a confidentiality boundary
against hostile model code. A page can read its own non-HttpOnly cookies, and
model-authored page code can transform a value before returning it, just as it
can transform a password already filled into that page's DOM. Scope Cookie
Sync to the origins and destination profile the task needs.

Remote sync requires consent naming the exact provider or CDP host before
extraction or provider session creation. The cookie then travels over the
encrypted CDP WebSocket, but the provider necessarily receives it in its
browser process and can observe subsequent authenticated traffic. Windows
Chrome App-Bound recovery is a separate opt-in because it uses unprivileged
process injection; BetterWright never enables the reader's elevated fallback.
See [docs/cookie-sync.md](docs/cookie-sync.md) for the platform matrix and
operational limits.

## The shell is a trusted channel

`betterwright vault show --reveal`, `betterwright vault copy`, and
`betterwright vault type` return stored passwords to the person running them.
That is the point: the vault would otherwise be a one-way door, with no
supported way to recover a password an agent generated during a signup.

Be clear about what this does and does not change:

- **It does not weaken the sandbox.** Those operations live on the vault's
  owner-only API, which `handleRequest` — the sole surface the browser worker
  and therefore model-authored snippet code can address — cannot route to.
  Snippets still get metadata only.
- **It does not defend against a hostile shell.** Anyone who can run
  `betterwright vault` can already read `vault.key` and `vault.enc` as the same
  OS user. If you give an agent an unrestricted shell tool on a machine with a
  populated vault, that agent can read the vault, with or without this command.
  Scope the agent's shell, run it as a different OS user, or use an external
  vault adapter whose key material lives somewhere the agent cannot reach.

The `--reveal` gate is about **accidental** exposure, not adversarial access:
every command that would put plaintext on stdout refuses to run when stdout is
not a terminal, so a redirect, a pipe, a CI log, or a tool capturing stdout
cannot collect a password by mistake. Overriding it takes a deliberate
`--force` (or `BETTERWRIGHT_VAULT_ALLOW_NON_INTERACTIVE=1`). `vault copy` and
`vault type` are exempt because the secret goes to the clipboard or the focused
window and never to stdout. Every reveal is written to the metadata-only audit
log (`betterwright vault audit`).

## Reporting a vulnerability

Report suspected vulnerabilities privately via GitHub's **Report a
vulnerability** flow (Security → Advisories) on the repository, rather than
opening a public issue. Please include a description, affected version, and a
minimal reproduction. We aim to acknowledge reports within a few days.

Because the network floor is the boundary we rely on, a way to reach a blocked
metadata endpoint or private address from inside a `run()` snippet — bypassing
the resolver rules, the transport proxy, and the policy — is the highest-severity
class of report.
