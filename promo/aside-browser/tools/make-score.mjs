// Generates assets/score.m4a: a soft ambient pad plus UI sound marks that land
// on the same beats as index.html. The synthesis is deterministic (seeded
// noise); FFmpeg encodes the intermediate WAV to AAC.
//   node tools/make-score.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 48000;
const DUR = 28;
const N = SR * DUR;
const L = new Float32Array(N);
const R = new Float32Array(N);

// Seeded PRNG (mulberry32) so every build is byte-identical.
let seed = 0x5eed1e;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const add = (i, l, r = l) => {
  if (i >= 0 && i < N) {
    L[i] += l;
    R[i] += r;
  }
};

// ---- same schedule as index.html -------------------------------------------
const PROMPT = "Set up Sentry, deploy my app, trigger a production error, then fix anything broken.";
const typeTimes = (text, start, cps) => {
  const out = [];
  let t = start;
  for (const ch of text) {
    out.push(t);
    t += 1 / cps + (ch === "," ? 0.09 : 0);
  }
  return out;
};
const CHAR_T = typeTimes(PROMPT, 0.7, 36);
const SUBMIT = 3.22;

// ---- pad --------------------------------------------------------------------
// Fmaj9 → Am7(11) → Dm9 → Bbmaj7(#11) → Fmaj9 bloom. Soft sines with slow detune.
const CHORDS = [
  { t: 0, notes: [41, 53, 57, 60, 64, 67] },
  { t: 7, notes: [45, 52, 57, 60, 62, 67] },
  { t: 13.4, notes: [38, 50, 57, 60, 64, 65] },
  { t: 20.5, notes: [46, 53, 57, 62, 64, 69] },
  { t: 25.9, notes: [41, 53, 57, 60, 64, 67, 72] },
];
const XF = 1.6;
for (let c = 0; c < CHORDS.length; c++) {
  const start = CHORDS[c].t;
  const end = c + 1 < CHORDS.length ? CHORDS[c + 1].t : DUR;
  const s0 = Math.max(0, Math.floor((start - XF / 2) * SR));
  const s1 = Math.min(N, Math.floor((end + XF / 2) * SR));
  CHORDS[c].notes.forEach((m, k) => {
    const f = hz(m);
    const amp = (m < 48 ? 0.05 : 0.028) * (c === 4 ? 1.25 : 1);
    const pan = 0.5 + (k % 2 ? 0.18 : -0.18);
    const ph = rand() * Math.PI * 2;
    for (let i = s0; i < s1; i++) {
      const t = i / SR;
      let env = Math.min(1, (t - (start - XF / 2)) / XF) * Math.min(1, (end + XF / 2 - t) / XF);
      if (c === 0) env *= Math.min(1, t / 2.2);
      if (c === 4) env *= Math.min(1, Math.max(0, (DUR - t) / 1.4));
      env = Math.max(0, env);
      const trem = 1 + 0.12 * Math.sin(2 * Math.PI * 0.23 * t + k);
      const v =
        Math.sin(2 * Math.PI * f * t + ph) +
        0.5 * Math.sin(2 * Math.PI * f * 1.0035 * t + ph * 1.3) +
        0.18 * Math.sin(2 * Math.PI * f * 2 * t + ph);
      const s = v * amp * env * trem;
      add(i, s * (1 - pan) * 1.2, s * pan * 1.2);
    }
  });
}

// ---- percussion-free pulse: soft filtered ticks on the agent's work ----------
const tick = (t, amp = 0.05, tone = 5200, len = 0.03) => {
  const s0 = Math.floor(t * SR);
  let lp = 0;
  for (let j = 0; j < len * SR; j++) {
    const env = Math.exp(-j / (len * SR * 0.22));
    const n = rand() * 2 - 1;
    lp += (n - lp) * (tone / SR) * 6;
    const v = (n - lp) * amp * env;
    add(s0 + j, v, v);
  }
};
const bell = (t, midi, amp = 0.12, decay = 1.4, pan = 0.5) => {
  const f = hz(midi);
  const s0 = Math.floor(t * SR);
  for (let j = 0; j < decay * 3 * SR; j++) {
    const tt = j / SR;
    const env = Math.min(1, tt / 0.004) * Math.exp(-tt / (decay * 0.45));
    const v = (Math.sin(2 * Math.PI * f * tt) + 0.35 * Math.sin(2 * Math.PI * f * 2.76 * tt) * Math.exp(-tt * 3) + 0.2 * Math.sin(2 * Math.PI * f * 5.4 * tt) * Math.exp(-tt * 6)) * amp * env;
    add(s0 + j, v * (1 - pan) * 1.4, v * pan * 1.4);
  }
};
const blip = (t, f0, f1, amp = 0.09, len = 0.12) => {
  const s0 = Math.floor(t * SR);
  let ph = 0;
  for (let j = 0; j < len * SR; j++) {
    const k = j / (len * SR);
    const f = f0 + (f1 - f0) * k;
    ph += (2 * Math.PI * f) / SR;
    const env = Math.min(1, j / (0.003 * SR)) * (1 - k) ** 2;
    const v = Math.sin(ph) * amp * env;
    add(s0 + j, v, v);
  }
};
const whoosh = (t, len = 0.7, amp = 0.12, up = true) => {
  const s0 = Math.floor(t * SR);
  let lp = 0;
  let bp = 0;
  for (let j = 0; j < len * SR; j++) {
    const k = j / (len * SR);
    const env = Math.sin(Math.PI * Math.min(1, k * 1.2)) ** 2;
    const cut = up ? 400 + 5000 * k * k : 5400 - 5000 * k;
    const n = rand() * 2 - 1;
    lp += (n - lp) * Math.min(1, (cut / SR) * 6);
    bp += (lp - bp) * 0.2;
    const v = (lp - bp) * amp * env * 2.2;
    add(s0 + j, v * (0.6 + 0.4 * k), v * (1.0 - 0.4 * k));
  }
};
const thud = (t, amp = 0.35) => {
  const s0 = Math.floor(t * SR);
  let ph = 0;
  for (let j = 0; j < 0.6 * SR; j++) {
    const tt = j / SR;
    const f = 42 + 70 * Math.exp(-tt * 18);
    ph += (2 * Math.PI * f) / SR;
    const env = Math.min(1, tt / 0.003) * Math.exp(-tt * 7);
    const v = Math.sin(ph) * amp * env;
    add(s0 + j, v, v);
  }
};

// typing: a soft key tick per character, slightly varied
CHAR_T.forEach((t, i) => tick(t, 0.035 + rand() * 0.02, 3800 + rand() * 1800, 0.025 + (PROMPT[i] === " " ? 0.012 : 0)));
// submit
blip(SUBMIT, 520, 1040, 0.08, 0.1);
whoosh(SUBMIT + 0.05, 0.8, 0.11);
// tabs spawning
[3.9, 4.5, 5.1].forEach((t, i) => blip(t, 740 + i * 120, 980 + i * 120, 0.07, 0.11));
// vault autofill sparkle
[7.3, 7.36, 7.42].forEach((t, i) => bell(t, 84 + [0, 4, 7][i], 0.035, 0.5, 0.35 + i * 0.15));
// clicks
[7.72, 8.25, 8.82, 13.82].forEach((t) => tick(t, 0.09, 2600, 0.04));
// project created / DSN
bell(8.97, 76, 0.05, 0.7);
// diff lines + env rows + logs: light ticks
[9.95, 10.05, 10.15, 10.25, 10.35, 10.45, 10.55, 10.65, 10.75, 11.25, 11.45].forEach((t) => tick(t, 0.03, 6200, 0.02));
[0, 1, 2, 3, 4, 5].forEach((i) => tick(12.15 + i * 0.19, 0.03, 6800, 0.02));
// deploy ready
bell(13.22, 79, 0.07, 0.9);
bell(13.3, 84, 0.05, 0.9);
// error: thud + low alert
thud(13.98, 0.38);
blip(14.0, 220, 150, 0.08, 0.3);
bell(14.62, 64, 0.06, 0.8, 0.4);
bell(14.8, 60, 0.06, 1.0, 0.6);
// fix lines + tests
[17.3, 17.5, 17.7, 17.9].forEach((t) => tick(t, 0.035, 6200, 0.02));
[0, 1, 2, 3, 4].forEach((i) => tick(18.45 + i * 0.2, 0.03, 7000, 0.02));
bell(19.2, 76, 0.05, 0.6);
bell(19.28, 81, 0.05, 0.8);
// redeploy ready
bell(20.12, 79, 0.05, 0.8);
// success chime
[72, 76, 79, 84].forEach((m, i) => bell(20.7 + i * 0.09, m, 0.07, 1.6, 0.3 + i * 0.13));
// bring your own AI
whoosh(23.3, 0.9, 0.07, false);
bell(24.6, 79, 0.05, 0.8, 0.4);
bell(24.95, 84, 0.05, 0.9, 0.6);
// end bloom
whoosh(25.7, 0.5, 0.06);
[65, 72, 76, 79, 84].forEach((m, i) => bell(26.0 + i * 0.06, m, 0.06, 2.4, 0.3 + i * 0.1));

// ---- master: gentle soft clip, fades, 16-bit PCM ----------------------------
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const gain = 0.7 / Math.max(peak, 1e-6);
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + N * 4, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const fade = Math.min(1, t / 0.05) * Math.min(1, (DUR - t) / 0.4);
  const l = Math.tanh(L[i] * gain * 1.1) * fade;
  const r = Math.tanh(R[i] * gain * 1.1) * fade;
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r)) * 32767), 46 + i * 4);
}
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "score.m4a");
mkdirSync(dirname(out), { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "aside-score-"));
const wav = join(tmp, "score.wav");
writeFileSync(wav, buf);
const enc = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", wav, "-c:a", "aac", "-b:a", "192k", "-map_metadata", "-1", out], { stdio: "inherit" });
rmSync(tmp, { recursive: true, force: true });
if (enc.status !== 0) throw new Error("ffmpeg failed to encode " + out);
console.log("wrote", out);
