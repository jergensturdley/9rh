import { describe, expect, it } from "@jest/globals";
import { applyAgentEvent, createRunVisualization, exportRunVisualization, renderRunVisualization, visibleSteps, } from "../visualization.js";
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
        expect(renderRunVisualization(view)).toContain("completion");
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
        const rendered = renderRunVisualization(view);
        expect(rendered).toContain("sandbox total=3");
        expect(rendered).toContain("circuit breaker open");
        expect(view.lastGoodCheckpointId).toBe("checkpoint-snap1");
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
});
//# sourceMappingURL=visualization.test.js.map