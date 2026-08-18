/**
 * App data directories. Everything the harness writes for itself
 * (snapshots, incident logs, run event logs, reports) lives under one
 * home — never under the user's cwd, which earlier versions polluted
 * with ./snapshots and ./logs on every run.
 *
 * NINE_RH_HOME overrides the base (used by tests to write to a tmpdir).
 * Resolved lazily on every call so the override works regardless of
 * import order.
 */

import { homedir } from "os";
import { join } from "path";

export function ninerhHome(): string {
  return process.env.NINE_RH_HOME ?? join(homedir(), ".9rh");
}

export function ninerhDir(...segments: string[]): string {
  return join(ninerhHome(), ...segments);
}
