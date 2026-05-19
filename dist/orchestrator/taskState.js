export function createTaskState(id, task, projectMemory) {
    return {
        id,
        originalTask: task,
        status: "pending",
        revisionCount: 0,
        maxRevisions: 2,
        projectMemory,
    };
}
export function createProjectMemory(workDir, model) {
    return { workDir, model, taskHistory: [] };
}
export function getArchitectContext(state) {
    return { task: state.originalTask };
}
export function getImplementerContext(state) {
    return { task: state.originalTask, plan: state.architectPlan };
}
export function getReviewerContext(state) {
    return {
        task: state.originalTask,
        plan: state.architectPlan,
        implementation: state.implementationResult,
        semanticReview: state.implementationResult?.semanticReview,
        successCriteria: state.architectPlan?.successCriteria ?? [],
    };
}
export function getSecurityAuditContext(state) {
    return {
        task: state.originalTask,
        riskLevel: state.architectPlan?.riskLevel,
        filesModified: state.implementationResult?.filesModified ?? [],
        diff: state.implementationResult?.diff ?? "",
    };
}
export function getTestStrategyContext(state) {
    return {
        task: state.originalTask,
        plan: state.architectPlan,
        filesModified: state.implementationResult?.filesModified ?? [],
        testResults: state.implementationResult?.testResults,
    };
}
export function taskStateToContext(state, role) {
    const contextMap = {
        architect: () => getArchitectContext(state),
        implementer: () => getImplementerContext(state),
        reviewer: () => getReviewerContext(state),
        security_auditor: () => getSecurityAuditContext(state),
        test_strategist: () => getTestStrategyContext(state),
    };
    const fn = contextMap[role] ?? (() => ({ task: state.originalTask }));
    return JSON.stringify(fn(), null, 2);
}
//# sourceMappingURL=taskState.js.map