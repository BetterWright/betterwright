import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const command = args[0];
if (command === "--version" || command === "-v") {
  console.log("0.0.0-e2e-fixture");
} else if (command === "echo") {
  console.log(JSON.stringify({
    args: args.slice(1),
    stdin: fs.readFileSync(0, "utf8"),
    cwd: process.cwd(),
    home: process.env.HOME,
    betterwrightHome: process.env.BETTERWRIGHT_HOME,
    extra: process.env.E2E_EXTRA,
  }));
} else if (command === "touch-home") {
  fs.mkdirSync(process.env.BETTERWRIGHT_HOME, { recursive: true });
} else if (command === "close") {
  fs.writeFileSync(path.join(process.cwd(), "closed.txt"), args.join(" "));
  process.exitCode = fs.existsSync(path.join(process.cwd(), "fail-cleanup")) ? 1 : 0;
} else if (command === "run") {
  const code = args[args.indexOf("-c") + 1];
  if (code === "malformed") console.log("not json");
  else console.log(JSON.stringify({ ok: code !== "failure" && code !== "wrong-exit", result: 42 }));
  process.exitCode = code === "failure" ? 1 : 0;
} else if (command === "hang") {
  if (args[1]) fs.writeFileSync(args[1], String(process.pid));
  setInterval(() => {}, 1_000);
} else if (command === "flood") {
  process.stdout.write("x".repeat(3 * 1024 * 1024));
} else if (command === "fail") {
  console.error("intentional target failure");
  process.exitCode = 7;
} else {
  console.error("unknown fixture command");
  process.exitCode = 1;
}
