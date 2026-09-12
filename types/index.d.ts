// Hand-written declarations for the package root ("betterwright"). Every
// public symbol lives beside its implementation module; this file re-exports
// them so `import { ... } from "betterwright"` works. The behavior contract
// behind these symbols is documented in docs/, not repeated here.

export {
  claudeModel,
  codexModel,
  endpointModel,
  grokModel,
  listEndpointModels,
  modelSelectionChoices,
  MODEL_ENDPOINT_PRESETS,
  nativeModelCatalog,
  openaiModel,
  resolveModel,
  resolveModelSelection,
  runAgentTask,
} from "./agent.js";
export type {
  EndpointModelList,
  EndpointModelOptions,
  ModelCatalogEntry,
  ModelEndpointPreset,
  ModelEndpointSource,
  ModelSelectionChoice,
} from "./agent.js";
export {
  codexAccessToken,
  grokAccessToken,
  loadCodexAuth,
  loadGrokAuth,
  loginProvider,
} from "./auth.js";
// The local CAPTCHA solver's stage classification, tile geometry, and blob
// helpers. Exported for hosts and tests that need the same primitives the
// worker's captcha.* helpers are built on; most consumers only need the
// sandbox helpers documented in docs/captcha.md.
export {
  buildSolveResult,
  CAPTCHA_SOLVE_STATUSES,
  CAPTCHA_STAGES,
  classifyChallengeStage,
  clusterSimilarBoxes,
  collapseNestedBoxes,
  gridFromTiles,
  inferGridTiles,
  isCaptchaChromeLabel,
  isCaptchaSkipSubmitLabel,
  isCaptchaVerifySubmitLabel,
  isCaptchaVerifySubmitReady,
  isPlausibleImageGrid,
  maxAutoStages,
  nextSolveAction,
  parseTileIndexes,
  pickBestTileSet,
  pickDragFitPair,
  findGrowingRegion,
  extractDarkBlobs,
  solveTimeoutMs,
  unionClip,
} from "./captcha-solver.js";
export { detectBotChallenge } from "./challenges.js";
export { BetterWright, BrowserError } from "./client.js";

/** Local browsers readable as a cookie-sync source. */
export function listCookieSourceBrowsers(): Promise<
  import("./public.js").CookieSourceBrowser[]
>;

/** Profiles inside one source browser, for `syncCookies({ source })`. */
export function listCookieSourceProfiles(
  browser: string,
  options?: { timeoutMs?: number },
): Promise<import("./public.js").CookieSourceProfile[]>;

export { METADATA_ADDRESSES, METADATA_HOSTNAMES, NetworkPolicy } from "./policy.js";
export {
  piImageArtifacts,
  piImageContent,
  piPrimaryImageArtifact,
} from "./pi.js";
export { agentSystemPrompt } from "./prompt.js";
export {
  listSkills,
  matchSkillsForText,
  matchSkillsForUrl,
  parseSkillDocument,
  readSkill,
  skillHintsForPages,
} from "./skills.js";
export * from "./vault.js";
export type * from "./public.js";
