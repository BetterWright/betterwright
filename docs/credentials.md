# Credential vault

The vault is an encrypted, origin-scoped store for trusted host code. A model
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

`bw.fill_credential(...)` / `bw.fillCredential(...)` performs the fill in the
worker, outside the model sandbox. The worker fetches the secret over the vault
RPC, types the username, password, and (optionally) a confirm-password field,
and can submit the form — then returns only non-secret metadata. The password
never enters a model snippet, never comes back to your process, and is redacted
from run output as a final net.

```python
# Fill an existing stored login and submit in the same trusted call.
bw.vault.save("https://example.com", "alice", "…")
bw.fill_credential(
    username="alice",
    username_selector="#username",
    password_selector="#password",
    submit_selector="#submit",
)

# Sign up: generate a strong password, store it, and fill both password fields.
bw.generate_and_fill_credential(
    username="ada@example.com",
    username_selector="#email",
    password_selector="#password",
    confirm_password_selector="#confirm-password",
    submit_selector="#create-account",
)
```

```js
await bw.fillCredential({
  username: "alice",
  usernameSelector: "#username",
  passwordSelector: "#password",
  submitSelector: "#submit",
});
await bw.generateAndFillCredential({
  passwordSelector: "#password",
  confirmPasswordSelector: "#confirm-password",
});
```

Select the record with `record_id`/`id` or `username` (the newest match wins
otherwise). `confirm_password_selector` receives the same secret and is blurred
so forms that validate the match on blur (not just on input) run their check.
Pass `submit_selector` to submit in the same call, so no model turn ever sees the
secret sitting in a field. The return value lists which `filled` fields were set
and whether it `submitted`.

**Using a password-manager extension instead (attach mode).** If you drive your
own Chrome with a 1Password (or similar) extension installed and unlocked, the
agent can trigger the extension's inline autofill menu and BetterWright never
handles the secret at all. See [attach-mode.md](attach-mode.md).

## What the store guarantees

- **Encrypted at rest.** Records are one AES-256-GCM payload with a 256-bit key
  stored beside the ciphertext at `~/.betterwright/vault/`, owner-only
  permissions, written atomically. The username and password are not present in
  plaintext on disk.
- **Origin-scoped.** Every record is keyed to a canonical `http(s)` origin
  (`scheme://host[:port]`, default ports and user-info stripped). A request from
  one origin cannot read another's credential.
- **Audited.** Each operation appends `{timestamp, action, origin, record_id}`
  to `audit.jsonl` — enough to see what happened, with no secret in the log.
- **Redacted on the way out.** Every value the vault has handled is scrubbed from
  `run()` output as a final safety net. Redaction is not treated as authorization
  and is not used to make DOM filling safe.

## What it is not

The key sits next to the ciphertext with restrictive permissions. That protects
against accidental disclosure — logs, support bundles, a casual file read, a
plaintext backup — but it is **not** a defense against an attacker who can
already read files as your OS user. If you need that, run BetterWright as a user
whose home directory is not readable by the workloads you are defending against,
or wire a platform keychain in behind the same API. The threat this closes is
"the password ended up somewhere it shouldn't," not "the disk was compromised."

## Using the vault from your own code

The vault is a normal class you can drive directly — useful for seeding
credentials before an agent runs, or for building your own tooling.

```python
from betterwright import CredentialVault

vault = CredentialVault()                     # ~/.betterwright/vault
vault.save("https://example.com", "alice", "…", label="primary")
for record in vault.list_credentials("https://example.com"):
    print(record["id"], record["username"], record["updated_at"])
```

Pass a `vault=` instance to `BetterWright(...)` to share one store, or
`vault=False` to disable the model-facing management helpers entirely. Trusted
host code can call `fetch_for_fill`, `reveal`, or `generate` directly, but must
not return those secret-bearing results to model-authored code — prefer
`bw.fill_credential(...)`, which keeps the secret inside the worker.

The `vault=` object is a pluggable backend: any object exposing
`handle_request(action, payload, origin)` (and optionally `redact`) can back the
same `fill_credential` path, so an alternate source such as a 1Password CLI/SDK
backend can be dropped in without changing the fill code.
