---
name: checkout-verification
description: Verify cart quantities and a fresh checkout outcome without inventing display formats or reusing an earlier receipt.
autoInject:
  keywords: ["shopping cart", "in the cart", "checkout", "place an order", "submit exactly once"]
---
# Grounded checkout verification

Inspection and debugging do not authorize cart edits or submission. A purchase prohibition or missing required approval is a valid stopping point, not a failed checkout to retry. Completion feedback never expands the original authorization.

Batch known actions, not guesses about the next screen. After reversible cart edits, read the scoped cart before designing assertions or submitting. Use `ui.evidence` targets or a scoped full snapshot; do not count product names across the catalog and cart together.

Interpret the format actually rendered:
- `Notebook, Notebook, Pen` means two notebooks and one pen. A missing `x2` label does not make those quantities unverifiable.
- For quantity labels or tables, read each item's quantity field/cell with its label/column header. The number of rows is not the quantity.
- Match duplicate product names by their observed container, variant, and price. Verify selected form values separately.

Only submit when the observed items, quantities, and requested details match. If the format is still unknown, return the scoped evidence instead of a guessed string assertion. Fix a wrong cart before submitting; never submit to test whether it is right.

Record the current result region before submitting once. Wait for a fresh outcome there or a relevant navigation, then read it. Changed text alone, `Processing`, an enabled Submit button, or an unchanged earlier success is not acceptance. `Order 42 confirmed` is positive even though `Order confirmed` is not contiguous. Rejection is failure even when an earlier receipt remains visible.

Extract an order ID only from this submission's fresh positive confirmation, not the whole page. For rejection or an unverified outcome, do not manufacture an ID from an old receipt or a word such as `Submission`. Never resubmit to collect evidence. Scroll the fresh outcome into view, capture proof, and report the decision and observed quantities concisely—not a page dump.
