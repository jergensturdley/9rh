export function createRunVisualization() {
    return { steps: [], edges: [] };
}
function truncate(text, max = 420) {
    const normalized = text.replace(/\s+$/g, "");
    return normalized.length <= max ? normalized : normalized.slice(0, max - 1) + "…";
}
function stringify(value) {
    try {
        return truncate(JSON.stringify(value, null, 2));
    }
    catch {
        return truncate(String(value));
    }
}
function upsertStep(view, step) {
    const index = view.steps.findIndex((item) => item.id === step.id);
    if (index >= 0) {
        view.steps[index] = { ...view.steps[index], ...step };
    }
    else {
        view.steps.push(step);
    }
    view.currentStepId = step.id;
}
function addEdge(view, edge) {
    if (view.edges.some((item) => item.from === edge.from && item.to === edge.to && item.label === edge.label))
        return;
    view.edges.push(edge);
}
function stepIdFromReplay(event) {
    const step = "step" in event && event.step ? event.step.stepIndex : 0;
    return `step-${step}`;
}
export function applyAgentEvent(view, event) {
    switch (event.type) {
        case "iteration": {
            const id = `step-${event.current}`;
            upsertStep(view, {
                id,
                label: `iteration ${event.current}/${event.max}`,
                stage: "planning",
                status: "running",
                severity: "info",
            });
            break;
        }
        case "spec_plan":
            upsertStep(view, {
                id: "spec-plan",
                label: "generated specification/test plan",
                stage: "planning",
                status: "done",
                severity: "info",
                output: event.summary,
            });
            break;
        case "tool_call": {
            const file = typeof event.args.path === "string" ? event.args.path : undefined;
            const id = `tool-${view.steps.filter((item) => item.id.startsWith("tool-")).length + 1}`;
            upsertStep(view, {
                id,
                label: event.name,
                stage: "execution",
                status: "running",
                severity: "info",
                tool: event.name,
                file,
                params: stringify(event.args),
            });
            if (view.currentStepId && view.currentStepId !== id)
                addEdge(view, { from: view.currentStepId, to: id, label: "calls" });
            break;
        }
        case "tool_result": {
            const last = [...view.steps].reverse().find((item) => item.tool === event.name && item.status === "running");
            if (last) {
                upsertStep(view, {
                    ...last,
                    status: event.error ? "failed" : "done",
                    severity: event.error ? "error" : "info",
                    output: truncate([event.error, event.output].filter(Boolean).join("\n")),
                });
            }
            break;
        }
        case "repair_start":
            upsertStep(view, {
                id: `repair-${event.attempt}`,
                label: `repair attempt ${event.attempt}`,
                stage: "repair",
                status: "running",
                severity: "warning",
                output: event.message,
            });
            break;
        case "repair_success":
            upsertStep(view, {
                id: `repair-done-${view.steps.length + 1}`,
                label: "repair succeeded",
                stage: "repair",
                status: "repaired",
                severity: "info",
                output: event.message,
            });
            break;
        case "circuit_open":
            upsertStep(view, {
                id: "circuit-breaker",
                label: "circuit breaker open",
                stage: "repair",
                status: "blocked",
                severity: "error",
            });
            break;
        case "error":
            upsertStep(view, {
                id: `error-${view.steps.length + 1}`,
                label: "agent error",
                stage: "repair",
                status: "failed",
                severity: "error",
                output: event.message,
            });
            break;
        case "done":
            upsertStep(view, {
                id: "completion",
                label: "completion",
                stage: "completion",
                status: "done",
                severity: "info",
                output: event.text,
            });
            break;
        case "sandbox_health":
            view.sandboxHealth = {
                total: event.total,
                sandboxed: event.sandboxed,
                direct: event.direct,
                timedOut: event.timedOut,
            };
            break;
        case "replay_event":
            applyReplayEvent(view, event.event);
            break;
        default:
            break;
    }
    return view;
}
export function applyReplayEvent(view, event) {
    if (event.type === "checkpoint") {
        const id = `checkpoint-${event.payload.snapshotId}`;
        view.lastGoodCheckpointId = id;
        upsertStep(view, {
            id,
            label: `checkpoint: ${event.payload.reason}`,
            stage: "execution",
            status: "done",
            severity: "info",
            output: `messages=${event.payload.messageCount}`,
        });
        addEdge(view, { from: stepIdFromReplay(event), to: id, label: "snapshot" });
    }
    else if (event.type === "reasoning_plan") {
        const id = `plan-${event.payload.callId}`;
        upsertStep(view, {
            id,
            label: event.payload.currentStep,
            stage: "planning",
            status: "done",
            severity: "info",
            tool: event.payload.chosenTool,
            output: event.payload.expectedOutcome,
        });
        addEdge(view, { from: stepIdFromReplay(event), to: id, label: "plans" });
    }
    else if (event.type === "reasoning_summary") {
        const id = `summary-${event.payload.callId}`;
        upsertStep(view, {
            id,
            label: "reasoning summary",
            stage: event.payload.corrected ? "repair" : "review",
            status: event.payload.corrected ? "repaired" : event.payload.deviations.length > 0 ? "failed" : "done",
            severity: event.payload.deviations.length > 0 ? "warning" : "info",
            output: event.payload.observedOutcome,
        });
        addEdge(view, { from: `plan-${event.payload.callId}`, to: id, label: "observes" });
    }
    else if (event.type === "branch_create") {
        upsertStep(view, {
            id: `branch-${event.payload.newBranchId}`,
            label: `branch ${event.payload.newBranchId}`,
            stage: "repair",
            status: "queued",
            severity: "info",
            branch: event.payload.newBranchId,
            output: event.payload.branchReason,
        });
    }
}
function matches(step, filter) {
    if (filter.stage && step.stage !== filter.stage)
        return false;
    if (filter.status && step.status !== filter.status)
        return false;
    if (filter.severity && step.severity !== filter.severity)
        return false;
    if (filter.tool && step.tool !== filter.tool)
        return false;
    if (filter.file && step.file !== filter.file)
        return false;
    if (filter.branch && step.branch !== filter.branch)
        return false;
    if (filter.collapseNoise && step.severity === "info" && step.status === "done" && step.stage === "planning")
        return false;
    return true;
}
export function visibleSteps(view, filter = {}) {
    return view.steps.filter((step) => matches(step, filter));
}
export function exportRunVisualization(view, filter = {}) {
    return JSON.stringify({ ...view, steps: visibleSteps(view, filter) }, null, 2);
}
export function renderRunVisualization(view, filter = {}) {
    const steps = visibleSteps(view, filter).slice(-8);
    const statusGlyph = {
        queued: "○",
        running: "◉",
        blocked: "■",
        failed: "✗",
        repaired: "◆",
        done: "✓",
    };
    const timeline = steps.map((step) => {
        const current = step.id === view.currentStepId ? "→" : " ";
        const file = step.file ? ` ${step.file}` : "";
        return `${current} ${statusGlyph[step.status]} ${step.stage.padEnd(10)} ${step.label}${file}`;
    });
    const graph = view.edges.slice(-6).map((edge) => `  ${edge.from} ─${edge.label}→ ${edge.to}`);
    const sandbox = view.sandboxHealth
        ? `sandbox total=${view.sandboxHealth.total} sandboxed=${view.sandboxHealth.sandboxed} direct=${view.sandboxHealth.direct} timedOut=${view.sandboxHealth.timedOut}`
        : "sandbox pending";
    const checkpoint = view.lastGoodCheckpointId ? `last good: ${view.lastGoodCheckpointId}` : "last good: none";
    return [
        "LIVE RUN MAP",
        sandbox,
        checkpoint,
        "timeline:",
        ...(timeline.length ? timeline : ["  ○ queued     waiting for first event"]),
        "graph:",
        ...(graph.length ? graph : ["  (no dependencies yet)"]),
    ].join("\n");
}
// Splash animation and Neo-Tokyo-themed helpers were moved to src/splash.ts
// to decouple TUI/visualization from splash-specific code. Keep run
// visualization helpers above untouched.
//# sourceMappingURL=visualization.js.map