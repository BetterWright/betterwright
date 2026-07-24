import { describe, expect, it } from "vitest";
import { HostRelayCodec, prepareRelaySession } from "../src/client/host-codec";
import { ENVELOPE_KIND } from "../src/constants";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  constantTimeEqual,
  createEnvelopeReceiver,
  createEnvelopeSender,
  deriveViewerProof,
  generateApiKey,
  generateCapability,
  generateRootKey,
  generateSessionId,
  hashApiKey,
  hashCapability,
  parseApiKey,
  secureTokenEqual,
} from "../src/crypto";
import * as browserCrypto from "../public/viewer-crypto.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const deterministicRoot = bytesToBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index));
const deterministicSession = `bws_${bytesToBase64Url(Uint8Array.from({ length: 18 }, (_, index) => index + 30))}`;
const hostEpoch = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const viewerEpoch = Uint8Array.from({ length: 16 }, (_, index) => index + 41);

describe("credential formats and HMAC storage", () => {
  it("generates and parses the exact BetterWright API-key format", () => {
    const generated = generateApiKey();
    expect(generated.value).toBe(`bw_live_${generated.id}_${generated.secret}`);
    expect(generated.id).toHaveLength(16);
    expect(generated.secret).toHaveLength(43);
    expect(parseApiKey(generated.value)).toEqual({ id: generated.id, secret: generated.secret });
  });

  it.each([
    "",
    "bw_live_short_secret",
    `bw_test_${"a".repeat(16)}_${"b".repeat(43)}`,
    `bw_live_${"!".repeat(16)}_${"b".repeat(43)}`,
    `bw_live_${"a".repeat(16)}_${"b".repeat(42)}`,
  ])("rejects malformed API key %j", (value) => {
    expect(parseApiKey(value)).toBeNull();
  });

  it("generates canonical session material locally", async () => {
    expect(base64UrlToBytes(generateRootKey(), 32)).toHaveLength(32);
    expect(base64UrlToBytes(generateCapability(), 32)).toHaveLength(32);
    expect(generateSessionId()).toMatch(/^bws_[A-Za-z0-9_-]{24}$/);
    const prepared = await prepareRelaySession();
    expect(prepared.sessionId).toMatch(/^bws_[A-Za-z0-9_-]{24}$/);
    expect(base64UrlToBytes(prepared.rootKey, 32)).toHaveLength(32);
    expect(prepared.viewerProof).toBe(await deriveViewerProof(prepared.rootKey, prepared.sessionId));
    expect(prepared.viewerProof).not.toBe(prepared.rootKey);
  });

  it("rejects non-canonical or wrongly sized base64url", () => {
    expect(() => base64UrlToBytes("abc=", 2)).toThrow();
    expect(() => base64UrlToBytes("a", 1)).toThrow();
    expect(() => base64UrlToBytes(bytesToBase64Url(new Uint8Array(31)), 32)).toThrow();
  });

  it("domain-separates API and role capability hashes", async () => {
    const secret = "x".repeat(48);
    const value = `bw_live_${"a".repeat(16)}_${"b".repeat(43)}`;
    const api = await hashApiKey(secret, value);
    const host = await hashCapability(secret, deterministicSession, "host", value);
    const viewer = await hashCapability(secret, deterministicSession, "viewer", value);
    expect(new Set([api, host, viewer]).size).toBe(3);
    expect(api).toHaveLength(43);
  });

  it("uses constant-time digest comparisons", async () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "different")).toBe(false);
    expect(await secureTokenEqual("operator-secret", "operator-secret")).toBe(true);
    expect(await secureTokenEqual("operator-secret", "wrong")).toBe(false);
  });
});

describe("epoch-bound directional encryption", () => {
  it("matches the browser module's viewer proof", async () => {
    expect(await deriveViewerProof(deterministicRoot, deterministicSession)).toBe(
      await browserCrypto.deriveViewerProof(deterministicRoot, deterministicSession),
    );
  });

  it("round-trips encrypted kinds with authenticated epoch and monotonic sequence", async () => {
    const sender = createEnvelopeSender(deterministicRoot, deterministicSession, "h2v", hostEpoch);
    const receiver = createEnvelopeReceiver(deterministicRoot, deterministicSession, "h2v");
    const first = await sender.seal(ENVELOPE_KIND.TEXT, encoder.encode('{"t":"hello"}'));
    const second = await sender.seal(ENVELOPE_KIND.BINARY, Uint8Array.of(0xff, 0xd8, 0xff, 0xd9));
    expect(first[0]).toBe(1);
    expect(first[1]).toBe(1);
    expect([...first.subarray(2, 18)]).toEqual([...hostEpoch]);
    expect(new DataView(first.buffer, first.byteOffset, first.byteLength).getBigUint64(18, false)).toBe(0n);
    expect(new DataView(second.buffer, second.byteOffset, second.byteLength).getBigUint64(18, false)).toBe(1n);
    const openedText = await receiver.open(first);
    expect(openedText.kind).toBe(ENVELOPE_KIND.TEXT);
    expect(decoder.decode(openedText.plaintext)).toBe('{"t":"hello"}');
    expect((await receiver.open(second)).kind).toBe(ENVELOPE_KIND.BINARY);
  });

  it("fails closed for tampering, wrong context, replay, reordering, and epoch changes", async () => {
    const sender = createEnvelopeSender(deterministicRoot, deterministicSession, "h2v", hostEpoch);
    const first = await sender.seal(ENVELOPE_KIND.TEXT, encoder.encode("first"));
    const second = await sender.seal(ENVELOPE_KIND.TEXT, encoder.encode("second"));
    const tampered = new Uint8Array(first);
    tampered[tampered.length - 1] ^= 1;
    await expect(createEnvelopeReceiver(deterministicRoot, deterministicSession, "h2v").open(tampered)).rejects.toThrow();
    await expect(createEnvelopeReceiver(deterministicRoot, deterministicSession, "v2h").open(first)).rejects.toThrow();
    await expect(createEnvelopeReceiver(generateRootKey(), deterministicSession, "h2v").open(first)).rejects.toThrow();
    await expect(createEnvelopeReceiver(deterministicRoot, deterministicSession + "x", "h2v").open(first)).rejects.toThrow();
    await expect(createEnvelopeReceiver(deterministicRoot, deterministicSession, "h2v").open(first, 10)).rejects.toThrow(/maximum/);

    const replayReceiver = createEnvelopeReceiver(deterministicRoot, deterministicSession, "h2v");
    await replayReceiver.open(first);
    await expect(replayReceiver.open(first)).rejects.toThrow(/replay/i);

    const reorderReceiver = createEnvelopeReceiver(deterministicRoot, deterministicSession, "h2v");
    await reorderReceiver.open(second);
    await expect(reorderReceiver.open(first)).rejects.toThrow(/replay/i);

    const otherEpoch = createEnvelopeSender(deterministicRoot, deterministicSession, "h2v", viewerEpoch);
    const changed = await otherEpoch.seal(ENVELOPE_KIND.TEXT, encoder.encode("changed"));
    await expect(replayReceiver.open(changed)).rejects.toThrow(/epoch changed/i);
  });

  it("interoperates byte-for-byte with the shipped browser crypto", async () => {
    const browserSender = browserCrypto.createEnvelopeSender(deterministicRoot, deterministicSession, "v2h", viewerEpoch);
    const workerReceiver = createEnvelopeReceiver(deterministicRoot, deterministicSession, "v2h");
    const browserEnvelope = await browserSender.seal(browserCrypto.ENVELOPE_KIND.TEXT, encoder.encode("viewer input"));
    expect(decoder.decode((await workerReceiver.open(browserEnvelope)).plaintext)).toBe("viewer input");

    const workerSender = createEnvelopeSender(deterministicRoot, deterministicSession, "h2v", hostEpoch);
    const browserReceiver = browserCrypto.createEnvelopeReceiver(deterministicRoot, deterministicSession, "h2v");
    const workerEnvelope = await workerSender.seal(ENVELOPE_KIND.BINARY, Uint8Array.of(9, 8, 7));
    const opened = await browserReceiver.open(workerEnvelope);
    expect(opened.kind).toBe(browserCrypto.ENVELOPE_KIND.BINARY);
    expect([...opened.plaintext]).toEqual([9, 8, 7]);
  });
});

describe("host-initiated root-key challenge", () => {
  it("blocks application data until the exact challenge echo", async () => {
    const host = await HostRelayCodec.create(deterministicSession, deterministicRoot, generateCapability());
    await expect(host.encodeText("too early")).rejects.toThrow(/not verified/);
    const viewerSender = createEnvelopeSender(deterministicRoot, deterministicSession, "v2h", viewerEpoch);
    const early = await viewerSender.seal(ENVELOPE_KIND.TEXT, encoder.encode('{"t":"input"}'));
    await expect(host.receiveViewer(early)).rejects.toThrow(/not started/);
  });

  it("completes the challenge then releases unchanged viewer JSON", async () => {
    const host = await HostRelayCodec.create(deterministicSession, deterministicRoot, generateCapability());
    const viewerReceiver = createEnvelopeReceiver(deterministicRoot, deterministicSession, "h2v");
    const viewerSender = createEnvelopeSender(deterministicRoot, deterministicSession, "v2h", viewerEpoch);
    const challengeEnvelope = await host.encodeChallenge();
    const challenge = await viewerReceiver.open(challengeEnvelope);
    expect(challenge.kind).toBe(ENVELOPE_KIND.CHALLENGE);
    const challengeValue = JSON.parse(decoder.decode(challenge.plaintext));
    expect(challengeValue).toMatchObject({ t: "bw_e2e_challenge" });
    expect(challengeValue.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const readyEnvelope = await viewerSender.seal(
      ENVELOPE_KIND.CHALLENGE,
      encoder.encode(JSON.stringify({ t: "bw_e2e_ready", challenge: challengeValue.challenge })),
    );
    expect(await host.receiveViewer(readyEnvelope)).toEqual({ type: "ready" });
    expect(host.viewerVerified).toBe(true);
    const inputJson = '{"t":"input","kind":"mouse","x":12}';
    const input = await viewerSender.seal(ENVELOPE_KIND.TEXT, encoder.encode(inputJson));
    expect(await host.receiveViewer(input)).toEqual({ type: "text", data: inputJson });
  });

  it("rejects a wrong challenge echo", async () => {
    const host = await HostRelayCodec.create(deterministicSession, deterministicRoot, generateCapability());
    await host.encodeChallenge();
    const viewerSender = createEnvelopeSender(deterministicRoot, deterministicSession, "v2h", viewerEpoch);
    const bad = await viewerSender.seal(
      ENVELOPE_KIND.CHALLENGE,
      encoder.encode(JSON.stringify({ t: "bw_e2e_ready", challenge: "x".repeat(43) })),
    );
    await expect(host.receiveViewer(bad)).rejects.toThrow(/invalid viewer ready/);
  });
});
