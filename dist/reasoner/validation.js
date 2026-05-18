export function validateEvent(event) {
    const issues = [];
    if (!event.type) {
        issues.push({ path: "type", message: "Event missing 'type' field", severity: "error" });
        return issues;
    }
    if (typeof event.seq !== "number") {
        issues.push({ path: "seq", message: "Event missing or invalid 'seq' number", severity: "error" });
    }
    if (typeof event.ts !== "number") {
        issues.push({ path: "ts", message: "Event missing or invalid 'ts' timestamp", severity: "error" });
    }
    switch (event.type) {
        case "reasoning_plan":
            validateReasoningPlan(event, issues);
            break;
        case "reasoning_summary":
            validateReasoningSummary(event, issues);
            break;
        case "tool_call":
            if (!event.payload?.callId) {
                issues.push({ path: "payload.callId", message: "tool_call missing callId", severity: "error" });
            }
            if (!event.payload?.toolName) {
                issues.push({ path: "payload.toolName", message: "tool_call missing toolName", severity: "error" });
            }
            break;
        case "tool_result":
            if (!event.payload?.callId) {
                issues.push({ path: "payload.callId", message: "tool_result missing callId", severity: "error" });
            }
            break;
        case "llm_request":
            if (!event.payload?.model) {
                issues.push({ path: "payload.model", message: "llm_request missing model", severity: "error" });
            }
            if (!Array.isArray(event.payload?.messages)) {
                issues.push({ path: "payload.messages", message: "llm_request missing or invalid messages array", severity: "error" });
            }
            break;
        case "llm_response":
            if (typeof event.payload?.text !== "string" && event.payload?.text !== undefined) {
                issues.push({ path: "payload.text", message: "llm_response text must be string or undefined", severity: "warning" });
            }
            break;
        case "spec_plan":
            if (!event.payload?.originalTask) {
                issues.push({ path: "payload.originalTask", message: "spec_plan missing originalTask", severity: "error" });
            }
            if (!event.payload?.summary) {
                issues.push({ path: "payload.summary", message: "spec_plan missing summary", severity: "error" });
            }
            break;
    }
    return issues;
}
function validateReasoningPlan(event, issues) {
    const p = event.payload ?? {};
    for (const field of ["callId", "goal", "chosenTool", "expectedOutcome"]) {
        if (!p[field]) {
            issues.push({ path: `payload.${field}`, message: `reasoning_plan missing required field: ${field}`, severity: "error" });
        }
    }
    if (!Array.isArray(p.assumptions)) {
        issues.push({ path: "payload.assumptions", message: "reasoning_plan assumptions must be an array", severity: "error" });
    }
    if (!Array.isArray(p.alternativesConsidered)) {
        issues.push({ path: "payload.alternativesConsidered", message: "reasoning_plan alternativesConsidered must be an array", severity: "error" });
    }
}
function validateReasoningSummary(event, issues) {
    const p = event.payload ?? {};
    for (const field of ["callId", "observedOutcome", "nextAction"]) {
        if (!p[field]) {
            issues.push({ path: `payload.${field}`, message: `reasoning_summary missing required field: ${field}`, severity: "error" });
        }
    }
    if (typeof p.corrected !== "boolean") {
        issues.push({ path: "payload.corrected", message: "reasoning_summary corrected must be boolean", severity: "error" });
    }
    if (!Array.isArray(p.deviations)) {
        issues.push({ path: "payload.deviations", message: "reasoning_summary deviations must be an array", severity: "warning" });
    }
}
export function repairEvent(event) {
    const issues = validateEvent(event);
    const hasErrors = issues.some((i) => i.severity === "error");
    if (!hasErrors)
        return event;
    const repaired = { ...event };
    if (typeof repaired.seq !== "number")
        repaired.seq = 0;
    if (typeof repaired.ts !== "number")
        repaired.ts = Date.now();
    const p = repaired.payload ?? {};
    if (event.type === "reasoning_plan") {
        repaired.payload = {
            callId: p.callId ?? "<unknown-callId>",
            goal: p.goal ?? "<unknown-goal>",
            currentStep: p.currentStep ?? "<unknown-step>",
            assumptions: Array.isArray(p.assumptions) ? p.assumptions : [],
            chosenTool: p.chosenTool ?? "<unknown-tool>",
            expectedOutcome: p.expectedOutcome ?? "<unknown-outcome>",
            alternativesConsidered: Array.isArray(p.alternativesConsidered) ? p.alternativesConsidered : [],
        };
    }
    else if (event.type === "reasoning_summary") {
        repaired.payload = {
            callId: p.callId ?? "<unknown-callId>",
            expectedOutcome: p.expectedOutcome ?? "<unknown-expected>",
            observedOutcome: p.observedOutcome ?? "<unknown-observed>",
            deviations: Array.isArray(p.deviations) ? p.deviations : [],
            nextAction: p.nextAction ?? "<unknown-next>",
            corrected: typeof p.corrected === "boolean" ? p.corrected : false,
        };
    }
    else if (event.type === "tool_call" || event.type === "tool_result") {
        repaired.payload = { ...p, callId: p.callId ?? "<unknown-callId>", toolName: p.toolName ?? "unknown" };
    }
    else if (event.type === "spec_plan") {
        repaired.payload = {
            originalTask: p.originalTask ?? "<unknown-task>",
            summary: p.summary ?? "<unknown-summary>",
        };
    }
    return repaired;
}
export function validateAndRepair(event) {
    const issues = validateEvent(event);
    const hasErrors = issues.some((i) => i.severity === "error");
    const repaired = hasErrors ? repairEvent(event) : event;
    return { event: repaired, issues };
}
//# sourceMappingURL=validation.js.map