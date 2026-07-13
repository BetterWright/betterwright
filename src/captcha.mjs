import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CAPTCHA_BASE_URL = "https://2captcha.com";
export const DEFAULT_CAPTCHA_KEY_FILE = "captcha-api-key";

export class CaptchaError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaptchaError";
  }
}

function keyFile(options) {
  return path.resolve(
    String(
      options.apiKeyFile ||
        process.env.CAPTCHA_SOLVER_API_KEY_FILE ||
        path.join(
          process.env.BETTERWRIGHT_HOME || path.join(os.homedir(), ".betterwright"),
          DEFAULT_CAPTCHA_KEY_FILE,
        ),
    ).replace(/^~/, os.homedir()),
  );
}

function resolveApiKey(options) {
  if (Object.hasOwn(options, "apiKey")) return String(options.apiKey || "").trim();
  const configured = String(process.env.CAPTCHA_SOLVER_API_KEY || "").trim();
  if (configured) return configured;
  const file = keyFile(options);
  try {
    const stat = fs.statSync(file);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new CaptchaError(`CAPTCHA solver key file must be private (chmod 600): ${file}`);
    }
    return fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function parseResponse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function imageBase64(image) {
  if (Buffer.isBuffer(image)) return image.toString("base64");
  const value = String(image || "");
  try {
    if (fs.statSync(value).isFile()) return fs.readFileSync(value).toString("base64");
  } catch {
    /* treat the value as base64 or a data URL */
  }
  return value.startsWith("data:") && value.includes(",")
    ? value.slice(value.indexOf(",") + 1)
    : value;
}

export class CaptchaSolver {
  constructor(options = {}) {
    this.apiKey = resolveApiKey(options);
    this.baseUrl = String(
      options.baseUrl || process.env.CAPTCHA_SOLVER_BASE_URL || DEFAULT_CAPTCHA_BASE_URL,
    ).replace(/\/$/, "");
    this.timeoutMs = Math.max(Number(options.timeoutMs) || 180_000, 1_000);
    this.httpTimeoutMs = Math.max(Number(options.httpTimeoutMs) || 30_000, 1_000);
    this.firstPollDelayMs = Math.max(Number(options.firstPollDelayMs ?? 15_000), 0);
    this.pollIntervalMs = Math.max(Number(options.pollIntervalMs ?? 5_000), 0);
    this.fetch = options.fetch || globalThis.fetch;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  _requireKey() {
    if (!this.apiKey) throw new CaptchaError("CAPTCHA_SOLVER_API_KEY is not set");
  }

  async _request(url, options) {
    try {
      const response = await this.fetch(url, {
        ...options,
        signal: AbortSignal.timeout(this.httpTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.text()).trim();
    } catch (error) {
      if (error instanceof CaptchaError) throw error;
      throw new CaptchaError(`transport: ${error?.message || error}`);
    }
  }

  async _post(endpoint, fields) {
    return this._request(`${this.baseUrl}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }

  async _get(endpoint, params) {
    const query = new URLSearchParams(params);
    return this._request(`${this.baseUrl}/${endpoint}?${query}`, { method: "GET" });
  }

  async _submit(fields) {
    const raw = await this._post("in.php", { key: this.apiKey, ...fields, json: "1" });
    const payload = parseResponse(raw);
    if (payload) {
      if (String(payload.status) === "1") return String(payload.request);
      throw new CaptchaError(String(payload.request || "ERROR_SUBMIT_FAILED"));
    }
    if (raw.startsWith("OK|")) return raw.slice(3);
    throw new CaptchaError(raw || "ERROR_EMPTY_RESPONSE");
  }

  async _poll(requestId) {
    const deadline = Date.now() + this.timeoutMs;
    if (this.firstPollDelayMs) await this.sleep(Math.min(this.firstPollDelayMs, this.timeoutMs));
    while (true) {
      const raw = await this._get("res.php", {
        key: this.apiKey,
        action: "get",
        id: requestId,
        json: "1",
      });
      const payload = parseResponse(raw);
      if (payload && String(payload.status) === "1") return String(payload.request);
      if (!payload && raw.startsWith("OK|")) return raw.slice(3);
      const status = String(payload?.request || raw || "");
      if (status && status !== "CAPCHA_NOT_READY") throw new CaptchaError(status);
      if (Date.now() >= deadline) throw new CaptchaError("ERROR_TIMEOUT");
      if (this.pollIntervalMs) await this.sleep(this.pollIntervalMs);
    }
  }

  async _solve(type, fields) {
    this._requireKey();
    const requestId = await this._submit(fields);
    const token = await this._poll(requestId);
    return { type, token, requestId };
  }

  async balance() {
    this._requireKey();
    const raw = await this._get("res.php", {
      key: this.apiKey,
      action: "getbalance",
      json: "1",
    });
    const payload = parseResponse(raw);
    if (!payload) {
      if (raw.startsWith("ERROR")) throw new CaptchaError(raw);
      return raw;
    }
    if (String(payload.status) !== "1") {
      throw new CaptchaError(String(payload.request || "ERROR_BALANCE_FAILED"));
    }
    return String(payload.request);
  }

  recaptchaV2(sitekey, url, { invisible = false } = {}) {
    const fields = { method: "userrecaptcha", googlekey: sitekey, pageurl: url };
    if (invisible) fields.invisible = "1";
    return this._solve("recaptcha_v2", fields);
  }

  recaptchaV3(sitekey, url, { action = "verify", minScore = 0.7 } = {}) {
    return this._solve("recaptcha_v3", {
      method: "userrecaptcha",
      googlekey: sitekey,
      pageurl: url,
      version: "v3",
      action,
      min_score: String(minScore),
    });
  }

  hcaptcha(sitekey, url) {
    return this._solve("hcaptcha", { method: "hcaptcha", sitekey, pageurl: url });
  }

  turnstile(sitekey, url, { action } = {}) {
    const fields = { method: "turnstile", sitekey, pageurl: url };
    if (action) fields.action = action;
    return this._solve("turnstile", fields);
  }

  image(image) {
    return this._solve("image", { method: "base64", body: imageBase64(image) });
  }
}
