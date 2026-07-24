const encoder = new TextEncoder();
const ROOT_BYTES = 32;
const VERSION = 1;
const HOST_TO_VIEWER = 1;
const VIEWER_TO_HOST = 2;
const EPOCH_BYTES = 16;
const SEQUENCE_BYTES = 8;
const NONCE_BYTES = 12;
const HEADER_BYTES = 26;
const TAG_BYTES = 16;
const MAX_SEQUENCE = (1n << 64n) - 1n;
const DEFAULT_MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const HKDF_SALT_DOMAIN = "BetterWright relay HKDF salt v1";
const ENVELOPE_DOMAIN = "BetterWright relay envelope v1";

export const ENVELOPE_DIRECTION = Object.freeze({ HOST_TO_VIEWER, VIEWER_TO_HOST });
export const ENVELOPE_KIND = Object.freeze({ TEXT: 0, BINARY: 1, CHALLENGE: 2 });

const DIRECTION_PARAMETERS = Object.freeze({
  h2v: Object.freeze({
    byte: HOST_TO_VIEWER,
    keyInfo: "BetterWright relay host-to-viewer AES-GCM v1",
  }),
  v2h: Object.freeze({
    byte: VIEWER_TO_HOST,
    keyInfo: "BetterWright relay viewer-to-host AES-GCM v1",
  }),
});

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value, expectedLength) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url value");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("invalid base64url value");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (expectedLength !== undefined && bytes.length !== expectedLength) throw new Error("unexpected decoded length");
  if (bytesToBase64Url(bytes) !== value) throw new Error("non-canonical base64url value");
  return bytes;
}

async function importHmacKey(bytes) {
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function deriveViewerProof(rootKey, sessionId) {
  const root = base64UrlToBytes(rootKey, ROOT_BYTES);
  const key = await importHmacKey(root);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`BetterWright relay viewer proof v1\0${sessionId}`),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function concatenate(...parts) {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function isEnvelopeKind(value) {
  return value === ENVELOPE_KIND.TEXT || value === ENVELOPE_KIND.BINARY || value === ENVELOPE_KIND.CHALLENGE;
}

function parametersFor(direction) {
  const parameters = DIRECTION_PARAMETERS[direction];
  if (!parameters) throw new Error("invalid envelope direction");
  return parameters;
}

function sequenceView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function nonceFor(direction, sequence) {
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce[0] = VERSION;
  nonce[1] = parametersFor(direction).byte;
  sequenceView(nonce).setBigUint64(4, sequence, false);
  return nonce;
}

function additionalData(header, sessionId, direction) {
  return concatenate(
    header,
    encoder.encode(`${ENVELOPE_DOMAIN}\0${sessionId}\0${direction}`),
  );
}

async function deriveEnvelopeKey(root, epoch, sessionId, direction) {
  const saltInput = concatenate(
    encoder.encode(`${HKDF_SALT_DOMAIN}\0${sessionId}\0`),
    epoch,
  );
  const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", saltInput));
  const material = await crypto.subtle.importKey("raw", root, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encoder.encode(parametersFor(direction).keyInfo),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function envelopeHeader(direction, epoch, sequence) {
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = VERSION;
  header[1] = parametersFor(direction).byte;
  header.set(epoch, 2);
  sequenceView(header).setBigUint64(HEADER_BYTES - SEQUENCE_BYTES, sequence, false);
  return header;
}

export function createEnvelopeSender(rootKey, sessionId, direction, epochOverride) {
  const root = base64UrlToBytes(rootKey, ROOT_BYTES);
  parametersFor(direction);
  const senderEpoch = epochOverride
    ? new Uint8Array(epochOverride)
    : crypto.getRandomValues(new Uint8Array(EPOCH_BYTES));
  if (senderEpoch.length !== EPOCH_BYTES) throw new Error("invalid sender epoch length");
  const key = deriveEnvelopeKey(root, senderEpoch, sessionId, direction);
  let nextSequence = 0n;
  let pending = Promise.resolve();

  return Object.freeze({
    direction,
    get epoch() {
      return new Uint8Array(senderEpoch);
    },
    seal(kind, plaintext, maxEnvelopeBytes = DEFAULT_MAX_ENVELOPE_BYTES) {
      const body = new Uint8Array(plaintext);
      const operation = pending.then(async () => {
        if (!isEnvelopeKind(kind)) throw new Error("unsupported envelope kind");
        if (body.length + HEADER_BYTES + TAG_BYTES + 1 > maxEnvelopeBytes) {
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
        nextSequence = sequence + 1n;
        return concatenate(header, ciphertext);
      });
      pending = operation.then(() => undefined, () => undefined);
      return operation;
    },
  });
}

export function createEnvelopeReceiver(rootKey, sessionId, direction) {
  const root = base64UrlToBytes(rootKey, ROOT_BYTES);
  parametersFor(direction);
  let senderEpoch = null;
  let key = null;
  let acceptedSequence = null;
  let pending = Promise.resolve();

  return Object.freeze({
    direction,
    get epoch() {
      return senderEpoch ? new Uint8Array(senderEpoch) : null;
    },
    get lastSequence() {
      return acceptedSequence;
    },
    open(envelope, maxEnvelopeBytes = DEFAULT_MAX_ENVELOPE_BYTES) {
      const bytes = new Uint8Array(envelope);
      const operation = pending.then(async () => {
        if (bytes.length > maxEnvelopeBytes) throw new Error("envelope exceeds maximum size");
        if (bytes.length < HEADER_BYTES + TAG_BYTES + 1) throw new Error("truncated envelope");
        const header = bytes.subarray(0, HEADER_BYTES);
        if (header[0] !== VERSION || header[1] !== parametersFor(direction).byte) {
          throw new Error("envelope direction or version mismatch");
        }
        const candidateEpoch = new Uint8Array(header.subarray(2, 2 + EPOCH_BYTES));
        const sequence = sequenceView(header).getBigUint64(HEADER_BYTES - SEQUENCE_BYTES, false);
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
            bytes.subarray(HEADER_BYTES),
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
  });
}

export function randomBase64Url(byteLength) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}
