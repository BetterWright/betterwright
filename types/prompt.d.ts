/**
 * Prompt-level behavior switches for the operator guidance. Each one appends a
 * clause to the "Guardrails for this session" section, which overrides the
 * default autonomy where they conflict. They shape model behavior only;
 * enforcement belongs to the network policy, the vault, or the host's own
 * gates. See docs/agent-prompt.md.
 */
export interface Guardrails {
  /**
   * Pause before submitting any payment or order: capture a `question`
   * screenshot of the order summary and get explicit user confirmation.
   */
  confirmBeforePurchase?: boolean;
  /**
   * Pause for explicit confirmation before any irreversible action: deleting
   * data, sending a message or email, submitting an application, confirming
   * a booking.
   */
  confirmBeforeIrreversible?: boolean;
  /**
   * Never complete a purchase or payment. The agent may still reach the
   * checkout page; it stops before submitting payment. Overrides
   * `confirmBeforePurchase` and `spendingLimit`.
   */
  forbidPurchases?: boolean;
  /** Never create accounts; a task that requires signing up stops and reports. */
  forbidAccountCreation?: boolean;
  /**
   * Per-purchase cap, inserted into the guidance verbatim (for example
   * `"$50"`). Purchases above it need explicit confirmation. Ignored when
   * `forbidPurchases` is set.
   */
  spendingLimit?: string;
  /** Additional instruction lines appended verbatim to the guardrail list. */
  extraRules?: string[];
  /**
   * Name of the password-manager extension installed and unlocked in the
   * browser (for example "1Password" or "Bitwarden"). Adds a section teaching
   * the model to drive that extension's inline menu and fall back to trusted
   * host-side fill.
   */
  passwordManager?: string;
}

/**
 * The BetterWright operator guidance: how to observe, act, verify, handle
 * credentials and challenges, and prove results. Paste it into a host's
 * system prompt (`betterwright skill` prints the CLI-shaped variant).
 */
export function agentSystemPrompt(guardrails?: Guardrails): string;
