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

await credentials.update({ id: "cred_…", label: "work account" });
await credentials.remove({ id: "cred_…" });
```

`save`, `list`, `update`, and `remove` return only metadata — `id`, `origin`,
`username`, `label`, timestamps. `fill` and `generateAndFill` fail explicitly in
`run()` because filling a normal DOM input would let the same snippet read,
encode, or transmit the secret. To actually fill, call the trusted host method
below — never a `run()` snippet.

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

**Using a password-manager extension instead (attach mode).** If you drive your
own Chrome with a 1Password (or similar) extension installed and unlocked, the
agent can trigger the extension's inline autofill menu and BetterWright never
handles the secret at all. See [attach-mode.md](attach-mode.md).

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
