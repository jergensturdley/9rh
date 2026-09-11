/**
 * Renderer-side view model contract. The store in `sessionsStore.ts` owns a
 * `SessionsState`; pure reducers in `transcript.ts`, `hud.ts`, and
 * `teamLanes.ts` build these shapes from `SessionEventEnvelope`s. Components
 * only read these types and call `sessionsActions`.
 *
 * The renderer never runtime-imports `9rh` (it is Node code); everything it
 * needs from the engine arrives as data over IPC or as type-only imports.
 */

import type {
  PendingRequest,
  SessionEventEnvelope,
  SessionSnapshot,
  TokenUsage,
  TurnDigestLite,
} from "@shared/ipc";

export type { PendingRequest, SessionEventEnvelope, SessionSnapshot, TokenUsage, TurnDigestLite };

export type BlockId = string;

export type TranscriptBlock =
  /** The task text that opened a turn. */
  | { kind: "user"; id: BlockId; ts: number; turn: number; text: string }
  /** Consecutive `thinking` deltas coalesced into one block. */
  | { kind: "thinking"; id: BlockId; ts: number; turn: number; text: string }
  /** A `tool_call`, later completed in place by the matching `tool_result`. */
  | {
      kind: "tool";
      id: BlockId;
      ts: number;
      turn: number;
      name: string;
      args: Record<string, unknown>;
      status: "running" | "success" | "error";
      output?: string;
      error?: string;
      endedTs?: number;
    }
  /** One-line markers for loop bookkeeping and repair telemetry. */
  | {
      kind: "marker";
      id: BlockId;
      ts: number;
      turn: number;
      variant:
        | "iteration"
        | "continuation"
        | "model_switch"
        | "compact"
        | "repair_start"
        | "repair_success"
        | "escalate"
        | "circuit_open"
        | "incident"
        | "spec_plan"
        | "branch_create"
        | "sandbox_health"
        | "step_inspect"
        | "partial_output";
      text: string;
      detail?: string;
    }
  /** Team pipeline role sections. */
  | {
      kind: "team";
      id: BlockId;
      ts: number;
      turn: number;
      role: string;
      status: "start" | "complete" | "skip" | "cache" | "conflict" | "escalation";
      text?: string;
      tokens?: number;
    }
  /** Receipts card closing a turn (from `done` or `error`). */
  | {
      kind: "receipts";
      id: BlockId;
      ts: number;
      turn: number;
      status: "completed" | "error" | "aborted";
      /** Model prose (done.text) or error message. */
      text: string;
      digest?: TurnDigestLite;
      reportPath?: string;
    };

export interface ToolHistoryItem {
  name: string;
  target: string;
  status: "running" | "success" | "error";
}

export interface TeamLaneView {
  role: string;
  status: "active" | "done" | "skipped" | "cache";
  startedAt?: number;
  endedAt?: number;
  tokens?: number;
}

/** Mirror of the TUI's DashboardState, derived purely from events. */
export interface HudState {
  activity: "idle" | "thinking" | "tool" | "done" | "error";
  iterCurrent: number;
  iterMax: number;
  currentTool: string | null;
  currentToolTarget: string | null;
  thinkingChars: number;
  /** Last ~120 chars of the current thinking stream, single line. */
  thinkingPreview: string;
  /** Most recent last; capped at 8. */
  toolHistory: ToolHistoryItem[];
  turnTokens: TokenUsage | null;
  lastCompletion: TokenUsage | null;
  continuation: { count: number; max: number } | null;
  teamLanes: TeamLaneView[];
}

export interface SessionView {
  snapshot: SessionSnapshot;
  blocks: TranscriptBlock[];
  hud: HudState;
  /** Highest envelope seq applied; used to resume from `sessions.history`. */
  lastSeq: number;
  /** Current turn index (ledger turnCount at the time the turn opened). */
  currentTurn: number;
}

export interface SessionsState {
  order: string[];
  byId: Record<string, SessionView>;
  activeId: string | null;
  /** Bootstrapping flag for the first `sessions.list` round trip. */
  loaded: boolean;
}

export const EMPTY_HUD: HudState = {
  activity: "idle",
  iterCurrent: 0,
  iterMax: 0,
  currentTool: null,
  currentToolTarget: null,
  thinkingChars: 0,
  thinkingPreview: "",
  toolHistory: [],
  turnTokens: null,
  lastCompletion: null,
  continuation: null,
  teamLanes: [],
};

/** Best-effort "target" of a tool call for the HUD and tool history. */
export function describeToolTarget(name: string, args: Record<string, unknown>): string {
  const pick = (k: string): string | null => (typeof args[k] === "string" ? (args[k] as string) : null);
  return (
    pick("path") ??
    pick("file_path") ??
    pick("command") ??
    pick("query") ??
    pick("pattern") ??
    pick("question") ??
    pick("url") ??
    pick("name") ??
    (name === "list_files" ? pick("directory") ?? "." : "")
  );
}
