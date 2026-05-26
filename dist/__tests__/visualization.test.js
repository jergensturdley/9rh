import { describe, expect, it } from "@jest/globals";
import { applyAgentEvent, createRunVisualization, exportRunVisualization, exportRunVisualizationGraphviz, inspectStep, renderRunVisualization, renderRunMapCompact, visibleSteps, } from "../visualization.js";
describe("run visualization", () => {
    it("orders critical events and status transitions for a tool call", () => {
        const view = createRunVisualization();
        const events = [
            { type: "iteration", current: 1, max: 5 },
            { type: "tool_call", name: "read_file", args: { path: "src/agent.ts" } },
            { type: "tool_result", name: "read_file", output: "ok" },
            { type: "done", text: "complete" },
        ];
        for (const event of events)
            applyAgentEvent(view, event);
        expect(view.steps.map((step) => step.status)).toEqual(["running", "done", "done"]);
        expect(view.steps.find((step) => step.tool === "read_file")?.file).toBe("src/agent.ts");
        expect(view.steps.find((step) => step.tool === "read_file")?.role).toBe("tool");
    });
    it("surfaces repair, circuit breaker, checkpoint, and sandbox health", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "sandbox_health", total: 3, sandboxed: 2, direct: 1, timedOut: 0 });
        applyAgentEvent(view, { type: "repair_start", message: "tool failed", attempt: 1 });
        applyAgentEvent(view, { type: "circuit_open" });
        applyAgentEvent(view, {
            type: "replay_event",
            event: {
                type: "checkpoint",
                seq: 1,
                ts: Date.now(),
                step: { stepIndex: 1, iteration: 1, compactCount: 0 },
                payload: { snapshotId: "snap1", messageCount: 4, reason: "periodic" },
            },
        });
        expect(view.sandboxHealth?.total).toBe(3);
        expect(view.lastGoodCheckpointId).toBe("checkpoint-snap1");
        const circuitStep = view.steps.find((s) => s.id === "circuit-breaker");
        expect(circuitStep?.status).toBe("blocked");
        expect(circuitStep?.severity).toBe("error");
        expect(circuitStep?.role).toBe("incident");
    });
    it("filters and exports audit views", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "iteration", current: 1, max: 2 });
        applyAgentEvent(view, { type: "tool_call", name: "write_file", args: { path: "src/new.ts" } });
        applyAgentEvent(view, { type: "tool_result", name: "write_file", output: "written" });
        expect(visibleSteps(view, { tool: "write_file" })).toHaveLength(1);
        expect(visibleSteps(view, { file: "src/new.ts" })).toHaveLength(1);
        expect(exportRunVisualization(view, { tool: "write_file" })).toContain("src/new.ts");
    });
    it("shows continuation compaction and model switching", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "model_switch", from: "fast-default", to: "continuation-heavy", reason: "continuation" });
        applyAgentEvent(view, { type: "compact", summary: "resume summary" });
        applyAgentEvent(view, { type: "continuation", count: 1, max: 2 });
        const rendered = renderRunVisualization(view);
        expect(rendered).toContain("model switch fast-default → continuation-heavy");
        expect(rendered).toContain("compact context");
        expect(rendered).toContain("continuation 1/2");
    });
    it("tracks incident and branch creation events", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "incident", stepId: "incident-1", cause: "tool timeout", repairAttempt: 2, circuitOpen: false });
        applyAgentEvent(view, { type: "branch_create", stepId: "branch-1", branchId: "b1", reason: "recovery from failure" });
        const incident = view.steps.find((s) => s.id === "incident-1");
        expect(incident?.status).toBe("failed");
        expect(incident?.severity).toBe("error");
        expect(incident?.role).toBe("incident");
        expect(incident?.incidentCause).toBe("tool timeout");
        expect(incident?.repairAttempt).toBe(2);
        const branch = view.steps.find((s) => s.id === "branch-1");
        expect(branch?.status).toBe("queued");
        expect(branch?.branch).toBe("b1");
        expect(branch?.role).toBe("repair");
    });
    it("supports step inspection with params, output, diff, trace, and policy", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "iteration", current: 1, max: 1 });
        applyAgentEvent(view, { type: "tool_call", name: "read_file", args: { path: "src/test.ts" } });
        const toolStep = view.steps.find((s) => s.tool === "read_file");
        expect(toolStep).toBeDefined();
        const stepId = toolStep.id;
        applyAgentEvent(view, { type: "step_inspect", stepId, params: '{"path":"src/test.ts"}', output: "file contents", diff: "-old\n+new", trace: "stack trace here", policy: "no deletions" });
        const inspected = inspectStep(view, stepId);
        expect(inspected?.params).toContain("src/test.ts");
        expect(inspected?.output).toBe("file contents");
        expect(inspected?.diff).toBe("-old\n+new");
        expect(inspected?.trace).toBe("stack trace here");
        expect(inspected?.policy).toBe("no deletions");
    });
    it("streams partial output safely for long-running actions", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "iteration", current: 1, max: 1 });
        applyAgentEvent(view, { type: "tool_call", name: "bash", args: { command: "long running command" } });
        const toolStep = view.steps.find((s) => s.tool === "bash");
        const stepId = toolStep.id;
        applyAgentEvent(view, { type: "partial_output", stepId, text: "starting..." });
        applyAgentEvent(view, { type: "partial_output", stepId, text: "\nprocessing..." });
        applyAgentEvent(view, { type: "partial_output", stepId, text: "\ndone." });
        const streamed = view.steps.find((s) => s.id === stepId);
        expect(streamed?.partialOutput).toContain("starting...");
        expect(streamed?.partialOutput).toContain("processing...");
        expect(streamed?.status).toBe("running");
    });
    it("filters by role, severity, and step range", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "iteration", current: 1, max: 5 });
        applyAgentEvent(view, { type: "tool_call", name: "read_file", args: { path: "src/a.ts" } });
        applyAgentEvent(view, { type: "tool_result", name: "read_file", output: "ok" });
        applyAgentEvent(view, { type: "error", message: "something went wrong" });
        expect(visibleSteps(view, { role: "tool" })).toHaveLength(1);
        expect(visibleSteps(view, { severity: "error" })).toHaveLength(1);
        expect(visibleSteps(view, { stage: "repair" })).toHaveLength(1);
    });
    it("exports graphviz format for audit views", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "iteration", current: 1, max: 1 });
        applyAgentEvent(view, { type: "tool_call", name: "read_file", args: { path: "src/test.ts" } });
        applyAgentEvent(view, { type: "tool_result", name: "read_file", output: "ok" });
        const dot = exportRunVisualizationGraphviz(view);
        expect(dot).toContain("digraph run");
        expect(dot).toContain("read_file");
        expect(dot).toContain('"tool-1"');
        expect(dot).toContain("shape=");
    });
    it("applies role correctly to each step type", () => {
        const view = createRunVisualization();
        const events = [
            { type: "iteration", current: 1, max: 3 },
            { type: "tool_call", name: "bash", args: { command: "ls" } },
            { type: "repair_start", message: "failed", attempt: 1 },
            { type: "circuit_open" },
            { type: "done", text: "complete" },
        ];
        for (const event of events)
            applyAgentEvent(view, event);
        const agentStep = view.steps.find((s) => s.label === "iteration 1/3");
        expect(agentStep?.role).toBe("agent");
        const toolStep = view.steps.find((s) => s.tool === "bash");
        expect(toolStep?.role).toBe("tool");
        const repairStep = view.steps.find((s) => s.stage === "repair" && s.status === "running");
        expect(repairStep?.role).toBe("repair");
        const circuitStep = view.steps.find((s) => s.id === "circuit-breaker");
        expect(circuitStep?.role).toBe("incident");
    });
    it("highlights current step and last good checkpoint in rendering", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "iteration", current: 1, max: 2 });
        applyAgentEvent(view, { type: "tool_call", name: "read_file", args: { path: "src/main.ts" } });
        applyAgentEvent(view, {
            type: "replay_event",
            event: {
                type: "checkpoint",
                seq: 1,
                ts: Date.now(),
                step: { stepIndex: 1, iteration: 1, compactCount: 0 },
                payload: { snapshotId: "snap-main", messageCount: 5, reason: "periodic" },
            },
        });
        applyAgentEvent(view, { type: "tool_call", name: "write_file", args: { path: "src/main.ts" } });
        const rendered = renderRunVisualization(view);
        expect(rendered).toContain("last good checkpoint: checkpoint-snap-main");
        expect(rendered).toContain("→");
    });
    it("orders events correctly: iteration → tool_call → tool_result", () => {
        const view = createRunVisualization();
        const events = [
            { type: "iteration", current: 1, max: 5 },
            { type: "tool_call", name: "read_file", args: { path: "src/index.ts" } },
            { type: "tool_result", name: "read_file", output: "file content here" },
        ];
        for (const event of events)
            applyAgentEvent(view, event);
        const toolSteps = view.steps.filter((s) => s.tool === "read_file");
        expect(toolSteps).toHaveLength(1);
        expect(toolSteps[0].status).toBe("done");
        expect(toolSteps[0].stage).toBe("execution");
    });
    it("distinguishes normal execution from repair flows", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "iteration", current: 1, max: 3 });
        applyAgentEvent(view, { type: "tool_call", name: "bash", args: { command: "echo hi" } });
        applyAgentEvent(view, { type: "tool_result", name: "bash", output: "hi" });
        applyAgentEvent(view, { type: "repair_start", message: "bash failed", attempt: 1 });
        applyAgentEvent(view, { type: "repair_success", message: "recovered" });
        const normalSteps = view.steps.filter((s) => s.stage === "execution" && s.status === "done");
        expect(normalSteps.length).toBeGreaterThan(0);
        const repairSteps = view.steps.filter((s) => s.stage === "repair");
        expect(repairSteps.length).toBeGreaterThan(0);
        const repairDone = repairSteps.find((s) => s.status === "repaired");
        expect(repairDone?.label).toBe("repair succeeded");
    });
    it("preserves incident history and recovery outcomes", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "incident", stepId: "inc-1", cause: "network timeout", repairAttempt: 1, circuitOpen: false });
        applyAgentEvent(view, { type: "repair_start", message: "retrying", attempt: 2 });
        applyAgentEvent(view, { type: "repair_success", message: "operation succeeded after retry" });
        const incidents = view.steps.filter((s) => s.role === "incident");
        expect(incidents.length).toBe(1);
        expect(incidents[0].incidentCause).toBe("network timeout");
        const repairHistory = view.steps.filter((s) => s.role === "repair");
        expect(repairHistory.length).toBe(2);
        expect(repairHistory.find((s) => s.status === "repaired")?.output).toContain("succeeded");
    });
});
describe("renderRunMapCompact", () => {
    it("produces compressed timeline lines for a simple run", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "iteration", current: 1, max: 3 });
        applyAgentEvent(view, { type: "tool_call", name: "read_file", args: { path: "src/main.ts" } });
        applyAgentEvent(view, { type: "tool_result", name: "read_file", output: "ok" });
        const lines = renderRunMapCompact(view, 40);
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.some(l => l.includes("read_file"))).toBe(true);
        expect(lines.some(l => l.includes("EXE"))).toBe(true);
    });
    it("truncates long labels to fit maxWidth", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "iteration", current: 1, max: 1 });
        applyAgentEvent(view, { type: "tool_call", name: "read_file", args: { path: "src/components/deep/nested/very/long/path/to/file.ts" } });
        const lines = renderRunMapCompact(view, 30);
        for (const line of lines) {
            expect(line.length).toBeLessThanOrEqual(40);
        }
    });
    it("returns waiting message when no events", () => {
        const view = createRunVisualization();
        const lines = renderRunMapCompact(view, 40);
        expect(lines).toEqual(["○ waiting for first event"]);
    });
    it("shows current step marker", () => {
        const view = createRunVisualization();
        applyAgentEvent(view, { type: "iteration", current: 1, max: 2 });
        applyAgentEvent(view, { type: "tool_call", name: "bash", args: { command: "npm test" } });
        const lines = renderRunMapCompact(view, 40);
        expect(lines.some(l => l.includes("→"))).toBe(true);
    });
});
//# sourceMappingURL=visualization.test.js.map