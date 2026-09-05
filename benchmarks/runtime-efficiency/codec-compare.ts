import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Usage: node benchmarks/runtime-efficiency/codec-compare.js FIXTURE_DIR [--full]
// FIXTURE_DIR contains original 300-frame, 1280x720 CDP JPEG streams named below.
const directory = process.argv[2];
if (!directory) throw new Error("Pass a directory containing text-scroll.mjpeg and moving-dashboard.mjpeg.");
const outputDirectory = path.join(directory, `comparison-${Date.now()}`);
fs.mkdirSync(outputDirectory, { recursive: true });
const scale = "scale=w='min(iw,1280)':h='min(ih,720)':force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2";
const common = [
  "-hide_banner", "-nostats", "-benchmark", "-loglevel", "info", "-filter_threads", "1",
  "-fpsprobesize", "0", "-probesize", "32", "-analyzeduration", "0",
  "-f", "image2pipe", "-framerate", "60", "-c:v", "mjpeg", "-threads", "1", "-i", "pipe:0", "-an",
];
const variants = [{
  name: "vp8-webm", extension: "webm",
  args: ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-threads", "2", "-b:v", "2M"],
  mux: ["-f", "webm"],
}];
const settings: Array<[string, number]> = process.argv.includes("--full")
  ? [["ultrafast", 23], ["ultrafast", 18], ["veryfast", 23], ["veryfast", 18], ["veryfast", 26], ["veryfast", 28]]
  : [["veryfast", 28]];
for (const [preset, crf] of settings) variants.push({
  name: `x264-${preset}-crf${crf}-zerolatency`, extension: "mp4",
  args: ["-c:v", "libx264", "-preset", preset, "-tune", "zerolatency", "-crf", String(crf), "-threads", "2", "-pix_fmt", "yuv420p", "-g", "60"],
  mux: ["-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4"],
});
const fixtures = ["text-scroll", "moving-dashboard"].map(name => {
  const file = path.join(directory, `${name}.mjpeg`);
  const data = fs.readFileSync(file);
  return { name, file, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
});
interface Result {
  fixture: string;
  variant: string;
  repeat: number;
  file: string;
  bytes: number;
  cpuSeconds: number;
  wallSeconds: number;
  maxRssKiB: number;
  frames: number;
  args: string[];
  ssimAll?: number;
  ssimY?: number;
}
const results: Result[] = [];
const version = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).stdout?.split("\n")[0];
function save() {
  fs.writeFileSync(path.join(outputDirectory, "results.json"), JSON.stringify({ version, fixtures, variants, results }, null, 2));
}
function command(binary: string, args: string[]) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr}`);
  return result;
}
for (let repeat = 1; repeat <= 3; repeat++) {
  const order = repeat === 2 ? [...variants].reverse() : variants;
  for (const fixture of fixtures) for (const variant of order) {
    const file = path.join(outputDirectory, `${fixture.name}-${variant.name}-r${repeat}.${variant.extension}`);
    const args = [...common, ...variant.args, "-r", "60", "-vf", scale, ...variant.mux, "pipe:1"];
    const source = fs.openSync(fixture.file, "r");
    const destination = fs.openSync(file, "wx", 0o600);
    let log: string;
    try {
      const run = spawnSync("ffmpeg", args, { stdio: [source, destination, "pipe"], encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
      if (run.error) throw run.error;
      log = run.stderr;
      if (run.status !== 0) throw new Error(`Encoding failed: ${log}`);
    } finally {
      fs.closeSync(source);
      fs.closeSync(destination);
    }
    fs.writeFileSync(`${file}.log`, log);
    const time = log.match(/bench: utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/);
    const rss = log.match(/bench: maxrss=(\d+)KiB/);
    if (!time || !rss) throw new Error("FFmpeg did not report CPU and peak RSS measurements.");
    const probe = command("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames,width,height,r_frame_rate", "-of", "json", file]);
    const stream = JSON.parse(probe.stdout).streams[0];
    if (Number(stream.nb_read_frames) !== 300 || stream.width !== 1280 || stream.height !== 720 || stream.r_frame_rate !== "60/1") {
      throw new Error(`Recording frame contract changed: ${probe.stdout}`);
    }
    const row: Result = {
      fixture: fixture.name, variant: variant.name, repeat, file, bytes: fs.statSync(file).size,
      cpuSeconds: Number(time[1]) + Number(time[2]), wallSeconds: Number(time[3]),
      maxRssKiB: Number(rss[1]), frames: Number(stream.nb_read_frames), args,
    };
    results.push(row);
    save();
    console.log(JSON.stringify(row));
  }
}
for (const fixture of fixtures) for (const variant of variants) {
  const row = results.find(result => result.fixture === fixture.name && result.variant === variant.name);
  const graph = `[0:v]${scale},format=yuv420p,settb=1/60,setpts=N[reference];[1:v]format=yuv420p,settb=1/60,setpts=N[encoded];[encoded][reference]ssim=shortest=1`;
  const run = command("ffmpeg", [
    "-hide_banner", "-nostats", "-loglevel", "info", "-filter_complex_threads", "1", "-threads", "1",
    "-f", "image2pipe", "-framerate", "60", "-c:v", "mjpeg", "-i", fixture.file,
    "-threads", "1", "-i", row.file, "-filter_complex", graph, "-threads", "1", "-f", "null", "-",
  ]);
  fs.writeFileSync(path.join(outputDirectory, `${fixture.name}-${variant.name}-ssim.log`), run.stderr);
  const score = run.stderr.match(/SSIM Y:([\d.]+).*All:([\d.]+)/);
  if (!score) throw new Error("FFmpeg did not report SSIM.");
  for (const result of results) if (result.fixture === fixture.name && result.variant === variant.name) {
    result.ssimY = Number(score[1]);
    result.ssimAll = Number(score[2]);
  }
  save();
}
console.log(`Saved serial encoder comparison to ${outputDirectory}`);
