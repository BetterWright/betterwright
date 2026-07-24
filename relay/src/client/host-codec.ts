import { ENVELOPE_KIND, HOST_PROTOCOL_PREFIX, RELAY_PROTOCOL } from "../constants";
import {
  constantTimeEqual,
  createEnvelopeReceiver,
  createEnvelopeSender,
  deriveViewerProof,
  generateRootKey,
  generateSessionId,
  randomBase64Url,
  type EnvelopeReceiver,
  type EnvelopeSender,
} from "../crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface PreparedRelaySession {
  sessionId: string;
  rootKey: string;
  viewerProof: string;
}

/** Prepare session material locally so the root never enters a relay HTTP request. */
export async function prepareRelaySession(): Promise<PreparedRelaySession> {
  const sessionId = generateSessionId();
  const rootKey = generateRootKey();
  const viewerProof = await deriveViewerProof(rootKey, sessionId);
  return { sessionId, rootKey, viewerProof };
}

export type DecodedViewerMessage =
  | { type: "ready" }
  | { type: "text"; data: string }
  | { type: "binary"; data: Uint8Array };

/**
 * Host-side codec seam for BetterWright's existing live-view server. Create a
 * fresh instance for every relay WebSocket connection. On viewer_connected,
 * send encodeChallenge() before accepting or emitting application payloads.
 */
export class HostRelayCodec {
  private challengeComplete = false;
  private pendingChallenge: string | null = null;

  private constructor(
    readonly sessionId: string,
    readonly subprotocols: readonly [string, string],
    private readonly hostSender: EnvelopeSender,
    private readonly viewerReceiver: EnvelopeReceiver,
  ) {}

  static async create(sessionId: string, rootKey: string, hostCapability: string): Promise<HostRelayCodec> {
    return new HostRelayCodec(
      sessionId,
      [RELAY_PROTOCOL, `${HOST_PROTOCOL_PREFIX}${hostCapability}`],
      createEnvelopeSender(rootKey, sessionId, "h2v"),
      createEnvelopeReceiver(rootKey, sessionId, "v2h"),
    );
  }

  get viewerVerified(): boolean {
    return this.challengeComplete;
  }

  async encodeChallenge(): Promise<Uint8Array> {
    if (this.pendingChallenge || this.challengeComplete) {
      throw new Error("host challenge already started");
    }
    const challenge = randomBase64Url(32);
    this.pendingChallenge = challenge;
    return this.hostSender.seal(
      ENVELOPE_KIND.CHALLENGE,
      encoder.encode(JSON.stringify({ t: "bw_e2e_challenge", challenge })),
    );
  }

  async encodeText(text: string): Promise<Uint8Array> {
    if (!this.challengeComplete) throw new Error("viewer is not verified");
    return this.hostSender.seal(ENVELOPE_KIND.TEXT, encoder.encode(text));
  }

  async encodeBinary(data: Uint8Array): Promise<Uint8Array> {
    if (!this.challengeComplete) throw new Error("viewer is not verified");
    return this.hostSender.seal(ENVELOPE_KIND.BINARY, data);
  }

  async receiveViewer(envelope: Uint8Array): Promise<DecodedViewerMessage> {
    const opened = await this.viewerReceiver.open(envelope);
    if (!this.challengeComplete) {
      if (!this.pendingChallenge) throw new Error("host challenge has not started");
      if (opened.kind !== ENVELOPE_KIND.CHALLENGE) {
        throw new Error("viewer input arrived before matching challenge echo");
      }
      let ready: unknown;
      try {
        ready = JSON.parse(decoder.decode(opened.plaintext));
      } catch {
        throw new Error("invalid viewer ready echo");
      }
      const value = ready as { t?: unknown; challenge?: unknown };
      if (
        value.t !== "bw_e2e_ready" ||
        typeof value.challenge !== "string" ||
        !constantTimeEqual(value.challenge, this.pendingChallenge)
      ) {
        throw new Error("invalid viewer ready echo");
      }
      this.pendingChallenge = null;
      this.challengeComplete = true;
      return { type: "ready" };
    }
    if (opened.kind === ENVELOPE_KIND.TEXT) {
      return { type: "text", data: decoder.decode(opened.plaintext) };
    }
    if (opened.kind === ENVELOPE_KIND.BINARY) {
      return { type: "binary", data: opened.plaintext };
    }
    throw new Error("unexpected viewer challenge envelope");
  }
}
