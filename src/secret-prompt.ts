import { StringDecoder } from "node:string_decoder";

/** Read only from a human terminal, without echo, argv, environment, or stdout. */
export function promptSecret(label: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stderr.isTTY) {
    throw new Error("A terminal is required for master-password entry. Never put it in arguments or tool input.");
  }
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let value = "";
    const wasRaw = input.isRaw;
    const wasPaused = input.isPaused();
    const finish = (error?: Error) => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
      value = "";
    };
    const onEnd = () => finish(new Error("Password entry cancelled."));
    const onError = () => finish(new Error("Password entry failed."));
    const onData = (chunk: Buffer) => {
      for (const char of decoder.write(chunk)) {
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u0003" || char === "\u0004") { onEnd(); return; }
        if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " ") value += char;
        if (Buffer.byteLength(value) > 1024) { finish(new Error("Master password is too long.")); return; }
      }
    };
    input.setRawMode(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume();
    process.stderr.write(label);
  });
}
