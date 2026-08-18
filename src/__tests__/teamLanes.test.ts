import { describe, it, expect } from "@jest/globals";
import { applyTeamEvent, renderTeamLanes, renderDashboardLines, type TeamLane, type DashboardState } from "../tui.js";
import { createRunVisualization } from "../visualization.js";
import { SessionLedger } from "../ledger.js";

describe("applyTeamEvent — TEAM lane folding", () => {
  it("tracks role lifecycle in first-seen order", () => {
    const lanes: TeamLane[] = [];
    applyTeamEvent(lanes, { type: "role_start", role: "architect" }, 1000);
    applyTeamEvent(lanes, { type: "role_complete", role: "architect", usage: { total: 1200 } }, 3000);
    applyTeamEvent(lanes, { type: "role_start", role: "implementer" }, 3000);
    applyTeamEvent(lanes, { type: "role_skip", role: "security_auditor" }, 3000);
    expect(lanes.map((l) => [l.role, l.status])).toEqual([
      ["architect", "done"],
      ["implementer", "active"],
      ["security_auditor", "skipped"],
    ]);
    expect(lanes[0].tokens).toBe(1200);
    expect(lanes[0].endedAt).toBe(3000);
  });

  it("accumulates tokens across revision loops of the same role", () => {
    const lanes: TeamLane[] = [];
    applyTeamEvent(lanes, { type: "role_start", role: "implementer" }, 0);
    applyTeamEvent(lanes, { type: "role_complete", role: "implementer", usage: { total: 500 } }, 10);
    applyTeamEvent(lanes, { type: "role_start", role: "implementer" }, 20);
    applyTeamEvent(lanes, { type: "role_complete", role: "implementer", usage: { total: 300 } }, 30);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].tokens).toBe(800);
    expect(lanes[0].status).toBe("done");
  });

  it("marks cache hits", () => {
    const lanes: TeamLane[] = [];
    applyTeamEvent(lanes, { type: "cache_hit", role: "architect" });
    expect(lanes[0].status).toBe("cache");
  });
});

describe("renderTeamLanes", () => {
  it("renders one line per lane with icons, elapsed, and tokens", () => {
    const lanes: TeamLane[] = [
      { role: "architect", status: "done", startedAt: 0, endedAt: 12_000, tokens: 1200 },
      { role: "implementer", status: "active", startedAt: 60_000 },
      { role: "security_auditor", status: "skipped" },
    ];
    const lines = renderTeamLanes(lanes, 122_000);
    expect(lines[0]).toBe("✓ architect · 12s · 1.2k tok");
    expect(lines[1]).toBe("⚙ implementer · 1m 2s");
    expect(lines[2]).toBe("⊘ security_auditor");
  });
});

describe("dashboard TEAM panel", () => {
  const baseState = (): DashboardState => ({
    startedAt: new Date(),
    iterCurrent: 1,
    iterMax: 5,
    activity: "thinking",
    thinkingCharCount: 0,
    thinkingPreview: "",
    currentTool: null,
    currentToolTarget: null,
    toolHistory: [],
  });

  it("shows lanes when a pipeline is active and hides the panel otherwise", () => {
    const withLanes = baseState();
    withLanes.teamLanes = [{ role: "architect", status: "active", startedAt: Date.now() }];
    const lines = renderDashboardLines(withLanes, false, 40, createRunVisualization()).join("\n");
    expect(lines).toContain("▸ team");
    expect(lines).toContain("⚙ architect");

    const without = renderDashboardLines(baseState(), false, 40, createRunVisualization()).join("\n");
    expect(without).not.toContain("▸ team");
  });
});

describe("SessionLedger — team turns", () => {
  it("accumulates per-role tokens into the turn and the /usage breakdown", () => {
    const ledger = new SessionLedger(0);
    ledger.beginTurn("design the api", 0);
    ledger.onAgentEvent({
      type: "team",
      event: { type: "role_complete", role: "architect", usage: { prompt: 100, completion: 50, total: 150 } },
    });
    ledger.onAgentEvent({
      type: "team",
      event: { type: "role_complete", role: "implementer", usage: { prompt: 200, completion: 100, total: 300 } },
    });
    // Second architect pass (revision) accumulates.
    ledger.onAgentEvent({
      type: "team",
      event: { type: "role_complete", role: "architect", usage: { prompt: 10, completion: 5, total: 15 } },
    });
    const view = ledger.view(1);
    expect(view.tokens.total).toBe(465);
    const turn = view.turns[0];
    expect(turn.roleTokens?.architect.total).toBe(165);
    expect(turn.roleTokens?.implementer.total).toBe(300);
  });

  it("ignores team events with no usage and no open turn", () => {
    const ledger = new SessionLedger(0);
    // No open turn — must not throw.
    ledger.onAgentEvent({ type: "team", event: { type: "role_complete", role: "architect", usage: { prompt: 1, completion: 1, total: 2 } } });
    ledger.beginTurn("t", 0);
    ledger.onAgentEvent({ type: "team", event: { type: "role_start", role: "architect" } });
    expect(ledger.view(1).tokens.total).toBe(0);
  });
});
