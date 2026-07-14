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
encode, or transmit the secret. Use `CredentialVault` directly from trusted host
code when integrating a future trusted login handoff.

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
not return those secret-bearing results to model-authored code.
