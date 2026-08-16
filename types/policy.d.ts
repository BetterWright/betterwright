import type { UntrustedValue } from "./untrusted-value.js";

export interface NetworkDecision {
  allowed: boolean;
  reason?: string;
}

export interface NetworkRequestDetails {
  [key: string]: UntrustedValue;
}

export type NetworkPolicyCustom = (
  url: string,
  details: NetworkRequestDetails,
) => NetworkDecision | null | undefined;

export interface NetworkPolicyOptions {
  allowPrivateNetwork?: boolean;
  allowLoopback?: boolean;
  allowHosts?: string[];
  blockHosts?: string[];
  custom?: NetworkPolicyCustom;
}

export const METADATA_HOSTNAMES: Set<string>;
export const METADATA_ADDRESSES: Set<string>;

export class NetworkPolicy {
  constructor(options?: NetworkPolicyOptions);

  allowPrivateNetwork: boolean;
  allowLoopback: boolean;
  allowHosts: string[];
  blockHosts: string[];
  custom: NetworkPolicyCustom | null;

  hostMatches(entry: UntrustedValue, hostname: string, port: number | null): boolean;
  isMetadata(hostname: string): boolean;
  check(url: UntrustedValue, details?: NetworkRequestDetails): NetworkDecision;
  checkHost(hostname: string, port: number | null): NetworkDecision;
}
