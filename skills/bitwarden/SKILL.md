---
name: bitwarden
description: Read this when the browser profile has the Bitwarden extension and a login, signup, or payment form should be filled with it.
autoInject:
  keywords: ["bitwarden"]
---
# Bitwarden

Bitwarden autofills through an inline menu iframe below the focused field. You
click the menu; Bitwarden types the secret. You never see it.

## Autofill flow

1. `human.click` the username field.
2. Wait 500 ms - 1 s, then `snapshot()`.
3. Look for the Bitwarden inline menu — an `iframe` subtree (frame-qualified
   refs) listing vault items.
   - **Menu present:** click the matching item via its `aria-ref`.
   - **Menu absent but the field shows a Bitwarden shield badge:** the vault
     is likely locked — follow the unlock flow below.
   - **Neither:** Bitwarden has nothing for this site; fall back to the
     credential-manager ladder (`../credential-manager/SKILL.md`).
4. Verify with `snapshot({diff: true})`, then submit.

## Unlock flow

1. `openPage('chrome-extension://nngceckbapebfimnlniiiahkandclblb/popup/index.html')`.
2. The master password must come from the user — in a headed session ask them
   to unlock in the visible window and confirm. Never guess it.
3. `closePage` the popup, `usePage` back to the sign-in tab, and **reload the
   page** before re-focusing the field.

## Cautions

- Inline autofill may be disabled in Bitwarden's settings; if focusing never
  shows a menu while unlocked, fall back to the credential-manager ladder
  rather than fighting the extension.
- The menu iframe is reachable only via its `aria-ref`s or on-screen box —
  page CSS selectors do not reach it.
