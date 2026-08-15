import { describe, expect, it } from "@jest/globals";
import {
  SessionLedger,
  buildTurnDigest,
  countLineChanges,
  summarizeFileChanges,
  summarizeCommands,
  fmtTokens,
  fmtDurationMs,
  renderBrief,
  renderUsage,
  type TurnDigest,
} from "../ledger.js";
import type { FileChangeRecord, ToolCallRecord } from "../reports/runReportData.js";

function toolCall(overrides: Partial<ToolCallRecord> & { name: string }): ToolCallRecord {
  return { step: 1, args: {}, timestamp: 0, ...overrides };
}

describe("countLineChanges", () => {
  it("counts a pure creation as all lines added", () => {
    expect(countLineChanges(undefined, "a\nb\nc")).toEqual({ added: 3, removed: 0 });
  });

  it("returns zero for identical content", () => {
    expect(countLineChanges("a\nb", "a\nb")).toEqual({ added: 0, removed: 0 });
  });

  it("counts line-level adds and removes via LCS", () => {
    // b replaced by x, d appended → 2 added (x, d), 1 removed (b)
    expect(countLineChanges("a\nb\nc", "a\nx\nc\nd")).toEqual({ added: 2, removed: 1 });
  });

  it("counts a full rewrite as all-out, all-in", () => {
    expect(countLineChanges("one\ntwo", "three\nfour\nfive")).toEqual({ added: 3, removed: 2 });
  });
});

describe("summarizeFileChanges", () => {
  it("merges repeated edits to one path into first-before vs last-after", () => {
    const changes: FileChangeRecord[] = [
      { step: 1, path: "/w/src/a.ts", operation: "edit", before: "a\nb", after: "a\nb\nc" },
      { step: 2, path: "/w/src/a.ts", operation: "edit", before: "a\nb\nc", after: "a\nb\nc\nd\ne" },
    ];
    const entries = summarizeFileChanges(changes, "/w");
    expect(entries).toEqual([{ path: "src/a.ts", operation: "edit", added: 3, removed: 0 }]);
  });

  it("keeps create operation when a file is created then edited", () => {
    const changes: FileChangeRecord[] = [
      { step: 1, path: "/w/new.ts", operation: "create", before: undefined, after: "x" },
      { step: 2, path: "/w/new.ts", operation: "edit", before: "x", after: "x\ny" },
    ];
    const entries = summarizeFileChanges(changes, "/w");
    expect(entries).toEqual([{ path: "new.ts", operation: "create", added: 2, removed: 0 }]);
  });

  it("leaves paths outside the workDir absolute", () => {
    const changes: FileChangeRecord[] = [
      { step: 1, path: "/elsewhere/f.ts", operation: "edit", before: "a", after: "b" },
    ];
    expect(summarizeFileChanges(changes, "/w")[0].path).toBe("/elsewhere/f.ts");
  });
});

describe("summarizeCommands", () => {
  it("extracts run_bash calls with pass/fail", () => {
    const calls: ToolCallRecord[] = [
      toolCall({ name: "run_bash", args: { command: "npm test" } }),
      toolCall({ name: "run_bash", args: { command: "npm run lint" }, error: "exit 1" }),
      toolCall({ name: "read_file", args: { path: "a.ts" } }),
    ];
    expect(summarizeCommands(calls)).toEqual([
      { command: "npm test", ok: true },
      { command: "npm run lint", ok: false },
    ]);
  });
});

describe("buildTurnDigest", () => {
  it("assembles receipts from harness records", () => {
    const digest = buildTurnDigest(
      {
        task: "fix the bug",
        startedAt: 1_000,
        workDir: "/w",
        fileChanges: [{ step: 1, path: "/w/a.ts", operation: "edit", before: "x", after: "x\ny" }],
        toolCalls: [
          toolCall({ name: "read_file" }),
          toolCall({ name: "read_file" }),
          toolCall({ name: "run_bash", args: { command: "npm test" } }),
        ],
      },
      { status: "completed", steps: 3, tokens: { prompt: 100, completion: 50, total: 150 }, now: 61_000 },
    );
    expect(digest.durationMs).toBe(60_000);
    expect(digest.steps).toBe(3);
    expect(digest.files).toEqual([{ path: "a.ts", operation: "edit", added: 1, removed: 0 }]);
    expect(digest.commands).toEqual([{ command: "npm test", ok: true }]);
    expect(digest.toolCounts).toEqual({ read_file: 2, run_bash: 1 });
    expect(digest.tokens).toEqual({ prompt: 100, completion: 50, total: 150 });
  });
});

function digestFor(task: string, overrides: Partial<TurnDigest> = {}): TurnDigest {
  return {
    task,
    status: "completed",
    durationMs: 1_000,
    steps: 1,
    files: [],
    commands: [],
    toolCounts: {},
    ...overrides,
  };
}

describe("SessionLedger", () => {
  it("accumulates usage events into the open turn and totals across turns", () => {
    const ledger = new SessionLedger(0);
    ledger.beginTurn("first task", 10);
    ledger.onAgentEvent({ type: "usage", lastCompletion: { prompt: 10, completion: 5, total: 15 }, turn: { prompt: 10, completion: 5, total: 15 } }, 20);
    ledger.onAgentEvent({ type: "usage", lastCompletion: { prompt: 20, completion: 5, total: 25 }, turn: { prompt: 30, completion: 10, total: 40 } }, 30);
    ledger.onAgentEvent({ type: "done", text: "ok", digest: digestFor("first task", { tokens: { prompt: 30, completion: 10, total: 40 } }) }, 40);

    ledger.beginTurn("second task", 50);
    ledger.onAgentEvent({ type: "usage", lastCompletion: { prompt: 7, completion: 3, total: 10 }, turn: { prompt: 7, completion: 3, total: 10 } }, 60);

    const view = ledger.view(70);
    expect(view.turnCount).toBe(2);
    expect(view.completedTurnCount).toBe(1);
    expect(view.goal).toBe("second task");
    expect(view.goalActive).toBe(true);
    expect(view.tokens).toEqual({ prompt: 37, completion: 13, total: 50 });
  });

  it("first completion wins when error and done both arrive (abort path)", () => {
    const ledger = new SessionLedger(0);
    ledger.beginTurn("task", 10);
    const digest = digestFor("task", { status: "aborted" });
    ledger.onAgentEvent({ type: "error", message: "interrupted", digest }, 20);
    ledger.onAgentEvent({ type: "done", text: "", digest: digestFor("task", { status: "completed" }) }, 30);

    const view = ledger.view(40);
    expect(view.turnCount).toBe(1);
    expect(view.turns[0].status).toBe("aborted");
    expect(view.turns[0].endedAt).toBe(20);
  });

  it("closes a dangling turn as errored when a new one begins", () => {
    const ledger = new SessionLedger(0);
    ledger.beginTurn("died mid-run", 10);
    ledger.beginTurn("next", 20);
    const view = ledger.view(30);
    expect(view.turns[0].status).toBe("error");
    expect(view.turns[0].endedAt).toBe(20);
  });

  it("counts unique files and commands across completed turns", () => {
    const ledger = new SessionLedger(0);
    ledger.beginTurn("one", 10);
    ledger.completeTurn(
      digestFor("one", {
        files: [
          { path: "a.ts", operation: "edit", added: 1, removed: 0 },
          { path: "b.ts", operation: "create", added: 5, removed: 0 },
        ],
        commands: [{ command: "npm test", ok: true }],
      }),
      "completed",
      20,
    );
    ledger.beginTurn("two", 30);
    ledger.completeTurn(
      digestFor("two", {
        files: [{ path: "a.ts", operation: "edit", added: 2, removed: 2 }],
        commands: [{ command: "npm test", ok: true }],
      }),
      "completed",
      40,
    );
    const view = ledger.view(50);
    expect(view.filesTouched).toBe(2);
    expect(view.commandsRun).toBe(2);
    expect(view.lastOutcome).toContain("two");
  });

  it("ignores usage and completion events with no open turn", () => {
    const ledger = new SessionLedger(0);
    ledger.onAgentEvent({ type: "usage", lastCompletion: { prompt: 1, completion: 1, total: 2 }, turn: { prompt: 1, completion: 1, total: 2 } });
    ledger.onAgentEvent({ type: "done", text: "stray" });
    expect(ledger.view().turnCount).toBe(0);
  });
});

describe("formatting", () => {
  it("fmtTokens", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1_000)).toBe("1k");
    expect(fmtTokens(12_400)).toBe("12.4k");
    expect(fmtTokens(1_200_000)).toBe("1.2M");
    expect(fmtTokens(-5)).toBe("0");
  });

  it("fmtDurationMs", () => {
    expect(fmtDurationMs(900)).toBe("0s");
    expect(fmtDurationMs(42_000)).toBe("42s");
    expect(fmtDurationMs(222_000)).toBe("3m 42s");
    expect(fmtDurationMs(3_700_000)).toBe("1h 1m");
  });
});

describe("renderers", () => {
  function populatedLedger(): SessionLedger {
    const ledger = new SessionLedger(0);
    ledger.beginTurn("fix flaky retry test", 10);
    ledger.onAgentEvent(
      { type: "usage", lastCompletion: { prompt: 1200, completion: 300, total: 1500 }, turn: { prompt: 1200, completion: 300, total: 1500 } },
      20,
    );
    ledger.completeTurn(
      digestFor("fix flaky retry test", {
        files: [{ path: "src/a.ts", operation: "edit", added: 3, removed: 1 }],
        commands: [{ command: "npm test", ok: true }],
        tokens: { prompt: 1200, completion: 300, total: 1500 },
      }),
      "completed",
      30,
    );
    return ledger;
  }

  it("renderBrief shows goal, totals, and per-turn lines", () => {
    const out = renderBrief(populatedLedger().view(40), false);
    expect(out).toContain("session brief");
    expect(out).toContain("fix flaky retry test");
    expect(out).toContain("turns");
    expect(out).toContain("1 (1 completed)");
    expect(out).toContain("1.2k in / 300 out");
    expect(out).toContain("1 touched");
    expect(out).toContain("1 run");
    expect(out).toContain("1. ✓");
  });

  it("renderBrief handles an empty session", () => {
    const out = renderBrief(new SessionLedger(0).view(1), false);
    expect(out).toContain("no turns yet");
  });

  it("renderUsage shows session totals and per-turn rows without cost", () => {
    const out = renderUsage(populatedLedger().view(40), false);
    expect(out).toContain("token usage — session 1.5k total");
    expect(out).toContain("fix flaky retry test");
    expect(out).toContain("tokens only — no cost estimates");
    expect(out).not.toContain("$");
  });
});
