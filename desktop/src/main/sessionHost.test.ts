import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Keep every ~/.9rh write (runs, reports, skills) inside a throwaway dir.
process.env.NINE_RH_HOME = mkdtempSync(join(tmpdir(), "9rh-desktop-test-"));

import { afterEach, describe, expect, it } from "vitest";
import { buildTurnDigest } from "9rh";
import type { AgentConfig, AgentEvent, Backend, OrchestratorConfig, TokenUsage } from "9rh";
import type { SessionEventEnvelope, SessionSnapshot } from "@shared/ipc";
import { SessionHost, type AgentLike, type OrchestratorLike } from "./sessionHost";

const WORK = mkdtempSync(join(tmpdir(), "9rh-desktop-work-"));
const RUNS = join(process.env.NINE_RH_HOME, "runs");

const backend: Backend = {
  name: "router",
  baseURL: "http://127.0.0.1:20128/v1",
  apiKey: "test-key",
  hasNativeRouter: true,
  describe: () => "router (test)",
  listModels: async () => [{ id: "gpt-x" }, { id: "claude-y" }, { id: "GPT-z" }],
  health: async () => ({ reachable: true, url: "http://127.0.0.1:20128/v1" }),
};

const usage: TokenUsage = { prompt: 10, completion: 5, total: 15 };

/** A scripted agent: `script` drives config.onEvent / HITL callbacks. */
type AgentScript = (config: AgentConfig, task: string, ctl: { aborted: boolean }) => Promise<void>;

function makeHost(
  script: AgentScript = async () => {},
  opts: { createOrchestrator?: (c: OrchestratorConfig) => OrchestratorLike; teamMode?: boolean } = {},
) {
  const emitted: SessionEventEnvelope[] = [];
  const changes: SessionSnapshot[] = [];
  let clock = 1_000_000;
  const host = new SessionHost(
    "s1",
    { workDir: WORK, teamMode: opts.teamMode },
    "gpt-x",
    {
      backend,
      emit: (e) => emitted.push(e),
      onChanged: (s) => changes.push(s),
      createAgent: (config): AgentLike => {
        const ctl = { aborted: false };
        return {
          run: (task) => script(config, task, ctl),
          abort: () => {
            ctl.aborted = true;
          },
          requestStop: () => {
            ctl.aborted = true;
          },
        };
      },
      createOrchestrator: opts.createOrchestrator,
      now: () => ++clock,
      runsDir: RUNS,
    },
  );
  return { host, emitted, changes, events: () => emitted.map((e) => e.event) };
}

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!pred()) throw new Error("condition not met");
}

const emitAll = (config: AgentConfig, events: AgentEvent[]) => events.forEach((e) => config.onEvent?.(e));

let hosts: SessionHost[] = [];
afterEach(() => {
  hosts.forEach((h) => h.dispose());
  hosts = [];
});

describe("SessionHost", () => {
  it("numbers envelopes and brackets the turn with turn_start / turn_end", async () => {
    const { host, emitted, events } = makeHost(async (config) => {
      emitAll(config, [
        { type: "thinking", text: "hm" },
        { type: "usage", lastCompletion: usage, turn: usage },
        { type: "done", text: "ok", reportPath: "/tmp/r.html" },
      ]);
    });
    hosts.push(host);
    const outcome = await host.run({ task: "say hi" });

    expect(outcome.status).toBe("completed");
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(emitted.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(emitted.every((e) => e.sessionId === "s1")).toBe(true);
    expect(events()[0]).toEqual({ type: "turn_start", task: "say hi", turnIndex: 1, team: false });
    expect(events().at(-1)).toMatchObject({ type: "turn_end", turnIndex: 1, status: "completed" });

    const snap = host.snapshot();
    expect(snap.status).toBe("idle");
    expect(snap.turnStartedAt).toBeNull();
    expect(snap.lastReportPath).toBe("/tmp/r.html");
    expect(snap.ledger.completedTurnCount).toBe(1);
    expect(snap.backendName).toBe("router");
    expect(snap.sandbox.label).toMatch(/^(seatbelt|none)$/);
  });

  it("sends lite digests over the wire and gives each session its own report path", async () => {
    const digest = buildTurnDigest(
      {
        task: "edit",
        startedAt: 1,
        workDir: WORK,
        fileChanges: [{ step: 1, path: `${WORK}/src/a.ts`, operation: "edit", before: "a\n", after: "b\n" }],
        toolCalls: [],
      },
      { status: "completed", steps: 1 },
    );
    let reportPath: unknown = "unset";
    const { host, events } = makeHost(async (config) => {
      reportPath = config.reportPath;
      config.onEvent?.({ type: "done", text: "ok", digest });
    });
    hosts.push(host);
    await host.run({ task: "edit" });

    const done = events().find((e) => e.type === "done") as { digest?: Record<string, unknown> } | undefined;
    expect(done?.digest).toBeDefined();
    expect("fileChangeRecords" in done!.digest!).toBe(false);
    expect(done!.digest!.diffablePaths).toEqual(["src/a.ts"]);
    // The ledger still holds the raw records, so rewind and diff keep working.
    expect(host.rewindPlan(1).writes).toHaveLength(1);
    expect(host.diff(1, "src/a.ts").added).toBe(1);
    expect(String(reportPath)).toMatch(/reports[\\/]s1-last-run\.html$/);
  });

  it("auto-dismisses HITL requests raised after abort()", async () => {
    const decisions: Array<{ approved: boolean; reason?: string }> = [];
    const gate = { name: "run_bash", args: { command: "rm -rf x" }, risk: "high" as const, threshold: "high" as const };
    const { host, changes } = makeHost(async (config) => {
      decisions.push(await config.onToolApproval!(gate));
      // The engine finishes the current tool batch after abort(): a second
      // gated call still arrives and must not park the turn.
      decisions.push(await config.onToolApproval!(gate));
    });
    hosts.push(host);
    const running = host.run({ task: "t" });
    await until(() => host.snapshot().status === "waiting");
    host.abort();
    expect(host.snapshot().aborting).toBe(true);
    const outcome = await running;

    expect(outcome.status).toBe("aborted");
    expect(decisions).toEqual([
      { approved: false, reason: "aborted" },
      { approved: false, reason: "aborted" },
    ]);
    expect(changes.filter((s) => s.status === "waiting")).toHaveLength(1);
    expect(host.snapshot().aborting).toBe(false);
  });

  it("run() settles when the session is disposed while a request is pending", async () => {
    const { host } = makeHost(async (config) => {
      await config.onAskUser!({ question: "which?", options: ["a", "b"], allowFreeText: true });
      await config.onAskUser!({ question: "and?", options: [], allowFreeText: true });
    });
    const running = host.run({ task: "t" });
    await until(() => host.snapshot().status === "waiting");
    host.dispose();
    const outcome = await running;
    expect(outcome.status).toBe("aborted");
  });

  it("keeps the digest-bearing terminal when a digest-less error precedes it", async () => {
    const digest = buildTurnDigest(
      {
        task: "edit",
        startedAt: 1,
        workDir: WORK,
        fileChanges: [{ step: 1, path: `${WORK}/src/a.ts`, operation: "edit", before: "a\n", after: "b\n" }],
        toolCalls: [],
      },
      { status: "error", steps: 1 },
    );
    const { host } = makeHost(async (config) => {
      // Mirrors the engine on an API failure: the stream layer emits a bare
      // error, then Agent.run's catch emits the terminal with the digest.
      config.onEvent?.({ type: "error", message: "OpenAI API error: 503" });
      config.onEvent?.({ type: "error", message: "OpenAI API error: 503", digest });
      throw new Error("OpenAI API error: 503");
    });
    hosts.push(host);
    const outcome = await host.run({ task: "edit" });

    expect(outcome.status).toBe("error");
    const snap = host.snapshot();
    expect(snap.ledger.turnCount).toBe(1);
    expect(snap.ledger.goalActive).toBe(false);
    expect(snap.ledger.turns[0].digest?.diffablePaths).toEqual(["src/a.ts"]);
    expect(host.rewindPlan(1).writes).toHaveLength(1);
    expect(host.diff(1, "src/a.ts").removed).toBe(1);
  });

  it("closes the ledger turn when the only terminal is a digest-less error", async () => {
    const { host } = makeHost(async (config) => {
      config.onEvent?.({ type: "error", message: "Agent timed out after 1ms" });
    });
    hosts.push(host);
    const outcome = await host.run({ task: "t" });
    expect(outcome.status).toBe("error");
    const snap = host.snapshot();
    expect(snap.ledger.goalActive).toBe(false);
    expect(snap.ledger.completedTurnCount).toBe(1);
    expect(snap.ledger.turns[0].status).toBe("error");
  });

  it("evicts streamed thinking before structural events when the ring overflows", async () => {
    const { host } = makeHost(async (config) => {
      config.onEvent?.({ type: "tool_call", name: "read_file", args: { path: "a" }, callId: "c1" });
      for (let i = 0; i < 5200; i++) config.onEvent?.({ type: "thinking", text: "x" });
      config.onEvent?.({ type: "tool_result", name: "read_file", output: "ok", callId: "c1" });
      config.onEvent?.({ type: "done", text: "ok" });
    });
    hosts.push(host);
    await host.run({ task: "t" });
    const kinds = host.history().map((e) => e.event.type);
    expect(kinds[0]).toBe("turn_start");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds.at(-1)).toBe("turn_end");
    expect(host.history()).toHaveLength(5000);
  });

  it("folds events into the ledger: usage tokens and a lite digest with diffablePaths", async () => {
    const digest = buildTurnDigest(
      {
        task: "edit",
        startedAt: 1,
        workDir: WORK,
        fileChanges: [{ step: 1, path: `${WORK}/src/a.ts`, operation: "edit", before: "a\n", after: "b\n" }],
        toolCalls: [],
      },
      { status: "completed", steps: 1, tokens: usage },
    );
    const { host, changes } = makeHost(async (config) => {
      emitAll(config, [
        { type: "usage", lastCompletion: usage, turn: usage },
        { type: "done", text: "ok", digest },
      ]);
    });
    hosts.push(host);
    await host.run({ task: "edit" });

    const snap = host.snapshot();
    expect(snap.ledger.tokens).toEqual(usage);
    const turn = snap.ledger.turns[0];
    expect(turn.status).toBe("completed");
    expect(turn.digest).toBeDefined();
    expect("fileChangeRecords" in turn.digest!).toBe(false);
    expect(turn.digest!.diffablePaths).toEqual(["src/a.ts"]);
    expect(turn.digest!.files).toEqual([{ path: "src/a.ts", operation: "edit", added: 1, removed: 1 }]);
    expect(changes.some((s) => s.status === "running")).toBe(true);
    expect(changes.at(-1)?.status).toBe("idle");
  });

  it("ask round trip: pending shows while waiting, answerAsk resolves and clears", async () => {
    const { host } = makeHost(async (config) => {
      const res = await config.onAskUser!({ question: "which?", options: ["A", "B"], allowFreeText: true });
      config.onEvent?.({ type: "done", text: `picked ${res.answer}` });
    });
    hosts.push(host);
    const run = host.run({ task: "ask me" });
    await until(() => host.snapshot().pending !== null);

    const snap = host.snapshot();
    expect(snap.status).toBe("waiting");
    expect(snap.pending).toMatchObject({ kind: "ask", question: "which?", options: ["A", "B"], allowFreeText: true });
    expect(() => host.answerAsk("nope", "A")).toThrow(/no pending ask/);
    expect(() => host.decideApproval(snap.pending!.requestId, true)).toThrow(/no pending approval/);

    host.answerAsk(snap.pending!.requestId, "B");
    expect(host.snapshot().pending).toBeNull();
    const outcome = await run;
    expect(outcome.status).toBe("completed");
    expect(host.snapshot().status).toBe("idle");
    expect(host.history().some((e) => e.event.type === "done" && e.event.text === "picked B")).toBe(true);
  });

  it("approval: reject carries the default reason, approve carries none", async () => {
    const decisions: unknown[] = [];
    const { host } = makeHost(async (config) => {
      const req = { name: "run_bash", args: { command: "rm -rf x" }, risk: "high" as const, threshold: "high" as const };
      decisions.push(await config.onToolApproval!(req));
      decisions.push(await config.onToolApproval!(req));
      config.onEvent?.({ type: "done", text: "ok" });
    });
    hosts.push(host);
    const run = host.run({ task: "danger" });

    await until(() => host.snapshot().pending?.kind === "approval");
    expect(host.snapshot().pending).toMatchObject({ kind: "approval", name: "run_bash", risk: "high", threshold: "high" });
    host.decideApproval(host.snapshot().pending!.requestId, false);
    await until(() => host.snapshot().pending?.kind === "approval");
    host.decideApproval(host.snapshot().pending!.requestId, true);

    await run;
    expect(decisions).toEqual([{ approved: false, reason: "rejected by user" }, { approved: true, reason: undefined }]);
  });

  it("abort dismisses the pending ask and yields outcome aborted", async () => {
    let answer: string | null = null;
    const { host, events } = makeHost(async (config, _task, ctl) => {
      const res = await config.onAskUser!({ question: "q", options: [], allowFreeText: true });
      answer = res.answer;
      if (ctl.aborted) {
        config.onEvent?.({ type: "error", message: "Interrupted by user" });
        config.onEvent?.({ type: "done", text: "Interrupted by user" });
      }
    });
    hosts.push(host);
    const run = host.run({ task: "wait" });
    await until(() => host.snapshot().pending !== null);

    host.abort();
    const outcome = await run;
    expect(outcome.status).toBe("aborted");
    expect(answer).toBe("");
    expect(host.snapshot().pending).toBeNull();
    expect(host.snapshot().status).toBe("idle");
    expect(events().at(-1)).toMatchObject({ type: "turn_end", status: "aborted" });
  });

  it("rejects a concurrent run with 'session busy' and blocks setModel while running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { host } = makeHost(async (config) => {
      await gate;
      config.onEvent?.({ type: "done", text: "ok" });
    });
    hosts.push(host);
    const first = host.run({ task: "one" });
    await expect(host.run({ task: "two" })).rejects.toThrow("session busy");
    expect(() => host.setModel("other")).toThrow(/while a turn is running/);
    await expect(host.rewindApply(1)).rejects.toThrow(/while a turn is running/);
    release();
    await first;
    host.setModel("other");
    expect(host.snapshot().model).toBe("other");
  });

  it("history(sinceSeq) returns only later envelopes", async () => {
    const { host } = makeHost(async (config) => {
      emitAll(config, [{ type: "thinking", text: "a" }, { type: "done", text: "ok" }]);
    });
    hosts.push(host);
    await host.run({ task: "t" });
    expect(host.history().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(host.history(2).map((e) => e.seq)).toEqual([3, 4]);
  });

  it("thrown agent errors close the ledger turn and yield outcome error", async () => {
    const { host, events } = makeHost(async () => {
      throw new Error("boom");
    });
    hosts.push(host);
    const outcome = await host.run({ task: "t" });
    expect(outcome.status).toBe("error");
    const snap = host.snapshot();
    expect(snap.status).toBe("error");
    expect(snap.lastError).toBe("boom");
    expect(snap.ledger.goalActive).toBe(false);
    expect(snap.ledger.turns[0].status).toBe("error");
    expect(events().some((e) => e.type === "error" && e.message === "boom")).toBe(true);
  });

  it("rewindPlan and diff read the digest's file change records", async () => {
    const digest = buildTurnDigest(
      {
        task: "edit",
        startedAt: 1,
        workDir: WORK,
        fileChanges: [
          { step: 1, path: `${WORK}/src/a.ts`, operation: "edit", before: "a\nb\n", after: "a\nc\n" },
          { step: 2, path: `${WORK}/new.txt`, operation: "create", after: "hi\n" },
          { step: 3, path: `${WORK}/src/a.ts`, operation: "edit", before: "a\nc\n", after: "a\nc\nd\n" },
        ],
        toolCalls: [],
      },
      { status: "completed", steps: 3 },
    );
    const { host } = makeHost(async (config) => {
      config.onEvent?.({ type: "done", text: "ok", digest });
    });
    hosts.push(host);
    await host.run({ task: "edit" });

    expect(host.snapshot().ledger.turns[0].digest?.diffablePaths).toEqual(["src/a.ts", "new.txt"]);

    const plan = host.rewindPlan(1);
    expect(plan.targetTurnIndex).toBe(1);
    expect(plan.writes).toEqual([`${WORK}/src/a.ts`, `${WORK}/src/a.ts`]);
    expect(plan.deletes).toEqual([`${WORK}/new.txt`]);
    expect(plan.skips).toEqual([]);

    // First record's before vs last record's after, matched by relative path.
    const edit = host.diff(1, "src/a.ts");
    expect(edit).toMatchObject({ path: "src/a.ts", operation: "edit", added: 2, removed: 1 });
    expect(edit.lines.filter((l) => l.kind !== "context")).toEqual([
      { kind: "remove", text: "b", oldLine: 2 },
      { kind: "add", text: "c", newLine: 2 },
      { kind: "add", text: "d", newLine: 3 },
    ]);
    // Raw record path matches too.
    const create = host.diff(1, `${WORK}/new.txt`);
    expect(create).toMatchObject({ operation: "create", added: 2, removed: 0 });
    expect(() => host.diff(1, "missing.txt")).toThrow(/no file change record/);
    expect(() => host.diff(2, "src/a.ts")).toThrow(/no file change record/);
  });

  it("team mode wraps orchestrator events as {type: 'team'} and closes with a digest", async () => {
    const createOrchestrator = (config: OrchestratorConfig): OrchestratorLike => ({
      orchestrate: async () => {
        config.onEvent?.({ type: "role_start", role: "architect", taskId: "t1" });
        config.onEvent?.({ type: "role_complete", role: "architect", taskId: "t1", result: "plan", usage });
        return { status: "completed", summary: "all good" };
      },
    });
    const { host, events } = makeHost(async () => {
      throw new Error("agent must not run in team mode");
    }, { createOrchestrator });
    hosts.push(host);
    const outcome = await host.run({ task: "build it", team: true });

    expect(outcome.status).toBe("completed");
    expect(events()[0]).toMatchObject({ type: "turn_start", team: true });
    expect(events()[1]).toEqual({ type: "team", event: { type: "role_start", role: "architect", taskId: "t1" } });
    const done = events().find((e) => e.type === "done");
    expect(done).toMatchObject({ type: "done", text: "all good" });
    expect(done && done.type === "done" ? done.digest : undefined).toMatchObject({
      status: "completed",
      steps: 1,
      tokens: usage,
      files: [],
    });
    const turn = host.snapshot().ledger.turns[0];
    expect(turn.roleTokens).toEqual({ architect: usage });
    expect(turn.tokens).toEqual(usage);
  });

  it("team mode escalation becomes an error event and outcome error", async () => {
    const createOrchestrator = (): OrchestratorLike => ({
      orchestrate: async () => ({ status: "escalated", summary: "stuck", escalationReason: "conflict" }),
    });
    const { host, events } = makeHost(undefined, { createOrchestrator, teamMode: true });
    hosts.push(host);
    const outcome = await host.run({ task: "build it" });
    expect(outcome.status).toBe("error");
    expect(events().find((e) => e.type === "error")).toMatchObject({ message: "stuck\n\nEscalated: conflict" });
  });

  it("listModels filters by case-insensitive id substring", async () => {
    const { host } = makeHost();
    hosts.push(host);
    expect((await host.listModels()).map((m) => m.id)).toEqual(["gpt-x", "claude-y", "GPT-z"]);
    expect((await host.listModels("gpt")).map((m) => m.id)).toEqual(["gpt-x", "GPT-z"]);
  });

  it("setWorkDir requires a directory; dispose stops emits", async () => {
    const { host, emitted, changes } = makeHost();
    hosts.push(host);
    await expect(host.setWorkDir(join(WORK, "missing"))).rejects.toThrow();
    await host.setWorkDir(WORK);
    expect(host.snapshot().workDir).toBe(WORK);

    const emittedBefore = emitted.length;
    const changesBefore = changes.length;
    host.dispose();
    host.setQuiet(true);
    expect(emitted.length).toBe(emittedBefore);
    expect(changes.length).toBe(changesBefore);
  });
});
