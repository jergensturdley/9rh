import { describe, it, expect } from "vitest";
import { applyTeamLaneEvent } from "./teamLanes";
import type { TeamLaneView } from "./types";

describe("applyTeamLaneEvent", () => {
  it("tracks role lifecycle in first-seen order", () => {
    let lanes: TeamLaneView[] = [];
    lanes = applyTeamLaneEvent(lanes, { type: "role_start", role: "architect" }, 1000);
    lanes = applyTeamLaneEvent(lanes, { type: "role_complete", role: "architect", usage: { total: 1200 } }, 3000);
    lanes = applyTeamLaneEvent(lanes, { type: "role_start", role: "implementer" }, 3000);
    lanes = applyTeamLaneEvent(lanes, { type: "role_skip", role: "security_auditor" }, 3000);
    expect(lanes.map((l) => [l.role, l.status])).toEqual([
      ["architect", "done"],
      ["implementer", "active"],
      ["security_auditor", "skipped"],
    ]);
    expect(lanes[0].tokens).toBe(1200);
    expect(lanes[0].startedAt).toBe(1000);
    expect(lanes[0].endedAt).toBe(3000);
  });

  it("accumulates tokens across revision loops of the same role", () => {
    let lanes: TeamLaneView[] = [];
    lanes = applyTeamLaneEvent(lanes, { type: "role_start", role: "implementer" }, 0);
    lanes = applyTeamLaneEvent(lanes, { type: "role_complete", role: "implementer", usage: { total: 500 } }, 10);
    lanes = applyTeamLaneEvent(lanes, { type: "role_start", role: "implementer" }, 20);
    expect(lanes[0].status).toBe("active");
    expect(lanes[0].endedAt).toBeUndefined();
    lanes = applyTeamLaneEvent(lanes, { type: "role_complete", role: "implementer", usage: { total: 300 } }, 30);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].tokens).toBe(800);
    expect(lanes[0].status).toBe("done");
  });

  it("marks cache hits", () => {
    const lanes = applyTeamLaneEvent([], { type: "cache_hit", role: "architect" }, 5);
    expect(lanes[0].status).toBe("cache");
  });

  it("ignores events without a role and never mutates the input", () => {
    const input: TeamLaneView[] = [{ role: "architect", status: "active", startedAt: 1 }];
    const frozen = JSON.stringify(input);
    expect(applyTeamLaneEvent(input, { type: "task_complete" }, 9)).toBe(input);
    const next = applyTeamLaneEvent(input, { type: "role_complete", role: "architect" }, 9);
    expect(next).not.toBe(input);
    expect(next[0]).toMatchObject({ status: "done", endedAt: 9 });
    expect(next[0].tokens).toBeUndefined();
    expect(JSON.stringify(input)).toBe(frozen);
  });
});
