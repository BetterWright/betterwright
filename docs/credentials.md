# Credential vault

The vault is an origin-scoped credential backend supplied by trusted host
code. A model
snippet with arbitrary DOM access can read any password typed into a page, so
BetterWright intentionally does not expose vault-backed filling inside `run()`.

## The model-facing contract

Inside a `run()` snippet, the non-secret management helpers operate on the
current page's origin (which must be `http(s)`):

```js
// Store a password you were given for this task
await credentials.save({ username: "alice", password: "…" });

// Inspect what is stored for this origin — metadata only, never the password
await credentials.list();

// Filter the current origin's records by text and/or category
await credentials.list({ text: "work", category: "login" });

// Non-login records carry their own metadata instead of a password
await credentials.save({ category: "identity", label: "Home address", fields: { … } });

await credentials.update({ id: "cred_…", label: "work account" });
await credentials.remove({ id: "cred_…" });
```

`save`, `list`, `update`, and `remove` return only metadata — `id`, `origin`,
`username`, `label`, `category`, timestamps. `list()` accepts an optional
`{text, category}` filter, applied by the vault backend. `category` defaults to
`login`; other categories (`credit-card`, `identity`, `api-credential`,
`secure-note`, `ssh-key`) store their own non-secret metadata and do not require
a `password`. `fill` and `generateAndFill` fail explicitly in `run()` because
filling a normal DOM input would let the same snippet read, encode, or transmit
the secret. To actually fill, use the trusted path below — never a `run()`
snippet.

## Filling from trusted host code

`bw.fillCredential(...)` performs the fill in the
worker, outside the model sandbox. The worker fetches the secret over the vault
RPC, types the username, password, and (optionally) a confirm-password field,
and can submit the form — then returns only non-secret metadata. The password
never enters a model snippet, never comes back to your process, and is redacted
from run output as a final net.

```js
// Fill an existing stored login and submit in the same trusted call.
await bw.fillCredential({
  username: "alice",
  usernameSelector: "#username",
  passwordSelector: "#password",
  submitSelector: "#submit",
});

// Sign up: generate a strong password, store it, and fill both password fields.
await bw.generateAndFillCredential({
  username: "ada@example.com",
  usernameSelector: "#email",
  passwordSelector: "#password",
  confirmPasswordSelector: "#confirm-password",
  submitSelector: "#create-account",
});
```

Select the record with `id` or `username` (the newest match wins
otherwise). `confirmPasswordSelector` receives the same secret and is blurred
so forms that validate the match on blur (not just on input) run their check.
Pass `submitSelector` to submit in the same call, so no model turn ever sees the
secret sitting in a field. The return value lists which `filled` fields were set
and whether it `submitted`.

**From MCP and Pi, not just the SDK.** The same trusted fill is exposed as a
`browser_login` tool by both the MCP server and the native Pi package, so all
three embeddings can log in and sign up — not only the in-process JS client. The
tool takes the same selectors (`passwordSelector` required, plus
`usernameSelector`/`confirmPasswordSelector`/`submitSelector`), `id`/`username`
to pick a record, and `generate`/`length`/`includeSymbols`/`label` for signup.
The fill still runs as a dedicated worker message, never as model JavaScript, and
the vault RPC is **origin-scoped**: `browser_login` can only fill the credential
for the page's current origin — the same reach an unlocked password-manager
extension gives, never a way to harvest another site's secret.

`browser_login` needs a configured vault. Pass one to `runMcpServer(env, {
vault })` or Pi `browserOptions.vault`. Without a vault — for example plain `npx
betterwright mcp` — the tool reports that none is configured; log in through a
password-manager extension's autofill instead (see the `1password` and
`bitwarden` [skill packs](skills.md)).

**Using a password-manager extension instead.** Install and unlock 1Password (or
a similar extension) once in BetterWright's persistent headed Cloak profile.
The agent can then trigger its inline autofill menu without BetterWright
handling the secret. See [headed browsing](attach-mode.md).

## Providing a vault

BetterWright has no built-in credential store. The `vault` option is a
pluggable backend: any object exposing
`handleRequest(action, payload, origin)` (and optionally `redact`) can back the
management helpers and the same `fillCredential` path, so a source such as a
1Password CLI/SDK backend can be dropped in without changing the fill code.

```js
new BetterWright({
  vault: {
    async handleRequest(action, payload, origin) { /* list|save|update|remove|fill|generate */ },
    redact(value) { return value; },   // optional: scrub secrets from output
  },
});
```

Every request carries the canonical `http(s)` origin of the current page
(`scheme://host[:port]`, default ports and user-info stripped); scope records
to it so one origin cannot read another's credential. If the backend provides
`redact`, every value it has handled is scrubbed from `run()` output as a final
safety net — redaction is not treated as authorization and is not used to make
DOM filling safe. Trusted host code must not return secret-bearing vault
results to model-authored code — prefer `bw.fillCredential(...)`, which keeps
the secret inside the worker. Omit `vault` to run without credential
management helpers entirely.
