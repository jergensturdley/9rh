/**
 * A Dock-launched Electron app inherits launchd's minimal PATH, so `npm`,
 * `9router`, and user prefixes like ~/.local/bin are invisible to the
 * updater and to the engine's ensureRouter. Ask the user's login shell for
 * its PATH once and merge it in front of the current one.
 */

import { spawn } from "child_process";
import { delimiter } from "path";

const MARKER = "__9RH_PATH__";

export function mergePath(login: string | null | undefined, current: string | undefined, sep = delimiter): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const src of [login ?? "", current ?? ""]) {
    for (const p of src.split(sep)) {
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out.join(sep);
}

export function loginShellPath(shell = process.env.SHELL || "/bin/sh", timeoutMs = 5_000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      // -i so rc files that only run for interactive shells (zshrc) contribute;
      // stdin is closed, so nothing can wait for input.
      child = spawn(shell, ["-ilc", `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, TERM: "dumb" },
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const parts = out.split(MARKER);
      resolve(parts.length >= 3 && parts[1] ? parts[1] : null);
    });
  });
}

export async function applyLoginPath(): Promise<void> {
  if (process.platform === "win32") return;
  const login = await loginShellPath();
  if (login) process.env.PATH = mergePath(login, process.env.PATH);
}
