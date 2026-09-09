export function classifyCaptchaOutcome(
  status: string,
  stage: string | undefined,
  tokenLen: number,
) {
  if (status === "error") return "error";
  if (Number.isSafeInteger(tokenLen) && tokenLen > 0) return "token_received";
  if (status === "processing") {
    if (stage === "image_grid" || stage === "text") return "needs_vision";
    return "unresolved";
  }
  return "unverified";
}
