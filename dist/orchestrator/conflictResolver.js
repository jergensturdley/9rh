export function createConflictLog() {
    return { conflicts: [] };
}
export function resolveConflict(conflict, revisionCount, maxRevisions) {
    const [partyA, partyB] = conflict.parties;
    if (partyA === "security_auditor" || partyB === "security_auditor") {
        if (conflict.severity === "blocking") {
            return {
                resolution: "escalate_human",
                justification: "Security Auditor blocking rejection requires human approval to override. No agent may override a security rejection.",
            };
        }
        return {
            resolution: "escalate_coordinator",
            justification: "Security Auditor flagged a non-blocking issue. Coordinator must decide whether to proceed with conditions.",
        };
    }
    if ((partyA === "reviewer" && partyB === "implementer") ||
        (partyA === "implementer" && partyB === "reviewer")) {
        if (revisionCount < maxRevisions) {
            return {
                resolution: "implementer_revises",
                justification: `Reviewer identified issues (revision ${revisionCount + 1}/${maxRevisions}). Implementer must address all required changes with explicit justification for any disagreements.`,
            };
        }
        return {
            resolution: "escalate_human",
            justification: `Maximum revisions (${maxRevisions}) reached without resolution between Reviewer and Implementer. Human decision required.`,
        };
    }
    if (partyA === "test_strategist" || partyB === "test_strategist") {
        return {
            resolution: "escalate_coordinator",
            justification: "Test Strategist and Implementer disagree on coverage. Coordinator must determine acceptable coverage threshold.",
        };
    }
    return {
        resolution: "escalate_human",
        justification: `Unresolvable conflict between ${partyA} and ${partyB}. Escalating to human for decision.`,
    };
}
export function recordConflict(log, conflict) {
    const entry = {
        ...conflict,
        id: `conflict_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
    };
    log.conflicts.push(entry);
    return entry;
}
export function canOverride(overridingRole, overriddenRole, justification) {
    if (overriddenRole === "security_auditor") {
        return {
            allowed: false,
            reason: "Security Auditor cannot be overridden by agents. Human approval required.",
        };
    }
    if (overriddenRole === "architect" && overridingRole === "reviewer") {
        if (!justification || justification.length < 20) {
            return {
                allowed: false,
                reason: "Reviewer must provide explicit justification (min 20 chars) to override Architect plan.",
            };
        }
        return { allowed: true, reason: "Reviewer override of Architect plan accepted with justification." };
    }
    if (!justification || justification.length < 20) {
        return {
            allowed: false,
            reason: `Override of ${overriddenRole} by ${overridingRole} requires explicit justification (min 20 chars).`,
        };
    }
    return {
        allowed: true,
        reason: `Override of ${overriddenRole} by ${overridingRole} accepted with justification.`,
    };
}
//# sourceMappingURL=conflictResolver.js.map