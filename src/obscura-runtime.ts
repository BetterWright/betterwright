import { spawn } from "node:child_process";
import net from "node:net";

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 3_000;

function listenOnce(server, event) {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      server.off(event, onEvent);
      server.off("error", onError);
    };
    server.once(event, onEvent);
    server.once("error", onError);
  });
}

export async function allocateLoopbackPort() {
  const server = net.createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await listenOnce(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not allocate a loopback port for Obscura.");
  return port;
}

export function obscuraServeArgs({
  port,
  storageDir,
  proxy,
}): string[] {
  const args = [
    "serve",
    "--port",
    String(port),
    "--storage-dir",
    String(storageDir),
    "--allow-private-network",
    "--stealth",
  ];
  if (proxy) args.push("--proxy", String(proxy));
  return args;
}

async function waitForEndpoint(child, port, timeoutMs, stderrTail) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Obscura exited before CDP became ready${stderrTail.length ? `: ${stderrTail.join(" ")}` : "."}`,
      );
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
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for Obscura CDP on 127.0.0.1:${port}` +
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
  const port = await allocateLoopbackPort();
  const args = obscuraServeArgs({ port, storageDir, proxy });
  const childEnv = { ...env };
  if (timezone) childEnv.OBSCURA_TIMEZONE = String(timezone);
  const child = spawnProcess(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  const stderrTail = [];
  collectTail(child.stdout, stderrTail);
  collectTail(child.stderr, stderrTail);
  try {
    await waitForEndpoint(child, port, timeoutMs, stderrTail);
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
