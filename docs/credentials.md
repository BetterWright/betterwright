# Credential vault

![A password flows from the vault into a login field without being exposed](assets/credentials.png)

Agents that complete real tasks have to log in. Putting passwords in the
prompt, in the model's context, or in the automation script is how they leak.
The vault lets an agent fill a login form without the password ever being
returned to the model: the agent asks for a fill by origin, and the trusted
worker types the stored value into the page.

## The model-facing contract

Inside a `run()` snippet, the `credentials` helpers operate on the current
page's origin (which must be `http(s)`):

```js
// Store a password you were given for this task
await credentials.save({ username: "alice", password: "…" });

// Generate a strong password and type it straight into the form
await credentials.generateAndFill({ username: "alice", length: 24 });

// Fill a stored password into the visible password field
await credentials.fill({ username: "alice" });      // or fill({ id: "cred_…" })

// Inspect what is stored for this origin — metadata only, never the password
await credentials.list();

await credentials.update({ id: "cred_…", label: "work account" });
await credentials.remove({ id: "cred_…" });
```

`save`, `list`, `update`, and `remove` return only metadata — `id`, `origin`,
`username`, `label`, timestamps. `fill` and `generateAndFill` return
`{filled: true, origin, username, passwordFields}`. **No method returns the
password to the snippet.** `generateAndFill` never exposes the value it created;
it exists so an agent can set a fresh password without ever seeing it.

`fill` locates the username and password fields with sensible default selectors;
pass `usernameSelector` / `passwordSelector` when a page needs them. The fill is
aborted if the page navigates to a different origin partway through, so a
credential for one site cannot be typed into another.

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
  `run()` output as a final safety net, so a password that ends up in page text
  or an error message is replaced with `[REDACTED]` before it reaches the model.

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
`vault=False` to disable the `credentials` helpers entirely.
