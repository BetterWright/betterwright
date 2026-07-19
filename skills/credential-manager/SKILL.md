---
name: credential-manager
description: Read this before any login, signup, password change, or checkout so the right credential source is used in the right order without ever exposing a secret.
autoInject:
  keywords: ["login", "log in", "sign in", "sign-in", "sign up", "signup", "password", "credential", "checkout", "payment", "2fa", "mfa"]
---
# Credential manager

Use metadata to choose an account, then let the password manager detect and
fill the form. Never fetch, inspect, transform, or print a stored secret.

## Source order

Work down this ladder; stop at the first source that works.

1. **A configured external manager.** If the operator prompt explicitly names
   1Password or Bitwarden, use its inline menu and read the matching provider
   pack first (`../1password/SKILL.md`, `../bitwarden/SKILL.md`).
2. **BetterWright's built-in vault.** `credentials.list()` returns matching
   metadata only: id, username, label, category, saved URL, and match mode.
   Filter with `credentials.list({text, category})`. If one account clearly
   fits the task, call `credentials.fill({id, submit: true})`. BetterWright
   detects the visible form and resolves/types the secret internally. MCP/Pi's
   `browser_login` and the SDK's `fillCredential` use the same path.
3. **The page itself.** Focus the username field with `human.click` and
   re-snapshot; a session may already exist, an SSO button may be present, or
   the user's own password manager may surface.
4. **Ask the user** through the host's question mechanism, offering the
   accounts you found as masked options (e.g. "account ending in 999"). This is
   the last resort, not the first.

## Account choice and staged login

- Search before filling. One clear match may be used directly. If several
  plausible accounts remain and the task does not disambiguate them, ask with
  usernames/labels only; never mention a secret.
- On a username-first flow, enter the selected record's public username and
  advance. On the password stage call `credentials.fill({id, submit: true})`;
  password-only pages are detected.
- Detection uses autocomplete/type/label/form context. If it reports multiple
  plausible forms, scope explicit `usernameSelector`, `passwordSelector`,
  `confirmPasswordSelector`, or `submitSelector` from a fresh snapshot. Do not
  guess selectors before detection fails.

## Signup and password rotation

1. Call `credentials.generateAndFill({username, submit: true})`. Generation
   returns only an opaque pending id; the encrypted provisional entry is not an
   active saved login yet.
2. Verify the site's visible success state. A clicked button or request alone
   is not proof.
3. On success, call `credentials.commitGenerated({pendingId})`. On rejection or
   abandonment, call `credentials.discardGenerated({pendingId})`.

If generation fails but returns `pendingCredential`, do not generate again.
Inspect the visible site outcome, then commit or discard that exact recovery id.
After a complete host restart with no returned id, revisit the signup site and
call `credentials.listPending()`. Use its secret-free username, label, and
timestamps to identify the attempt; never guess or auto-pick among several.

For rotation, pass the existing credential `id` to `generateAndFill`. Commit
only after the site confirms the change; commit updates that item instead of
creating a duplicate. Rotation preserves its URL scope, so update `matchMode`
separately before rotating when needed. Choose an existing username/email when
the site allows it; never invent an address.

## Rules

- An empty `credentials.list()` means no enabled item matches this site under
  its URL policy. Fall through the ladder instead of searching unrelated
  credentials.
- Never read, print, encode, or transmit a password, card number, or one-time
  secret. Snapshots and results redact password inputs; keep it that way: no
  `inputValue()`, `input.value`, `evaluate`, console, or network probes on
  secret fields.
- A failed fill ("info isn't correct") means the stored secret may be stale:
  try the next source on the ladder, then ask the user — never brute-force
  variants.
- Save a task-supplied credential only when the user asks to remember it, and
  only after the site accepts it.
