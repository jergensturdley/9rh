export function createRunVisualization() {
    return { steps: [], edges: [] };
}
function truncate(text, max = 420) {
    const normalized = text.replace(/\s+$/g, "");
    return normalized.length <= max ? normalized.slice(0, max - 1) + "…" : normalized.slice(0, max - 1) + "…";
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
    const now = Date.now();
    const index = view.steps.findIndex((item) => item.id === step.id);
    if (index >= 0) {
        view.steps[index] = { ...view.steps[index], ...step, createdAt: view.steps[index].createdAt };
    }
    else {
        view.steps.push({ createdAt: now, ...step });
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
function stepRole(event) {
    switch (event.type) {
        case "iteration": return "agent";
        case "tool_call": return "tool";
        case "tool_result": return "tool";
        case "sandbox_health": return "checkpoint";
        case "repair_start":
        case "repair_success":
        case "escalate":
        case "circuit_open": return "repair";
        case "error": return "incident";
        case "incident": return "incident";
        case "branch_create": return "repair";
        case "model_switch":
        case "compact":
        case "continuation": return "reasoning";
        default: return undefined;
    }
}
export function applyAgentEvent(view, event) {
    const role = stepRole(event);
    switch (event.type) {
        case "iteration": {
            const id = `step-${event.current}`;
            upsertStep(view, { id, label: `iteration ${event.current}/${event.max}`, stage: "planning", status: "running", severity: "info", role: "agent" });
            break;
        }
        case "spec_plan":
            upsertStep(view, { id: "spec-plan", label: "generated test plan", stage: "planning", status: "done", severity: "info", role: "reasoning", output: event.summary });
            break;
        case "tool_call": {
            const file = typeof event.args.path === "string" ? event.args.path : undefined;
            const id = `tool-${view.steps.filter((s) => s.id.startsWith("tool-")).length + 1}`;
            upsertStep(view, { id, label: event.name, stage: "execution", status: "running", severity: "info", role: "tool", tool: event.name, file, params: stringify(event.args) });
            if (view.currentStepId && view.currentStepId !== id)
                addEdge(view, { from: view.currentStepId, to: id, label: "calls" });
            break;
        }
        case "tool_result": {
            const last = [...view.steps].reverse().find((s) => s.tool === event.name && s.status === "running");
            if (last) {
                upsertStep(view, { ...last, status: event.error ? "failed" : "done", severity: event.error ? "error" : "info", output: truncate([event.error, event.output].filter(Boolean).join("\n")) });
            }
            break;
        }
        case "repair_start":
            upsertStep(view, { id: `repair-${event.attempt}`, label: `repair attempt ${event.attempt}`, stage: "repair", status: "running", severity: "warning", role: "repair", output: event.message, repairAttempt: event.attempt });
            break;
        case "repair_success":
            upsertStep(view, { id: `repair-done-${view.steps.length + 1}`, label: "repair succeeded", stage: "repair", status: "repaired", severity: "info", role: "repair", output: event.message });
            break;
        case "escalate":
            upsertStep(view, { id: `escalate-${view.steps.length + 1}`, label: "escalated", stage: "repair", status: "blocked", severity: "error", role: "repair", output: event.message });
            break;
        case "circuit_open":
            upsertStep(view, { id: "circuit-breaker", label: "circuit breaker open", stage: "repair", status: "blocked", severity: "error", role: "incident" });
            break;
        case "error":
            upsertStep(view, { id: `error-${view.steps.length + 1}`, label: "agent error", stage: "repair", status: "failed", severity: "error", role: "incident", output: event.message });
            break;
        case "incident":
            upsertStep(view, { id: event.stepId, label: `incident: ${event.cause}`, stage: "repair", status: "failed", severity: "error", role: "incident", incidentCause: event.cause, repairAttempt: event.repairAttempt, circuitOpen: event.circuitOpen });
            break;
        case "done":
            upsertStep(view, { id: "completion", label: "completion", stage: "completion", status: "done", severity: "info", output: event.text });
            break;
        case "sandbox_health":
            view.sandboxHealth = { total: event.total, sandboxed: event.sandboxed, direct: event.direct, timedOut: event.timedOut };
            break;
        case "compact":
            upsertStep(view, { id: `compact-${view.steps.length + 1}`, label: "compact context", stage: "planning", status: "done", severity: "info", role: "reasoning", output: event.summary });
            break;
        case "continuation":
            upsertStep(view, { id: `continuation-${event.count}`, label: `continuation ${event.count}/${event.max}`, stage: "planning", status: "running", severity: "info", role: "reasoning" });
            break;
        case "model_switch":
            upsertStep(view, { id: `model-switch-${view.steps.length + 1}`, label: `model switch ${event.from} → ${event.to}`, stage: "planning", status: "done", severity: "info", role: "reasoning" });
            break;
        case "branch_create":
            upsertStep(view, { id: event.stepId, label: `branch ${event.branchId}`, stage: "repair", status: "queued", severity: "info", role: "repair", branch: event.branchId, output: event.reason });
            addEdge(view, { from: view.currentStepId ?? "unknown", to: event.stepId, label: "branches" });
            break;
        case "step_inspect": {
            const existing = view.steps.find((s) => s.id === event.stepId);
            if (existing) {
                upsertStep(view, { ...existing, params: event.params ?? existing.params, output: event.output ?? existing.output, diff: event.diff ?? existing.diff, trace: event.trace ?? existing.trace, policy: event.policy ?? existing.policy });
            }
            else {
                upsertStep(view, { id: event.stepId, label: `inspect ${event.stepId}`, stage: "review", status: "done", severity: "info", params: event.params, output: event.output, diff: event.diff, trace: event.trace, policy: event.policy });
            }
            break;
        }
        case "partial_output": {
            const existing = view.steps.find((s) => s.id === event.stepId);
            if (existing) {
                const prev = existing.partialOutput ?? "";
                upsertStep(view, { ...existing, partialOutput: truncate(prev + event.text, 420), status: "running" });
            }
            else {
                upsertStep(view, { id: event.stepId, label: `streaming ${event.stepId}`, stage: "execution", status: "running", severity: "info", partialOutput: truncate(event.text, 420) });
            }
            break;
        }
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
        upsertStep(view, { id, label: `checkpoint: ${event.payload.reason}`, stage: "execution", status: "done", severity: "info", role: "checkpoint", output: `messages=${event.payload.messageCount}`, durationMs: event.durationMs });
        addEdge(view, { from: stepIdFromReplay(event), to: id, label: "snapshot" });
    }
    else if (event.type === "reasoning_plan") {
        const id = `plan-${event.payload.callId}`;
        upsertStep(view, { id, label: event.payload.currentStep, stage: "planning", status: "done", severity: "info", role: "reasoning", tool: event.payload.chosenTool, output: event.payload.expectedOutcome });
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
            role: event.payload.corrected ? "repair" : "reasoning",
            output: event.payload.observedOutcome,
        });
        addEdge(view, { from: `plan-${event.payload.callId}`, to: id, label: "observes" });
    }
    else if (event.type === "branch_create") {
        const stepId = `branch-${event.payload.newBranchId}`;
        upsertStep(view, { id: stepId, label: `branch ${event.payload.newBranchId}`, stage: "repair", status: "queued", severity: "info", role: "repair", branch: event.payload.newBranchId, output: event.payload.branchReason });
    }
}
function matches(step, filter) {
    if (filter.stage && step.stage !== filter.stage)
        return false;
    if (filter.status && step.status !== filter.status)
        return false;
    if (filter.severity && step.severity !== filter.severity)
        return false;
    if (filter.role && step.role !== filter.role)
        return false;
    if (filter.tool && step.tool !== filter.tool)
        return false;
    if (filter.file && step.file !== filter.file)
        return false;
    if (filter.branch && step.branch !== filter.branch)
        return false;
    if (filter.collapseNoise && step.severity === "info" && step.status === "done" && (step.stage === "planning" || step.stage === "review"))
        return false;
    if (filter.sinceStep) {
        const stepNum = parseInt(step.id.replace(/[^0-9].*/, ""));
        if (stepNum < filter.sinceStep)
            return false;
    }
    if (filter.untilStep) {
        const stepNum = parseInt(step.id.replace(/[^0-9].*/, ""));
        if (stepNum > filter.untilStep)
            return false;
    }
    return true;
}
export function visibleSteps(view, filter = {}) {
    return view.steps.filter((step) => matches(step, filter));
}
export function inspectStep(view, stepId) {
    return view.steps.find((s) => s.id === stepId) ?? null;
}
export function exportRunVisualization(view, filter = {}) {
    return JSON.stringify({ ...view, steps: visibleSteps(view, filter) }, null, 2);
}
export function exportRunVisualizationGraphviz(view, filter = {}) {
    const steps = visibleSteps(view, filter);
    const lines = ["digraph run {", "  rankdir=LR;", "  node [shape=box fontname=monospace];", "  edge [fontname=monospace];"];
    const statusColor = {
        queued: "#888888", running: "#1E90FF", blocked: "#FF4500",
        failed: "#DC143C", repaired: "#FFA500", done: "#32CD32",
    };
    const stageShape = {
        planning: "oval", execution: "box", review: "diamond", repair: "hexagon", completion: "doubleoctagon",
    };
    for (const step of steps) {
        const color = statusColor[step.status];
        const label = step.label.replace(/"/g, '\\"');
        const extras = [];
        if (step.tool)
            extras.push(`tool=${step.tool}`);
        if (step.file)
            extras.push(`file=${step.file}`);
        if (step.severity)
            extras.push(`severity=${step.severity}`);
        const extraStr = extras.length ? `\\n[${extras.join(", ")}]` : "";
        lines.push(`  "${step.id}" [label="${label}${extraStr}" fillcolor="${color}40" color="${color}" shape="${stageShape[step.stage]}" style=filled];`);
    }
    for (const edge of view.edges) {
        if (steps.some((s) => s.id === edge.from) && steps.some((s) => s.id === edge.to)) {
            lines.push(`  "${edge.from}" -> "${edge.to}" [label="${edge.label}" color="#666666"];`);
        }
    }
    lines.push("}");
    return lines.join("\n");
}
export function renderRunVisualization(view, filter = {}) {
    const steps = visibleSteps(view, filter).slice(-12);
    const statusGlyph = {
        queued: "○", running: "◉", blocked: "■", failed: "✗", repaired: "◆", done: "✓",
    };
    const stageColor = {
        planning: "PLN", execution: "EXE", review: "REV", repair: "RPR", completion: "CMP",
    };
    const lines = [];
    for (const step of steps) {
        const current = step.id === view.currentStepId ? "→" : " ";
        const stage = stageColor[step.stage];
        const sev = step.severity === "error" ? "ERR" : step.severity === "warning" ? "WRN" : "   ";
        const role = step.role ? `[${step.role}]`.padEnd(10) : "          ";
        const file = step.file ? ` @${step.file}` : "";
        const partial = step.partialOutput ? " ▌" : "";
        lines.push(`${current} ${statusGlyph[step.status]} ${stage} ${sev} ${role} ${step.label}${file}${partial}`);
        if (step.partialOutput) {
            lines.push(`    └ streaming: ${step.partialOutput.slice(0, 60)}…`);
        }
    }
    const graph = view.edges.slice(-8).map((e) => `  ${e.from} ─${e.label}→ ${e.to}`);
    const sandbox = view.sandboxHealth
        ? `sandbox total=${view.sandboxHealth.total} sandboxed=${view.sandboxHealth.sandboxed} direct=${view.sandboxHealth.direct} timedOut=${view.sandboxHealth.timedOut}`
        : "sandbox pending";
    const checkpoint = view.lastGoodCheckpointId ? `last good checkpoint: ${view.lastGoodCheckpointId}` : "last good checkpoint: none";
    return [
        "▣ LIVE RUN MAP",
        `  ${sandbox}`,
        `  ${checkpoint}`,
        "",
        "  timeline:",
        ...(lines.length ? lines : ["  ○ queued     waiting for first event"]),
        "",
        "  dependency graph:",
        ...(graph.length ? graph : ["  (no dependencies yet)"]),
    ].join("\n");
}
//# sourceMappingURL=visualization.js.map