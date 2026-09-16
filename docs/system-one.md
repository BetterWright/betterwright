# System One (Jev)

`followIntent()` is an **opt-in, host-side** helper. It asks TypeSafe's Jev
model which discovered control matches an intent, then optionally clicks it
through the existing UI batch path. It is not a general agent and does not
replace `run()`, `controls.batch()`, network policy, or the vault.

The API key and the page payload stay in trusted host code. They never enter
the model sandbox or a snippet string.

## When to use it

Use it when the next control is already on the page (or behind a dialog) but
labels collide: two Message buttons, several Download rows, cookie vs tax-form
buttons. Keep workflow logic, pagination bounds, and success checks in your
code. Pass `expect` so the loop can stop.

Do not use it to write Playwright, invent URLs, fill passwords, or authorize
purchases.

## Setup

Set `BETTERWRIGHT_TYPESAFE_API_KEY` or `TYPESAFE_API_KEY`. Calling
`followIntent` without a key returns `{ ok: false, reason: "unresolved" }`
instead of throwing. Page text in the request is sent to TypeSafe's API; do
not enable this for sessions that display secrets you are not willing to
share with that provider.

```js
import { withBrowser } from "betterwright/sdk";

const result = await withBrowser(async (bw) => {
  return bw.followIntent({
    url: "https://billing.example/invoices",
    intent: "Download the August 2025 Acme invoice for $1,240.00",
    query: ["Download", "Next"],
    expect: "Downloaded INV-1007",
    maxSteps: 8,
  });
});

if (!result.ok) throw new Error(result.error || result.reason);
```

`act: false` returns the chosen target without clicking.

## Stop rules

The loop abstains rather than guessing when:

- Jev chooses `none`, or confidence is below 0.45 (pagination may continue
  at 0.3 / probability 0.5 if the item is not on the page)
- an open dialog looks like a login wall, or the chosen control is Sign in /
  a password field (`allowAuthentication` is off by default)
- the chosen control is destructive and the intent did not name that action
- the same control would be clicked again on the same URL
- `expect` is already visible
- `maxSteps` is reached

Locator names that fail exact match are retried without a trailing arrow
(`Next →` → `Next`) and, when present, via snapshot refs.

## Discovery

`controls.directory()` now lists controls inside an open `<dialog>` (or
`role=dialog`) before the page behind it, so a cookie or login modal is
visible to both `followIntent` and ordinary batches.
