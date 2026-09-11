/**
 * Transcript reducer: folds `SessionEventEnvelope`s into a `SessionView`.
 * Pure and immutable: arrays and blocks are copied only where they change.
 * Block ids are `sessionId:seq`; every event yields at most one block so no
 * suffix is needed today.
 */

import type { SessionEventEnvelope, SessionSnapshot, TurnDigest, TurnDigestLite } from "@shared/ipc";
import { EMPTY_HUD, type SessionView, type TranscriptBlock } from "./types";
import { applyHudEvent } from "./hud";

type MarkerVariant = Extract<TranscriptBlock, { kind: "marker" }>["variant"];
type ToolBlock = Extract<TranscriptBlock, { kind: "tool" }>;
type TeamBlock = Extract<TranscriptBlock, { kind: "team" }>;

export function emptySessionView(snapshot: SessionSnapshot): SessionView {
  return { snapshot, blocks: [], hud: EMPTY_HUD, lastSeq: 0, currentTurn: snapshot.ledger.turnCount };
}

/** Strip raw before/after records; keep paths so the UI can request a diff. */
function liteDigest(digest: TurnDigest | undefined): TurnDigestLite | undefined {
  if (!digest) return undefined;
  const { fileChangeRecords, ...rest } = digest as TurnDigest & { diffablePaths?: string[] };
  const diffablePaths = rest.diffablePaths ?? fileChangeRecords?.map((r) => r.path) ?? [];
  return { ...rest, diffablePaths };
}

export function applyEnvelope(view: SessionView, env: SessionEventEnvelope): SessionView {
  const e = env.event;
  const id = `${env.sessionId}:${env.seq}`;
  let blocks = view.blocks;
  let currentTurn = view.currentTurn;
  const base = () => ({ id, ts: env.ts, turn: currentTurn });
  const push = (b: TranscriptBlock): void => {
    blocks = [...blocks, b];
  };
  const marker = (variant: MarkerVariant, text: string, detail?: string): void =>
    push(detail === undefined ? { kind: "marker", ...base(), variant, text } : { kind: "marker", ...base(), variant, text, detail });
  const team = (role: string, status: TeamBlock["status"], text?: string, tokens?: number): void =>
    push({ kind: "team", ...base(), role, status, ...(text !== undefined ? { text } : {}), ...(tokens !== undefined ? { tokens } : {}) });

  switch (e.type) {
    case "turn_start":
      currentTurn = e.turnIndex;
      push({ kind: "user", ...base(), text: e.task });
      break;

    case "thinking": {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "thinking" && last.turn === currentTurn) {
        blocks = [...blocks.slice(0, -1), { ...last, text: last.text + e.text }];
      } else {
        push({ kind: "thinking", ...base(), text: e.text });
      }
      break;
    }

    case "tool_call":
      push({ kind: "tool", ...base(), name: e.name, args: e.args, status: "running" });
      break;

    case "tool_result": {
      const status = e.error ? "error" : "success";
      const idx = blocks.findIndex((b) => b.kind === "tool" && b.status === "running" && b.name === e.name);
      const done = { status, output: e.output, ...(e.error ? { error: e.error } : {}), endedTs: env.ts } as const;
      if (idx >= 0) {
        blocks = blocks.slice();
        blocks[idx] = { ...(blocks[idx] as ToolBlock), ...done };
      } else {
        push({ kind: "tool", ...base(), name: e.name, args: {}, ...done });
      }
      break;
    }

    case "iteration":
      marker("iteration", `iteration ${e.current}/${e.max}`);
      break;
    case "continuation":
      marker("continuation", `continuation ${e.count}/${e.max}`);
      break;
    case "model_switch":
      marker("model_switch", `model switch ${e.from} -> ${e.to} (${e.reason})`);
      break;
    case "compact":
      marker("compact", "compacted context", e.summary);
      break;
    case "repair_start":
      marker("repair_start", `repair attempt ${e.attempt}: ${e.message}`);
      break;
    case "repair_success":
      marker("repair_success", `repair succeeded: ${e.message}`);
      break;
    case "escalate":
      marker("escalate", `escalated: ${e.message}`);
      break;
    case "circuit_open":
      marker("circuit_open", "circuit open: repair budget exhausted");
      break;
    case "incident":
      marker(
        "incident",
        `incident at ${e.stepId}: ${e.cause}`,
        [e.repairAttempt !== undefined ? `repair attempt ${e.repairAttempt}` : "", e.circuitOpen ? "circuit open" : ""]
          .filter(Boolean)
          .join(", ") || undefined,
      );
      break;
    case "spec_plan":
      marker("spec_plan", "generated test plan", e.summary);
      break;
    case "branch_create":
      marker("branch_create", `branch ${e.branchId} from ${e.stepId}: ${e.reason}`);
      break;
    case "sandbox_health":
      marker("sandbox_health", `sandbox: ${e.sandboxed}/${e.total} sandboxed`, `direct ${e.direct}, timed out ${e.timedOut}`);
      break;
    case "step_inspect":
      marker(
        "step_inspect",
        `step ${e.stepId}`,
        [e.params, e.output, e.diff, e.trace, e.policy].filter((s): s is string => Boolean(s)).join("\n") || undefined,
      );
      break;
    case "partial_output":
      marker("partial_output", `partial output from ${e.stepId}`, e.text);
      break;

    case "team": {
      const te = e.event;
      switch (te.type) {
        case "role_start":
          team(te.role, "start");
          break;
        case "role_complete":
          team(te.role, "complete", te.result, te.usage?.total);
          break;
        case "role_skip":
          team(te.role, "skip", te.reason);
          break;
        case "cache_hit":
          team(te.role, "cache");
          break;
        case "conflict":
          team(te.parties.join(" / "), "conflict", `conflict resolved: ${te.resolution}`);
          break;
        case "escalation":
          team("team", "escalation", te.reason);
          break;
        case "task_failed":
          // ponytail: the marker variant union has no team variant; "incident" is the
          // closest fit. task_complete gets no block (the done receipts follow it).
          marker("incident", `team failed: ${te.error}`);
          break;
        case "task_complete":
          break;
      }
      break;
    }

    case "done":
      push({
        kind: "receipts",
        ...base(),
        status: "completed",
        text: e.text,
        ...(e.digest ? { digest: liteDigest(e.digest) } : {}),
        ...(e.reportPath ? { reportPath: e.reportPath } : {}),
      });
      break;

    case "error":
      push({
        kind: "receipts",
        ...base(),
        status: "error",
        text: e.message,
        ...(e.digest ? { digest: liteDigest(e.digest) } : {}),
        ...(e.reportPath ? { reportPath: e.reportPath } : {}),
      });
      break;

    case "turn_end":
      if (!blocks.some((b) => b.kind === "receipts" && b.turn === currentTurn)) {
        push({
          kind: "receipts",
          ...base(),
          status: e.status === "aborted" ? "aborted" : "error",
          text: "turn ended without a result",
        });
      }
      break;

    case "usage":
    case "replay_event":
      break;
  }

  return { ...view, blocks, currentTurn, lastSeq: env.seq, hud: applyHudEvent(view.hud, env) };
}
