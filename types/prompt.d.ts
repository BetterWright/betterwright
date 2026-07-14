export interface Guardrails {
  confirmBeforePurchase?: boolean;
  confirmBeforeIrreversible?: boolean;
  forbidPurchases?: boolean;
  forbidAccountCreation?: boolean;
  spendingLimit?: string;
  extraRules?: string[];
  passwordManager?: string;
}

export function agentSystemPrompt(guardrails?: Guardrails): string;
