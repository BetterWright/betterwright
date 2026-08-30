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

If detection reports an ambiguous change-password form, pin each role from a
fresh snapshot. BetterWright resolves and validates all handles before reading
either secret:

```js
await credentials.generateAndFill({
  id,
  currentPasswordSelector: "aria-ref=e2",
  passwordSelector: "aria-ref=e3",
  confirmPasswordSelector: "aria-ref=e4",
});
```

Trusted SDK hosts can call `generateAndFillCredential()`, verify success, then
`commitGeneratedCredential()` or `discardGeneratedCredential()` with the
returned pending id. `listPendingCredentials()` recovers provisional metadata
for the current site after a complete process restart.

## Save and manage records

Use `save` only from a trusted host-authored channel, for a user-supplied secret
the application has confirmed the site accepted. Never let a model author or
inspect this payload; agent-facing code should remain metadata-only:

```js
async function rememberAcceptedCredential({ username, password }) {
  const payload = JSON.stringify({
    username,
    password,
    label: "work",
    matchMode: "base-domain",
  });
  return bw.run(`return credentials.save(${payload});`);
}
```

Metadata-only agent code may update or remove an existing record:

```js
await credentials.update({ id, label: "primary work account" });
await credentials.remove({ id });
```

Login is the default category. Other supported categories include
`credit-card`, `identity`, `api-credential`, `secure-note`, and `ssh-key`; they
store category-specific `fields`. Model-visible responses stay metadata-only.

## Browser capture

Accepted logins are captured automatically at the browser level, so the vault
stays populated without any agent code calling `save`:

- **The model types a login or signup.** Any accepted credential submission on
  a page the model just drove is saved silently (an upsert with `base-domain`
  matching and the host as label). This covers signups done by typing instead
  of `generateAndFill`; when `generateAndFill` + `commitGenerated` already
  saved, the capture is a no-op rewrite.
- **The user logs in by hand in a headed window.** After the site accepts the
  login, an in-page banner asks "Save password?" with **Save**, **Not now**,
  and **Never for this site**. Choosing an existing username's account offers
  "Update saved password?" instead. "Never" is remembered per origin in
  `$BETTERWRIGHT_HOME/browser/save-prompt.json` (owner-only). In headless
  sessions there is nobody to ask, so user-driven captures are dropped.

Capture is implemented by a worker-injected sensor running in a dedicated CDP
isolated world per frame (`src/vault-sensor.ts` + `src/vault-capture.ts`),
not an extension and not page-visible JavaScript. Only trusted initiating click
or Enter-key events (`event.isTrusted`) trigger a capture; a submit event alone
is deliberately insufficient because Chromium can mark a page-script-initiated
submit as trusted. A capture is only kept when the login appears
accepted: the frame navigates somewhere new, or the app unmounts the password
field within a few seconds of submitting. A rejected attempt (the form
re-renders with an error, or the password is cleared for a retry) is never
saved — the same rule the two-phase generated-credential commit enforces.

Captured passwords enter the worker redaction set the moment they arrive, and
the banner never displays the password; it stays in worker memory until the
save or dismissal. Saves reuse the ordinary vault `save` path, so matching,
upsert, limits, and audit entries are identical to `credentials.save`.

Capture is on by default whenever a vault is active. Disable it with
`credentialCapture: false` (it is forced off when `vault` is `false`/`null`).
Login forms inside cross-site iframes (OOPIFs) are not captured; SSO flows
that redirect or open a popup are covered.

## Getting a password back (`betterwright vault`)

Everything above is agent-facing: site-scoped, metadata-only, and deliberately
incapable of returning a secret. That is the right shape for model-authored
code, and the wrong shape for you — a password the agent generated during a
signup, or captured from a login you typed, would otherwise be unreachable.

`betterwright vault` is the human door. It talks to the vault's owner-only API
rather than the worker RPC, so nothing here widens what agent code can do:

```bash
betterwright vault list                    # every record, metadata only
betterwright vault list --query github     # filter by site, username, or label
betterwright vault show <id>               # one record; password stays hidden
betterwright vault copy <id>               # password → clipboard
betterwright vault type <id>               # type into the focused window
betterwright vault show <id> --reveal      # print it to the terminal
betterwright vault rm <id>                 # delete one record
betterwright vault audit                   # recent activity, metadata only
betterwright vault path                    # where the encrypted files are
```

Ids come from `list`; any unambiguous prefix works (`vault copy cred_4c8`).

Three rules govern the one operation that produces plaintext:

- **Nothing prints a secret unless you ask.** `list` and `show` are
  metadata-only; `--reveal` is the explicit request.
- **`--reveal` writes only to a terminal.** Redirect it, pipe it, or run it
  where something captures stdout and it refuses, pointing at `vault copy`
  instead. `--force` (or `BETTERWRIGHT_VAULT_ALLOW_NON_INTERACTIVE=1`)
  overrides that when you genuinely mean to redirect. This guards against
  passwords landing in files and CI logs by accident; it is not a defense
  against someone who already has your shell — see
  [SECURITY.md](../SECURITY.md#the-shell-is-a-trusted-channel).
- **Every reveal is audited.** `owner-reveal` entries carry the timestamp,
  record id, and site — never the secret — and show up in `vault audit`.

`vault copy` is the recommended path when the destination accepts a paste: the
password goes to the clipboard through the platform's own tool (`pbcopy`,
`clip`, `wl-copy`/`xclip`/`xsel`) and never enters terminal scrollback or
shell history.

`vault type` is the path when paste is blocked — Proxmox noVNC, some VNC/SPICE
consoles, a few remote-desktop clients. It waits five seconds (override with
`--delay`), then types the password as keystrokes into whichever window has
focus. The secret is piped to the platform tool on stdin so it never appears
in `ps` or shell history. `--key-delay` (default 25ms) paces keystrokes for
consoles that drop characters typed too fast. `paste` is an alias.

Uncommitted signup passwords — a `generateAndFill` that never reached
`commitGenerated` — are listed separately and can be revealed by their pending
id, which is how you recover an account whose signup succeeded but whose commit
did not.

The same operations are on the vault object for trusted JavaScript hosts:
`ownerList()`, `ownerReveal(id)`, `ownerRemove(id)`, and `ownerAudit()`. They
are intentionally absent from `handleRequest`, the surface the worker and
therefore model code addresses; a custom adapter does not need to implement
them, and `betterwright vault` always talks to the built-in local vault.

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
secrets. Owner-only operations append there too (`owner-reveal`,
`owner-remove`), so a read that exposed plaintext leaves the same trail a write
does. A mutation is persisted before its audit append; if that append fails,
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

Vault APIs never return stored or generated secrets to the model. The
owner-only methods that do (`ownerReveal`, and `betterwright vault
show --reveal` / `copy` / `type` on top of them) are not routed by `handleRequest`, so
the browser worker cannot reach them however a snippet is written; they are for
a trusted host acting for the person who owns the files. Snapshots,
control inspection, console output, serialized results, and direct password
field read-back are scrubbed as a final net. Like every browser password
manager, the filled value necessarily exists in the live page DOM and is
available to that site's JavaScript. Do not treat arbitrary model-authored code
plus an unlocked vault as isolation from a malicious page; site matching,
trusted worker fill, provisional-entry isolation, and output redaction limit
the exposure rather than changing the web platform.
