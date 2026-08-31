import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { join } from "path";
import { ninerhDir } from "../paths.js";

export interface AgentState {
  currentTask: string;
  memory: Record<string, unknown>;
  toolCallHistory: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  stepIndex: number;
  environmentVars: Record<string, string>;
}

export interface Snapshot {
  id: string;
  timestamp: number;
  state: AgentState;
}

// Snapshots live under ~/.9rh (NINE_RH_HOME-overridable), never the user cwd.
const snapshotDir = (): string => ninerhDir("snapshots");

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {}
}

export async function captureSnapshot(agentState: AgentState): Promise<string> {
  const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const snapshot: Snapshot = { id, timestamp: Date.now(), state: agentState };

  try {
    await ensureDir(snapshotDir());
    await writeFile(
      join(snapshotDir(), `${id}.json`),
      JSON.stringify(snapshot),
      "utf-8"
    );
    return id;
  } catch (err) {
    console.warn("[snapshotManager] captureSnapshot failed:", err);
    return id;
  }
}

export async function restoreSnapshot(snapshotId: string): Promise<AgentState | null> {
  // Validate snapshotId to prevent path traversal. Only allow the
  // character set used by captureSnapshot's ID generator.
  if (!/^snap-[a-zA-Z0-9_-]{1,60}$/.test(snapshotId)) {
    console.warn("[snapshotManager] restoreSnapshot rejected invalid snapshotId:", snapshotId);
    return null;
  }
  try {
    const raw = await readFile(join(snapshotDir(), `${snapshotId}.json`), "utf-8");
    const snapshot: Snapshot = JSON.parse(raw);
    return snapshot.state;
  } catch (err) {
    console.warn("[snapshotManager] restoreSnapshot failed:", err);
    return null;
  }
}

export async function listSnapshots(): Promise<Snapshot[]> {
  try {
    await ensureDir(snapshotDir());
    const files = await readdir(snapshotDir());
    const snaps: Snapshot[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(snapshotDir(), file), "utf-8");
        snaps.push(JSON.parse(raw) as Snapshot);
      } catch {}
    }

    return snaps.sort((a, b) => b.timestamp - a.timestamp);
  } catch (err) {
    console.warn("[snapshotManager] listSnapshots failed:", err);
    return [];
  }
}
