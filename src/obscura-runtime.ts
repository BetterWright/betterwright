import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 3_000;

export function obscuraServeArgs({
  port,
  storageDir,
  proxy,
}): string[] {
  const args = [
    "serve",
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    "--storage-dir",
    String(storageDir),
    "--allow-private-network",
    "--stealth",
  ];
  if (proxy) args.push("--proxy", String(proxy));
  return args;
}

export function parseProcListeningPorts(table, socketInodes) {
  const ports = [];
  for (const line of String(table || "").split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== "0A" || !socketInodes.has(fields[9])) continue;
    const [address, rawPort] = String(fields[1] || "").split(":");
    if (address !== "0100007F") continue;
    const port = Number.parseInt(rawPort, 16);
    if (port > 0 && port <= 65_535) ports.push(port);
  }
  return [...new Set(ports)];
}

export function parseLsofListeningPorts(output) {
  return [...new Set(
    String(output || "")
      .split(/\r?\n/)
      .map((line) => /^n127\.0\.0\.1:(\d+)$/.exec(line.trim())?.[1])
      .filter(Boolean)
      .map(Number)
      .filter((port) => port > 0 && port <= 65_535),
  )];
}

export function parseNetstatListeningPorts(output, pid) {
  const ports = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length < 5 ||
      fields[0].toUpperCase() !== "TCP" ||
      fields.at(-2)?.toUpperCase() !== "LISTENING" ||
      Number(fields.at(-1)) !== Number(pid)
    ) continue;
    const match = /^127\.0\.0\.1:(\d+)$/.exec(fields[1]);
    const port = Number(match?.[1] || 0);
    if (port > 0 && port <= 65_535) ports.push(port);
  }
  return [...new Set(ports)];
}

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || ""));
    });
  });
}

async function linuxListeningPorts(pid) {
  const descriptors = await fs.readdir(`/proc/${pid}/fd`);
  const links = await Promise.all(
    descriptors.map((descriptor) =>
      fs.readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => ""),
    ),
  );
  const inodes = new Set(
    links
      .map((link) => /^socket:\[(\d+)\]$/.exec(link)?.[1])
      .filter(Boolean),
  );
  if (!inodes.size) return [];
  const table = await fs.readFile(`/proc/${pid}/net/tcp`, "utf8");
  return parseProcListeningPorts(table, inodes);
}

export async function discoverObscuraPort(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  let ports = [];
  if (platform === "linux") {
    ports = await linuxListeningPorts(pid);
  } else if (platform === "darwin") {
    ports = parseLsofListeningPorts(
      await execFileText("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]),
    );
  } else if (platform === "win32") {
    ports = parseNetstatListeningPorts(
      await execFileText("netstat", ["-ano", "-p", "tcp"]),
      pid,
    );
  } else {
    throw new Error(`Cannot verify Obscura's listening socket on ${platform}.`);
  }
  if (ports.length > 1) {
    throw new Error("Obscura opened more than one loopback listener; refusing an ambiguous CDP endpoint.");
  }
  return ports[0] || 0;
}

async function waitForEndpoint(child, timeoutMs, stderrTail, findPort = discoverObscuraPort) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Obscura exited before CDP became ready${stderrTail.length ? `: ${stderrTail.join(" ")}` : "."}`,
      );
    }
    const port = await findPort(child.pid).catch(() => 0);
    if (!port) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    const ready = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const done = (value) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(150, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
    if (ready) return port;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "Timed out waiting for Obscura's owned loopback CDP endpoint" +
      (stderrTail.length ? `: ${stderrTail.join(" ")}` : "."),
  );
}

function collectTail(stream, tail) {
  if (!stream) return;
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += String(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      const clean = line.trim();
      if (!clean) continue;
      tail.push(clean);
      if (tail.length > 12) tail.shift();
    }
  });
}

export async function launchObscuraServer({
  binary,
  storageDir,
  proxy,
  timezone,
  env = process.env,
  timeoutMs = START_TIMEOUT_MS,
  spawnProcess = spawn,
}): Promise<any> {
  // Let the child ask the kernel for an ephemeral port atomically. The parent
  // discovers that port only from a listening socket owned by the spawned PID;
  // it never releases a guessed port that another local process can steal.
  const args = obscuraServeArgs({ port: 0, storageDir, proxy });
  const childEnv = { ...env };
  if (timezone) childEnv.OBSCURA_TIMEZONE = String(timezone);
  const child = spawnProcess(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  const stderrTail = [];
  collectTail(child.stdout, stderrTail);
  collectTail(child.stderr, stderrTail);
  let port;
  try {
    port = await waitForEndpoint(child, timeoutMs, stderrTail);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  let stopped = false;
  return {
    child,
    port,
    endpoint: `ws://127.0.0.1:${port}/devtools/browser`,
    args,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    },
  };
}
