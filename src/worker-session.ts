import type { Page } from "playwright-core";

export const MAX_PAGES_PER_SESSION = 32;

// Session state is constructed without launching a browser or installing process
// handlers. The worker owns the registry and serializes operations per session.
export function createSession(id: string) {
  return {
    id,
    pages: new Map<string, Page>(),
    currentId: null,
    state: Object.create(null),
    events: [],
    artifacts: [],
    warnings: [],
    pendingCredentialOrigins: new Map<string, string>(),
    reservedArtifactBytes: 0,
    lastActivity: Date.now(),
    nextDialog: null,
    awaitingAnswerSince: null,
    cursor: { x: 0, y: 0, initialized: false },
    captchaTargets: new Map(),
    // Coordinates are valid only for the grid they were captured from.
    captchaGrid: null,
    // Only a completed scan replaces this set, including clearing it.
    openChallengeProviders: new Set<string>(),
    webAgentsAnnouncedOrigins: new Set<string>(),
    uiDirectoryAnnouncedOrigins: new Set<string>(),
    // Executions on different sessions must never share recovery state.
    execution: { requestId: null, pendingRecovery: null, generationStarted: false },
  };
}

export type WorkerSession = ReturnType<typeof createSession>;
