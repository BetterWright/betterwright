export interface EnsureChromeCdpOptions {
  home?: string;
  port?: number;
  executablePath?: string;
  timeoutMs?: number;
}

export interface ChromeCdpResult {
  endpoint: string;
  profileDir: string;
  started: boolean;
}

export function chromeExecutableCandidates(platform?: string): string[];
export function findChromeExecutable(explicit?: string): string | null;
export function ensureChromeCdp(options?: EnsureChromeCdpOptions): Promise<ChromeCdpResult>;
