/**
 * /rewind — turn-level workdir time travel (v1: file restore only).
 *
 * The ledger retains each turn's raw before/after file-change records
 * (harness-observed, capped at 32KB per side). Rewinding to "before turn N"
 * walks turns newest→N and, within each turn, records newest→oldest,
 * restoring every file to its recorded `before` content (or deleting files
 * the turn created). Conversation state is untouched — this is a workdir
 * undo, not a fork.
 *
 * Safety rules:
 *   - truncated records are skipped (writing a truncated `before` would
 *     corrupt the file);
 *   - records whose current on-disk content no longer matches the recorded
 *     `after` are skipped (the user — or a later, unrecorded actor — edited
 *     the file since; rewind never clobbers work it didn't see);
 *   - paths outside the workDir are skipped.
 */

import { readFile, writeFile, unlink } from "fs/promises";
import { resolve } from "path";
import type { FileChangeRecord } from "./reports/runReportData.js";
import type { LedgerTurn } from "./ledger.js";

export type RewindActionKind = "write" | "delete";

export interface RewindAction {
  path: string;
  kind: RewindActionKind;
  /** Content to write (undefined for delete). */
  content?: string;
  /** Recorded post-turn content — verified against disk before restoring. */
  expected: string;
  turnIndex: number;
}

export interface RewindSkip {
  path: string;
  reason: string;
  turnIndex: number;
}

export interface RewindPlan {
  /** Ordered: apply first→last (newest change first). */
  actions: RewindAction[];
  skips: RewindSkip[];
}

/**
 * Build the ordered restore plan for rewinding to the state BEFORE
 * `targetTurnIndex` (1-based ledger turn index). Pure — no filesystem.
 * Later duplicate records for the same path are superseded by the oldest
 * one's `before` (we walk newest→oldest and let the last write win, which
 * is the oldest record — exactly the pre-turn content).
 */
export function planRewind(turns: readonly LedgerTurn[], targetTurnIndex: number): RewindPlan {
  const actions: RewindAction[] = [];
  const skips: RewindSkip[] = [];
  const affected = turns
    .filter((t) => t.index >= targetTurnIndex)
    .sort((a, b) => b.index - a.index);
  for (const turn of affected) {
    const records = turn.digest?.fileChangeRecords ?? [];
    for (const rec of [...records].reverse()) {
      const action = recordToAction(rec, turn.index, skips);
      if (action) actions.push(action);
    }
  }
  return { actions, skips };
}

function recordToAction(
  rec: FileChangeRecord,
  turnIndex: number,
  skips: RewindSkip[],
): RewindAction | null {
  if (rec.afterTruncated || rec.beforeTruncated) {
    skips.push({ path: rec.path, reason: "recorded content was truncated (file too large)", turnIndex });
    return null;
  }
  if (rec.before === undefined) {
    return { path: rec.path, kind: "delete", expected: rec.after, turnIndex };
  }
  return { path: rec.path, kind: "write", content: rec.before, expected: rec.after, turnIndex };
}

export interface RewindResult {
  restored: string[];
  deleted: string[];
  skipped: RewindSkip[];
}

/**
 * Apply a rewind plan. Every action re-verifies the current on-disk content
 * against the recorded `after` before touching the file.
 */
export async function applyRewind(plan: RewindPlan, workDir: string): Promise<RewindResult> {
  const result: RewindResult = { restored: [], deleted: [], skipped: [...plan.skips] };
  const root = resolve(workDir);
  for (const action of plan.actions) {
    const abs = resolve(root, action.path);
    if (abs !== root && !abs.startsWith(root + "/")) {
      result.skipped.push({ path: action.path, reason: "outside the working directory", turnIndex: action.turnIndex });
      continue;
    }
    let current: string | null = null;
    try {
      current = await readFile(abs, "utf-8");
    } catch {
      current = null;
    }
    if (current !== action.expected) {
      result.skipped.push({
        path: action.path,
        reason: "file changed since the turn (not clobbering unrecorded edits)",
        turnIndex: action.turnIndex,
      });
      continue;
    }
    try {
      if (action.kind === "delete") {
        await unlink(abs);
        result.deleted.push(action.path);
      } else {
        await writeFile(abs, action.content ?? "", "utf-8");
        result.restored.push(action.path);
      }
    } catch (err) {
      result.skipped.push({
        path: action.path,
        reason: `restore failed: ${err instanceof Error ? err.message : String(err)}`,
        turnIndex: action.turnIndex,
      });
    }
  }
  return result;
}
