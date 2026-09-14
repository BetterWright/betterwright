import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** Creation identity, not merely a PID which the OS may have recycled. */
export function localProcessInstance(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (!/^\d+$/.test(start)) return null;
      return `${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
    }
    const result = process.platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: "utf8", timeout: 3000, windowsHide: true })
      : spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 3000, env: { ...process.env, LC_ALL: "C" } });
    const value = result.stdout?.trim();
    return result.status === 0 && value ? value : null;
  } catch { return null; }
}
export function localProcessIsGone(pid: number, instance = ""): boolean {
  if (pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { return error?.code === "ESRCH"; }
  if (!instance) return false;
  const current = localProcessInstance(pid);
  return current !== null && current !== instance;
}
