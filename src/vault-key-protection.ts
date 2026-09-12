import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { isRecord, isString, type UntrustedValue, untrustedField } from "./untrusted-value.js";

const AAD = Buffer.from("betterwright-vault-master:v1");

export interface MasterKeyEnvelope {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
  epoch: string;
}

function decode(value: string, length: number): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== length || bytes.toString("base64") !== value) {
    throw new Error("Invalid master key envelope.");
  }
  return bytes;
}

export function parseMasterKey(contents: Buffer): MasterKeyEnvelope {
  const value: UntrustedValue = JSON.parse(contents.toString("utf8"));
  const salt = untrustedField(value, "salt");
  const iv = untrustedField(value, "iv");
  const tag = untrustedField(value, "tag");
  const data = untrustedField(value, "data");
  const epoch = untrustedField(value, "epoch");
  if (!isRecord(value) || untrustedField(value, "version") !== 1 ||
      !isString(salt) || !isString(iv) || !isString(tag) || !isString(data) || !isString(epoch)) {
    throw new Error("Invalid master key envelope.");
  }
  decode(salt, 16);
  decode(iv, 12);
  decode(tag, 16);
  decode(data, 32);
  decode(epoch, 16);
  return { version: 1, salt, iv, tag, data, epoch };
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (!isString(password) || !password || Buffer.byteLength(password) > 1024) {
    throw new Error("Invalid master password.");
  }
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, key) => error ? reject(new Error("Master password verification failed.")) : resolve(key));
  });
}

export async function wrapMasterKey(key: Buffer, password: string): Promise<MasterKeyEnvelope> {
  if (!isString(password) || password.length < 12) {
    throw new Error("Use at least 12 characters for the master password.");
  }
  const salt = randomBytes(16);
  const derived = await derive(password, salt);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", derived, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(key), cipher.final()]);
    return { version: 1, salt: salt.toString("base64"), iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64"),
      epoch: randomBytes(16).toString("base64") };
  } finally {
    derived.fill(0);
  }
}

export async function unwrapMasterKey(envelope: MasterKeyEnvelope, password: string): Promise<Buffer> {
  const derived = await derive(password, decode(envelope.salt, 16));
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", derived, decode(envelope.iv, 12));
    decipher.setAAD(AAD);
    decipher.setAuthTag(decode(envelope.tag, 16));
    plaintext = decipher.update(decode(envelope.data, 32));
    return Buffer.concat([plaintext, decipher.final()]);
  } catch {
    throw new Error("Master password verification failed.");
  } finally {
    plaintext?.fill(0);
    derived.fill(0);
  }
}
