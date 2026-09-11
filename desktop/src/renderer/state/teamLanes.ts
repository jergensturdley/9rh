/**
 * Pure port of `applyTeamEvent` in the 9rh TUI (src/tui.ts): fold one
 * orchestrator event into the TEAM lane list, first-seen role order.
 * Returns a new array; the input is never mutated.
 */

import type { TeamLaneView } from "./types";

export interface TeamLaneEvent {
  type: string;
  role?: string;
  usage?: { total: number };
}

export function applyTeamLaneEvent(lanes: TeamLaneView[], event: TeamLaneEvent, now: number): TeamLaneView[] {
  if (!event.role) return lanes;
  const idx = lanes.findIndex((l) => l.role === event.role);
  const prev: TeamLaneView = idx >= 0 ? lanes[idx] : { role: event.role, status: "active" };
  let lane: TeamLaneView;
  switch (event.type) {
    case "role_start":
      lane = { ...prev, status: "active", startedAt: prev.startedAt ?? now, endedAt: undefined };
      break;
    case "role_complete":
      lane = {
        ...prev,
        status: "done",
        endedAt: now,
        tokens: event.usage ? (prev.tokens ?? 0) + event.usage.total : prev.tokens,
      };
      break;
    case "role_skip":
      lane = { ...prev, status: "skipped" };
      break;
    case "cache_hit":
      lane = { ...prev, status: "cache" };
      break;
    default:
      lane = prev;
  }
  const next = lanes.slice();
  if (idx >= 0) next[idx] = lane;
  else next.push(lane);
  return next;
}
