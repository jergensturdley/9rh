/**
 * HUD reducer: a pure mirror of the TUI's `DashboardState` bookkeeping in
 * `createTuiRenderer` (src/tui.ts). One envelope in, a new `HudState` out;
 * events that do not touch the HUD return the same object.
 */

import type { SessionEventEnvelope } from "@shared/ipc";
import { EMPTY_HUD, describeToolTarget, type HudState, type ToolHistoryItem } from "./types";
import { applyTeamLaneEvent } from "./teamLanes";

const PREVIEW_CHARS = 120;
const HISTORY_CAP = 8;

const THINKING_RESET = { thinkingChars: 0, thinkingPreview: "" } as const;

export function applyHudEvent(hud: HudState, env: SessionEventEnvelope): HudState {
  const e = env.event;
  switch (e.type) {
    case "turn_start":
      return { ...EMPTY_HUD, activity: "thinking" };

    case "thinking":
      return {
        ...hud,
        activity: "thinking",
        thinkingChars: hud.thinkingChars + e.text.length,
        thinkingPreview: (hud.thinkingPreview + e.text).replace(/\s+/g, " ").slice(-PREVIEW_CHARS),
      };

    case "iteration":
      return { ...hud, activity: "thinking", iterCurrent: e.current, iterMax: e.max, ...THINKING_RESET };

    case "tool_call": {
      const target = describeToolTarget(e.name, e.args);
      const item: ToolHistoryItem = { name: e.name, target, status: "running" };
      return {
        ...hud,
        activity: "tool",
        currentTool: e.name,
        currentToolTarget: target || null,
        toolHistory: [...hud.toolHistory, item].slice(-HISTORY_CAP),
        ...THINKING_RESET,
      };
    }

    case "tool_result": {
      // Oldest running entry with the same name (FIFO under parallel tools),
      // falling back to the oldest running entry of any name like the TUI.
      let idx = hud.toolHistory.findIndex((h) => h.status === "running" && h.name === e.name);
      if (idx < 0) idx = hud.toolHistory.findIndex((h) => h.status === "running");
      const toolHistory = hud.toolHistory.slice();
      if (idx >= 0) toolHistory[idx] = { ...toolHistory[idx], status: e.error ? "error" : "success" };
      return { ...hud, activity: "thinking", currentTool: null, currentToolTarget: null, toolHistory };
    }

    case "continuation":
      return { ...hud, continuation: { count: e.count, max: e.max } };

    case "usage":
      return { ...hud, turnTokens: e.turn, lastCompletion: e.lastCompletion };

    case "done":
      return { ...hud, activity: "done", currentTool: null, currentToolTarget: null, ...THINKING_RESET };

    case "error":
      return { ...hud, activity: "error", currentTool: null, currentToolTarget: null, ...THINKING_RESET };

    case "team":
      return { ...hud, teamLanes: applyTeamLaneEvent(hud.teamLanes, e.event, env.ts) };

    case "turn_end":
      return hud.activity === "done" || hud.activity === "error" ? hud : { ...hud, activity: "idle" };

    default:
      return hud;
  }
}
