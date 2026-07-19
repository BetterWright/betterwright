---
name: credential-manager
description: Read this before any login, signup, password change, or checkout so the right credential source is used in the right order without ever exposing a secret.
autoInject:
  keywords: ["login", "log in", "sign in", "sign-in", "sign up", "signup", "password", "credential", "checkout", "payment", "2fa", "mfa"]
---
# Credential manager

How to pick a credential source and fill a login, signup, or payment form
without ever seeing, typing, or printing a secret.

## Source order

Work down this ladder; stop at the first source that works.

1. **Password-manager extension in the profile.** If the host configured one
   (the operator prompt names it, e.g. 1Password), use its inline autofill
   menu — read the matching provider pack first (`../1password/SKILL.md`,
   `../bitwarden/SKILL.md`). The extension fills the secret; you never see it.
2. **BetterWright vault.** `credentials.list()` shows records saved for the
   current origin (metadata only — id, username, label, category; filter with
   `credentials.list({text, category})`). When one clearly matches, fill it
   directly from `run()`: `credentials.fill({id, usernameSelector,
   passwordSelector, submitSelector})` — the worker types the secret,
   origin-scoped, and never returns it. The host-side equivalents
   (`browser_login` on MCP/Pi, `bw.fillCredential` on the SDK) do the same
   from outside.
3. **The page itself.** Focus the username field with `human.click` and
   re-snapshot; a session may already exist, an SSO button may be present, or
   the user's own password manager may surface.
4. **Ask the user** through the host's question mechanism, offering the
   accounts you found as masked options (e.g. "account ending in 999"). This is
   the last resort, not the first.

## Signup and password change

- Signup: call `credentials.generateAndFill({username, usernameSelector,
  passwordSelector, confirmPasswordSelector, submitSelector})` from `run()`
  (host equivalents: `browser_login` with `generate: true`, or
  `bw.generateAndFillCredential(...)` from the SDK). The password is
  generated, filled, and saved to the vault without ever being returned.
- Password change: after the site confirms the change, update the stored
  record (`credentials.update({id, ...})`) rather than saving a duplicate.
- Choose the username/email from records the user already uses on other
  origins when the site allows it; never invent an address.

## Rules

- An empty `credentials.list()` does not prove nothing is saved — the vault
  may be absent or locked for this host. Fall through the ladder instead of
  concluding.
- Never read, print, encode, or transmit a password, card number, or one-time
  secret. Snapshots redact password inputs; keep it that way — no
  `input.value` probes on secret fields.
- A failed fill ("info isn't correct") means the stored secret may be stale:
  try the next source on the ladder, then ask the user — never brute-force
  variants.
