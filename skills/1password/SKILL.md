---
name: 1password
description: Read this when the browser profile has the 1Password extension and a login, signup, or payment form should be filled with it.
autoInject:
  keywords: ["1password", "1 password"]
---
# 1Password

The 1Password extension autofills forms through an inline menu rendered in its
own iframe. You click the menu; 1Password types the secret. You never see it.

## Autofill flow

1. `human.click` the username (or card-number) field.
2. Wait 500 ms - 1 s for the menu iframe to render, then `snapshot()`.
3. Check the bottom of the snapshot for the 1Password menu — an `iframe`
   subtree (frame-qualified refs like `f9e3`) listing saved items as buttons
   (site + username per row).
   - **Menu present:** click the matching item via its `aria-ref`. Pick by
     site, username, and task context; if genuinely ambiguous, ask the user
     with masked options.
   - **Only a status line** like `status: "1Password menu is available. Press
     down arrow to select."` with no menu iframe: 1Password is **locked** —
     follow the unlock flow below.
   - **Neither:** 1Password has nothing for this site; fall back to the
     credential-manager ladder (`../credential-manager/SKILL.md`).
4. Verify from `snapshot({diff: true})` that the fields are filled (password
   values show as redacted). Then submit.

## Unlock flow

1. `openPage('chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/popup/index.html')`.
2. The master password must come from the user or the host — never from you.
   In a headed session, ask the user to unlock in the visible window and tell
   you when done. Do not guess or reuse site passwords.
3. Close the extension tab (`closePage`), switch back to the sign-in tab
   (`usePage`), and **reload the page** — the inline menu does not appear on a
   page loaded while 1Password was locked.
4. Re-click the field and continue from step 1 of the autofill flow.

## Cautions

- The menu is an extension iframe: it survives in snapshots, but CSS
  selectors and keyboard shortcuts from the page do not reach it — act on its
  `aria-ref`s (or `human.click` its on-screen box).
- After a reload or navigation the menu closes; re-focus the field to reopen.
- Passkey dialogs ("Sign in with a passkey" / "Unlock 1Password") are also
  iframes; close them via their own buttons if you need password login
  instead.
- Use the extension popup only to unlock — autofill from the sign-in page's
  inline menu, not from the popup.
