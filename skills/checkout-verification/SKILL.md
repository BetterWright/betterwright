---
name: checkout-verification
description: Verify cart quantities and a fresh checkout outcome without inventing display formats or reusing an earlier receipt.
autoInject:
  keywords: ["shopping cart", "in the cart", "checkout", "place an order", "submit exactly once"]
---
# Grounded checkout verification

Inspection doesn't authorize changes. Guardrail prohibitions or missing required approval are valid stops; completion feedback grants no new permission.

Read the scoped cart after editing, excluding catalogue text:
- `Notebook, Notebook, Pen` means two notebooks and one pen, without an `x2` label.
- Read quantities with their labels/column headers; the number of rows is not the quantity.
- Match duplicate names by container, variant, and price; verify form values separately.

Submit only when observed items, quantities, and details match. Unknown format? Return scoped evidence before asserting or submitting.

Record the previous result, submit once, and wait for a fresh outcome. `Processing`, changed text alone, and an unchanged earlier receipt aren't acceptance. `Order 42 confirmed` is positive; rejection overrides an old success.

Extract IDs from this submission's fresh positive confirmation, not the whole page. Rejected/unverified outcomes have no new ID. Never resubmit for evidence. Scroll the fresh outcome into view, capture proof in the same call, and report the decision and quantities concisely.
