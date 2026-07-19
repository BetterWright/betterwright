# Credential manager

BetterWright includes an encrypted password vault by default. It lives outside
the browser profile, exposes only account metadata to agent code, matches login
items to the current site, and resolves the password only while the worker is
filling a detected form.

## The agent flow

On a login page, inspect matching accounts and let BetterWright find the fields:

```js
const form = await credentials.inspect();
const accounts = await credentials.list({ text: "work", category: "login" });
if (accounts.length !== 1) {
  return { form, accounts, needsAccountSelection: true };
}
await credentials.fill({ id: accounts[0].id, submit: true });
```

`inspect()` reports field roles and ambiguity, never values. `list()` returns
metadata such as `id`, `username`, `label`, `category`, URL policy, and
timestamps. It never returns a password or other secret.

`fill()` detects the visible username, current-password, and submit controls
from autocomplete tokens, input types, names, labels, ARIA text, and form
proximity, including forms in child frames and open shadow roots. A
password-only second step is valid. If multiple plausible forms remain, the
call fails instead of guessing; use targets from a fresh snapshot:

```js
await credentials.fill({
  id,
  usernameSelector: "aria-ref=e2",
  passwordSelector: "aria-ref=e3",
  submitSelector: "aria-ref=e4",
});
```

Targets may be CSS or current `aria-ref=eN` locators. Existing selector-based
integrations continue to work. `submit: true` detects the form's submit action;
without it, filling does not submit.

The same operation is available as:

- `bw.fillCredential({ id, submit: true })` in the JavaScript SDK.
- `browser_login` in MCP and Pi.
- The `login` tool in BetterWright's built-in agent.

All return only metadata: which field roles were filled, whether the form was
submitted, the selected record id/username, and timing/page information.

## Signup and rotation

Generated passwords use a two-phase flow so a rejected signup never becomes a
saved login:

```js
const pending = await credentials.generateAndFill({
  username: "ada@example.com",
  matchMode: "exact-origin",
  submit: true,
});

// Verify the page's real success state first.
if ((await page.getByRole("heading").textContent()) === "Account created") {
  await credentials.commitGenerated({ pendingId: pending.pendingId });
} else {
  await credentials.discardGenerated({ pendingId: pending.pendingId });
}
```

The generated value is written atomically as a provisional entry inside the
encrypted vault before it is typed into detected `new-password` and
confirmation fields. It is excluded from list, match, and fill until
`commitGenerated()` promotes it, so a rejected signup never becomes an active
login. The normal finalization window is 60 seconds. After that window or a
process restart, the exact returned `pendingId` and matching site can still
recover or discard the provisional entry; BetterWright never guesses among
concurrent signups and never silently deletes the only copy of an accepted
password.

If generation reaches the vault but the page detaches, times out, or the worker
exits before filling can report success, the failed result includes a
secret-free `pendingCredential` recovery object. Do not blindly generate
another password. Inspect the site's visible outcome, then commit or discard
that pending id. The provisional entry itself survives a new host process. If
the whole host exited before it could return the id, revisit the matching site
and call `credentials.listPending()` (or host-side
`bw.listPendingCredentials()`) to recover secret-free ids and timestamps. Never
auto-pick when several attempts are present. A live host also retains the exact
frame origin across worker restarts and redirects.

One browser execution may create at most one generated credential. This keeps a
failure envelope unambiguous: it can always identify the one provisional entry
that needs recovery. Finalize it, then start another generation in a later
execution.

New generated logins use `base-domain` matching by default. Pass `matchMode` as
`host`, `exact-origin`, or `never` when the account needs a narrower policy.
Failed or abandoned attempts should always call `discardGenerated()` so they do
not consume the bounded provisional-entry capacity.

For a password change, pass the existing record `id` to
`generateAndFill({id, ...})`. A successful commit updates that record in place
rather than creating a duplicate. When the change form has a current-password
field, BetterWright fills it from that same record before generating matching
new-password and confirmation values. Rotation preserves the record's existing
URL scope; update its `matchMode` separately before rotating if the scope must
change.

Trusted SDK hosts can call `generateAndFillCredential()`, verify success, then
`commitGeneratedCredential()` or `discardGeneratedCredential()` with the
returned pending id. `listPendingCredentials()` recovers provisional metadata
for the current site after a complete process restart.

## Save and manage records

Use `save` only for a supplied secret the user explicitly wants remembered,
and only after the site accepts it:

```js
await credentials.save({
  username: "alice",
  password: "task-supplied password",
  label: "work",
  matchMode: "base-domain",
});

await credentials.update({ id, label: "primary work account" });
await credentials.remove({ id });
```

Login is the default category. Other supported categories include
`credit-card`, `identity`, `api-credential`, `secure-note`, and `ssh-key`; they
store category-specific `fields`. Model-visible responses stay metadata-only.

## Site matching

Each login stores the URL where it was accepted and a match mode:

- `base-domain` (default): registrable-domain matching backed by the Public
  Suffix List, including private suffixes. Related service subdomains can share
  a login, while separate tenants such as `a.github.io` and `b.github.io` do
  not.
- `host`: the hostname must match; ports and paths may differ.
- `exact-origin`: scheme, hostname, and effective port must match.
- `never`: keep the item out of matching/list/fill; an explicit id can still
  update or remove it from its exact saved origin.

An HTTPS-saved item is never offered on HTTP. Local `*.localhost` development
sites receive deterministic tenant-aware matching; IP addresses and a bare
`localhost` stay host-scoped. `list()` and `fill()` apply these rules before any
secret is resolved.

## Storage and auditing

The default store is under `$BETTERWRIGHT_HOME/vault/`:

```text
vault/
├── vault.key
├── vault.enc
├── audit.jsonl
└── vault.lock/
    └── owner.json
```

The complete record table is authenticated and encrypted with AES-256-GCM and a
fresh random nonce on every atomic rewrite. Directories are owner-only where
the platform supports permissions; the key, ciphertext, lock directory, and
metadata-only audit log use owner-only modes. Active records and provisional
generated secrets share the same authenticated atomic snapshot. Writes are
serialized across clients. Lock ownership combines a heartbeat with an
immutable OS process identity, so an old PID can be distinguished from a live
owner after PID reuse without stealing an active lock. The audit log keeps
timestamp, action, matched site, and opaque record id, never usernames or
secrets. A mutation is persisted before its audit append; if that append fails,
the successful result contains the bounded, secret-free
`auditWarning.code === "AUDIT_WRITE_FAILED"`. Treat the mutation as committed
and repair audit storage instead of retrying it blindly.

Handled secrets remain in the worker's redaction set for as long as its pages
can still expose them. If that bounded set fills, BetterWright returns a static
failure and restarts the worker instead of evicting old plaintext while an old
page is alive.

The default key file protects against plaintext logs, support bundles, casual
file inspection, and copying only the ciphertext. It is not a defense against
malware or another process already able to read files as the same OS user.
Use an external password manager or secret service when that is in scope for
your threat model.

## Custom or disabled vaults

Pass a custom adapter to keep credentials in 1Password, Bitwarden, a cloud
secret service, or another host-controlled store:

```js
new BetterWright({
  vault: {
    async handleRequest(action, payload, origin) {
      // list | list-pending | save | update | remove | fill | generate | commit | discard
    },
  },
});
```

Every request includes the canonical current HTTP(S) origin. A custom adapter
must enforce its own URL and access policy and must return `secret` only for the
internal `fill`/`generate` response. BetterWright removes it from public results
and tracks it for worker-side output redaction. An adapter may also implement
the optional `redact(value)` hook as a second host-side pass, but it must replace
every active secret rather than returning its input unchanged. Adapters that
retain their own redaction material may implement `resetRedactionSecrets()`;
BetterWright calls it only after the owning worker and all its pages close.
For `save` and `update`, passwords, notes, and every nested string value under
`fields` are registered with the worker redaction net before the adapter runs.
Credential promises started by sandbox code are joined to that browser
execution even if the snippet forgets to await them, so recovery state cannot
bleed into the next run.

For `generate`, BetterWright supplies an opaque `pendingId` before storage. A
custom adapter must persist and echo that id, and retries with the same id and
identical request must return the same provisional secret. `list-pending` must
return only current-site metadata under `pendingCredentials`; it must never
include a secret. These rules make generation recoverable across ambiguous I/O
failures and complete host restarts.

Set `vault: false` (or `null`) to disable credential management for a browser.
An unlocked extension can still autofill in a headed persistent profile.

## Boundary

Vault APIs never return stored or generated secrets to the model. Snapshots,
control inspection, console output, serialized results, and direct password
field read-back are scrubbed as a final net. Like every browser password
manager, the filled value necessarily exists in the live page DOM and is
available to that site's JavaScript. Do not treat arbitrary model-authored code
plus an unlocked vault as isolation from a malicious page; site matching,
trusted worker fill, provisional-entry isolation, and output redaction limit
the exposure rather than changing the web platform.
