import {
  API_KEY_ID_BYTES,
  API_KEY_PREFIX,
  API_KEY_SECRET_BYTES,
  CAPABILITY_BYTES,
  ENVELOPE_DIRECTION,
  ENVELOPE_EPOCH_BYTES,
  ENVELOPE_HEADER_BYTES,
  ENVELOPE_KIND,
  ENVELOPE_NONCE_BYTES,
  ENVELOPE_SEQUENCE_BYTES,
  ENVELOPE_TAG_BYTES,
  ENVELOPE_VERSION,
  ROOT_KEY_BYTES,
  SESSION_ID_BYTES,
} from "./constants";

const encoder = new TextEncoder();

export type RelayDirection = "h2v" | "v2h";
export type EnvelopeKind = (typeof ENVELOPE_KIND)[keyof typeof ENVELOPE_KIND];

export interface OpenedEnvelope {
  kind: EnvelopeKind;
  plaintext: Uint8Array;
  epoch: Uint8Array;
  sequence: bigint;
}

export interface EnvelopeSender {
  readonly direction: RelayDirection;
  readonly epoch: Uint8Array;
  seal(kind: EnvelopeKind, plaintext: Uint8Array, maxEnvelopeBytes?: number): Promise<Uint8Array>;
}

export interface EnvelopeReceiver {
  readonly direction: RelayDirection;
  readonly epoch: Uint8Array | null;
  readonly lastSequence: bigint | null;
  open(envelope: Uint8Array, maxEnvelopeBytes?: number): Promise<OpenedEnvelope>;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string, expectedLength?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url value");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("invalid base64url value");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new Error("unexpected decoded length");
  }
  if (bytesToBase64Url(bytes) !== value) throw new Error("non-canonical base64url value");
  return bytes;
}

export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export interface GeneratedApiKey {
  id: string;
  secret: string;
  value: string;
}

export function generateApiKey(): GeneratedApiKey {
  const id = randomBase64Url(API_KEY_ID_BYTES);
  const secret = randomBase64Url(API_KEY_SECRET_BYTES);
  return { id, secret, value: `${API_KEY_PREFIX}_${id}_${secret}` };
}

export function parseApiKey(value: string): { id: string; secret: string } | null {
  const match = /^bw_live_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return null;
  try {
    base64UrlToBytes(match[1], API_KEY_ID_BYTES);
    base64UrlToBytes(match[2], API_KEY_SECRET_BYTES);
  } catch {
    return null;
  }
  return { id: match[1], secret: match[2] };
}

export function generateSessionId(): string {
  return `bws_${randomBase64Url(SESSION_ID_BYTES)}`;
}

export function isSessionId(value: string): boolean {
  if (!/^bws_[A-Za-z0-9_-]{24}$/.test(value)) return false;
  try {
    base64UrlToBytes(value.slice(4), SESSION_ID_BYTES);
    return true;
  } catch {
    return false;
  }
}

export function generateCapability(): string {
  return randomBase64Url(CAPABILITY_BYTES);
}

export function generateRootKey(): string {
  return randomBase64Url(ROOT_KEY_BYTES);
}

async function importHmacKey(secret: string | Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    typeof secret === "string" ? encoder.encode(secret) : secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function hmacBase64Url(secret: string | Uint8Array, value: string): Promise<string> {
  const key = await importHmacKey(secret);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function hashApiKey(hmacSecret: string, apiKey: string): Promise<string> {
  return hmacBase64Url(hmacSecret, `betterwright-api-key-v1\0${apiKey}`);
}

export async function hashCapability(
  hmacSecret: string,
  sessionId: string,
  role: "host" | "viewer",
  capability: string,
): Promise<string> {
  return hmacBase64Url(
    hmacSecret,
    `betterwright-relay-capability-v1\0${sessionId}\0${role}\0${capability}`,
  );
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length, 1);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index % leftBytes.length] ?? 0) ^ (rightBytes[index % rightBytes.length] ?? 0);
  }
  return difference === 0;
}

export async function secureTokenEqual(candidate: string, expected: string): Promise<boolean> {
  const [candidateDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return constantTimeEqual(
    bytesToBase64Url(new Uint8Array(candidateDigest)),
    bytesToBase64Url(new Uint8Array(expectedDigest)),
  );
}

export async function deriveViewerProof(rootKey: string, sessionId: string): Promise<string> {
  const root = base64UrlToBytes(rootKey, ROOT_KEY_BYTES);
  return hmacBase64Url(root, `BetterWright relay viewer proof v1\0${sessionId}`);
}

const MAX_SEQUENCE = (1n << 64n) - 1n;
const DEFAULT_MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const HKDF_SALT_DOMAIN = "BetterWright relay HKDF salt v1";
const ENVELOPE_DOMAIN = "BetterWright relay envelope v1";

const DIRECTION_PARAMETERS: Record<
  RelayDirection,
  { byte: number; keyInfo: string }
> = {
  h2v: {
    byte: ENVELOPE_DIRECTION.HOST_TO_VIEWER,
    keyInfo: "BetterWright relay host-to-viewer AES-GCM v1",
  },
  v2h: {
    byte: ENVELOPE_DIRECTION.VIEWER_TO_HOST,
    keyInfo: "BetterWright relay viewer-to-host AES-GCM v1",
  },
};

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function isEnvelopeKind(value: number): value is EnvelopeKind {
  return value === ENVELOPE_KIND.TEXT || value === ENVELOPE_KIND.BINARY || value === ENVELOPE_KIND.CHALLENGE;
}

function sequenceView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function nonceFor(direction: RelayDirection, sequence: bigint): Uint8Array {
  const nonce = new Uint8Array(ENVELOPE_NONCE_BYTES);
  nonce[0] = ENVELOPE_VERSION;
  nonce[1] = DIRECTION_PARAMETERS[direction].byte;
  sequenceView(nonce).setBigUint64(4, sequence, false);
  return nonce;
}

function additionalData(header: Uint8Array, sessionId: string, direction: RelayDirection): Uint8Array {
  return concatenate(
    header,
    encoder.encode(`${ENVELOPE_DOMAIN}\0${sessionId}\0${direction}`),
  );
}

async function deriveEnvelopeKey(
  root: Uint8Array,
  epoch: Uint8Array,
  sessionId: string,
  direction: RelayDirection,
): Promise<CryptoKey> {
  const saltInput = concatenate(
    encoder.encode(`${HKDF_SALT_DOMAIN}\0${sessionId}\0`),
    epoch,
  );
  const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", saltInput));
  const keyMaterial = await crypto.subtle.importKey("raw", root, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encoder.encode(DIRECTION_PARAMETERS[direction].keyInfo),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function envelopeHeader(direction: RelayDirection, epoch: Uint8Array, sequence: bigint): Uint8Array {
  const header = new Uint8Array(ENVELOPE_HEADER_BYTES);
  header[0] = ENVELOPE_VERSION;
  header[1] = DIRECTION_PARAMETERS[direction].byte;
  header.set(epoch, 2);
  sequenceView(header).setBigUint64(18, sequence, false);
  return header;
}

export function createEnvelopeSender(
  rootKey: string,
  sessionId: string,
  direction: RelayDirection,
  epochOverride?: Uint8Array,
): EnvelopeSender {
  const root = base64UrlToBytes(rootKey, ROOT_KEY_BYTES);
  const senderEpoch = epochOverride
    ? new Uint8Array(epochOverride)
    : crypto.getRandomValues(new Uint8Array(ENVELOPE_EPOCH_BYTES));
  if (senderEpoch.length !== ENVELOPE_EPOCH_BYTES) throw new Error("invalid sender epoch length");
  const key = deriveEnvelopeKey(root, senderEpoch, sessionId, direction);
  let nextSequence = 0n;
  let pending: Promise<void> = Promise.resolve();

  return {
    direction,
    get epoch(): Uint8Array {
      return new Uint8Array(senderEpoch);
    },
    seal(kind, plaintext, maxEnvelopeBytes = DEFAULT_MAX_ENVELOPE_BYTES): Promise<Uint8Array> {
      const body = new Uint8Array(plaintext);
      const operation = pending.then(async () => {
        if (!isEnvelopeKind(kind)) throw new Error("unsupported envelope kind");
        if (body.length + ENVELOPE_HEADER_BYTES + ENVELOPE_TAG_BYTES + 1 > maxEnvelopeBytes) {
          throw new Error("envelope exceeds maximum size");
        }
        if (nextSequence > MAX_SEQUENCE) throw new Error("envelope sequence exhausted");
        const sequence = nextSequence;
        const header = envelopeHeader(direction, senderEpoch, sequence);
        const protectedPlaintext = new Uint8Array(body.length + 1);
        protectedPlaintext[0] = kind;
        protectedPlaintext.set(body, 1);
        const ciphertext = new Uint8Array(
          await crypto.subtle.encrypt(
            {
              name: "AES-GCM",
              iv: nonceFor(direction, sequence),
              additionalData: additionalData(header, sessionId, direction),
              tagLength: 128,
            },
            await key,
            protectedPlaintext,
          ),
        );
        const envelope = concatenate(header, ciphertext);
        nextSequence = sequence + 1n;
        return envelope;
      });
      pending = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}

export function createEnvelopeReceiver(
  rootKey: string,
  sessionId: string,
  direction: RelayDirection,
): EnvelopeReceiver {
  const root = base64UrlToBytes(rootKey, ROOT_KEY_BYTES);
  let senderEpoch: Uint8Array | null = null;
  let key: CryptoKey | null = null;
  let acceptedSequence: bigint | null = null;
  let pending: Promise<void> = Promise.resolve();

  return {
    direction,
    get epoch(): Uint8Array | null {
      return senderEpoch ? new Uint8Array(senderEpoch) : null;
    },
    get lastSequence(): bigint | null {
      return acceptedSequence;
    },
    open(envelope, maxEnvelopeBytes = DEFAULT_MAX_ENVELOPE_BYTES): Promise<OpenedEnvelope> {
      const bytes = new Uint8Array(envelope);
      const operation = pending.then(async () => {
        if (bytes.length > maxEnvelopeBytes) throw new Error("envelope exceeds maximum size");
        if (bytes.length < ENVELOPE_HEADER_BYTES + ENVELOPE_TAG_BYTES + 1) {
          throw new Error("truncated envelope");
        }
        const header = bytes.subarray(0, ENVELOPE_HEADER_BYTES);
        if (
          header[0] !== ENVELOPE_VERSION ||
          header[1] !== DIRECTION_PARAMETERS[direction].byte
        ) {
          throw new Error("envelope direction or version mismatch");
        }
        const candidateEpoch = new Uint8Array(header.subarray(2, 2 + ENVELOPE_EPOCH_BYTES));
        const sequence = sequenceView(header).getBigUint64(18, false);
        if (senderEpoch && !equalBytes(candidateEpoch, senderEpoch)) {
          throw new Error("sender epoch changed without reconnect");
        }
        if (acceptedSequence !== null && sequence <= acceptedSequence) {
          throw new Error("non-monotonic envelope replay rejected");
        }
        const candidateKey = key ?? await deriveEnvelopeKey(root, candidateEpoch, sessionId, direction);
        const protectedPlaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: nonceFor(direction, sequence),
              additionalData: additionalData(header, sessionId, direction),
              tagLength: 128,
            },
            candidateKey,
            bytes.subarray(ENVELOPE_HEADER_BYTES),
          ),
        );
        const kind = protectedPlaintext[0];
        if (!isEnvelopeKind(kind)) throw new Error("unsupported envelope kind");
        if (!senderEpoch) {
          senderEpoch = candidateEpoch;
          key = candidateKey;
        }
        acceptedSequence = sequence;
        return {
          kind,
          plaintext: protectedPlaintext.subarray(1),
          epoch: new Uint8Array(candidateEpoch),
          sequence,
        };
      });
      pending = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}
