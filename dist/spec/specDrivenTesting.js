const IMPLEMENTATION_VERBS = [
    "add",
    "allow",
    "build",
    "change",
    "create",
    "fix",
    "implement",
    "prevent",
    "refactor",
    "reject",
    "remove",
    "support",
    "update",
    "validate",
];
const QUESTION_PREFIXES = ["explain", "how ", "what ", "why ", "summarize", "describe", "list "];
function splitStatements(text) {
    return text
        .split(/\n+|(?<=[.!?])\s+/u)
        .map((line) => line.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean);
}
function startsWithAny(text, values) {
    const lower = text.toLowerCase();
    return values.some((value) => lower.startsWith(value));
}
function containsAny(text, values) {
    const lower = text.toLowerCase();
    return values.some((value) => lower.includes(value));
}
function classifyStatement(text) {
    const lower = text.toLowerCase();
    if (/\b(bug|crashes?|regression|broken)\b/u.test(lower) || /\b(currently\s+fails?|fails?\s+when)\b/u.test(lower))
        return "bug";
    if (/^(edge case|edge-case|when|if)\b/u.test(lower))
        return "edge";
    if (/^(do not|don't|must not|should not|non-goal|out of scope)\b/u.test(lower)) {
        return lower.includes("change") || lower.includes("must not") || lower.includes("do not") || lower.includes("don't")
            ? "constraint"
            : "non-goal";
    }
    if (/\b(must|only|never|always|without|preserve|constraint)\b/u.test(lower))
        return "constraint";
    if (/\b(unclear|maybe|if possible|somehow|better|improve|fast|nice|good)\b/u.test(lower))
        return "ambiguous";
    if (startsWithAny(lower, IMPLEMENTATION_VERBS))
        return "functional";
    return "functional";
}
function isFailurePathRequirement(text) {
    return /^(reject|prevent|block|deny|disallow|fail|validate\s+missing|validate\s+invalid)\b/u.test(text.toLowerCase());
}
function makeRequirement(index, kind, text) {
    return {
        id: `R${index + 1}`,
        kind,
        text,
        originalIndex: index,
    };
}
export function parseTaskSpecification(task) {
    const requirements = splitStatements(task).map((statement, index) => makeRequirement(index, classifyStatement(statement), statement));
    return {
        original: task,
        functionalBehavior: requirements.filter((item) => item.kind === "functional"),
        edgeCases: requirements.filter((item) => item.kind === "edge"),
        constraints: requirements.filter((item) => item.kind === "constraint"),
        nonGoals: requirements.filter((item) => item.kind === "non-goal"),
        bugReports: requirements.filter((item) => item.kind === "bug"),
        ambiguities: requirements.filter((item) => item.kind === "ambiguous"),
    };
}
function testTitle(prefix, text) {
    const normalized = text.replace(/\s+/g, " ").replace(/[.!?]$/u, "");
    return `${prefix}: ${normalized}`;
}
function addTest(tests, type, path, requirement, prefix, expectedInitialState = "unknown") {
    const duplicate = tests.some((test) => test.type === type && test.path === path && test.intent === requirement.text);
    if (duplicate)
        return;
    tests.push({
        id: `T${tests.length + 1}`,
        type,
        path,
        requirementIds: [requirement.id],
        title: testTitle(prefix, requirement.text),
        intent: requirement.text,
        expectedInitialState,
    });
}
export function synthesizeTestPlan(spec) {
    const tests = [];
    for (const requirement of spec.functionalBehavior) {
        if (isFailurePathRequirement(requirement.text)) {
            addTest(tests, "unit", "failure", requirement, "validation/failure path");
            continue;
        }
        addTest(tests, "unit", "happy", requirement, "unit happy path");
        if (containsAny(requirement.text, ["workflow", "end-to-end", "integration", "command", "cli", "repl", "agent"])) {
            addTest(tests, "integration", "happy", requirement, "integration happy path");
        }
    }
    for (const requirement of spec.edgeCases) {
        addTest(tests, "edge", "failure", requirement, "edge/failure path");
    }
    for (const requirement of spec.bugReports) {
        addTest(tests, "regression", "failure", requirement, "regression reproduction", "failing");
    }
    for (const requirement of spec.constraints) {
        addTest(tests, "unit", "failure", requirement, "constraint guard");
    }
    const allRequirements = [
        ...spec.functionalBehavior,
        ...spec.edgeCases,
        ...spec.constraints,
        ...spec.nonGoals,
        ...spec.bugReports,
        ...spec.ambiguities,
    ].sort((a, b) => a.originalIndex - b.originalIndex);
    const coverage = allRequirements.map((requirement) => {
        const testIds = tests
            .filter((test) => test.requirementIds.includes(requirement.id))
            .map((test) => test.id);
        const isGap = testIds.length === 0;
        return {
            requirementId: requirement.id,
            statement: requirement.text,
            testIds,
            status: isGap ? "gap" : "covered",
            note: isGap ? "No concrete test generated; requires human clarification or is a non-goal." : undefined,
        };
    });
    const gaps = coverage.filter((entry) => entry.status === "gap");
    const warnings = [];
    if (spec.ambiguities.length > 0) {
        warnings.push("Ambiguous requirements were detected and should be confirmed before broad implementation.");
    }
    if (tests.length > 0 && tests.every((test) => test.type === "unit")) {
        warnings.push("Generated tests are unit-only; add integration coverage if behavior crosses modules or CLI boundaries.");
    }
    if (tests.length === 0) {
        warnings.push("No executable tests were synthesized from the specification.");
    }
    const confidence = tests.length === 0
        ? "low"
        : spec.ambiguities.length === 0 && gaps.length === 0
            ? "high"
            : spec.ambiguities.length <= 1
                ? "medium"
                : "low";
    return {
        tests,
        assumptions: [
            "Generated tests should be presented or inspectable before major code changes.",
            "Regression tests for explicit bugs should fail before the fix is implemented.",
            "Relevant generated tests should be rerun after each meaningful implementation change.",
        ],
        coverage,
        gaps,
        warnings,
        canAutoProceed: confidence === "high",
        confidence,
    };
}
function renderList(items) {
    return items.length === 0 ? "- None" : items.map((item) => `- ${item}`).join("\n");
}
function renderRequirements(label, requirements) {
    return `### ${label}\n${renderList(requirements.map((requirement) => `${requirement.id}: ${requirement.text}`))}`;
}
export function formatSpecDrivenPrompt(task) {
    const spec = parseTaskSpecification(task);
    const plan = synthesizeTestPlan(spec);
    const testSummary = plan.tests.map((test) => {
        const initial = test.expectedInitialState === "failing" ? "; expected initial failing baseline" : "";
        return `- ${test.id} [${test.type}/${test.path}] ${test.title} (covers ${test.requirementIds.join(", ")}${initial})`;
    });
    const coverageSummary = plan.coverage.map((entry) => {
        const tests = entry.testIds.length > 0 ? entry.testIds.join(", ") : "GAP";
        return `- ${entry.requirementId}: ${entry.status.toUpperCase()} via ${tests} — ${entry.statement}`;
    });
    return [
        "You are running in spec-driven testing mode. Treat test generation as a first-class artifact, not a side effect.",
        "",
        "## Original user request",
        spec.original,
        "",
        "## Structured specification",
        renderRequirements("Functional behavior", spec.functionalBehavior),
        renderRequirements("Edge cases", spec.edgeCases),
        renderRequirements("Constraints", spec.constraints),
        renderRequirements("Non-goals", spec.nonGoals),
        renderRequirements("Explicit bug reports", spec.bugReports),
        renderRequirements("Ambiguities requiring confirmation", spec.ambiguities),
        "",
        "## Generated test plan",
        renderList(testSummary),
        "",
        "## Assumptions",
        renderList(plan.assumptions),
        "",
        "## Specification coverage",
        renderList(coverageSummary),
        "",
        "## Warnings and gaps",
        renderList([...plan.warnings, ...plan.gaps.map((gap) => `${gap.requirementId}: ${gap.note ?? gap.statement}`)]),
        "",
        "## Approval flow",
        plan.canAutoProceed
            ? "Confidence is high and ambiguity is low; proceed automatically after making the tests reviewable."
            : "Pause before broad implementation if any ambiguity materially affects behavior; otherwise make the narrow tests reviewable and proceed only on unambiguous requirements.",
        "",
        "## Tight implementation loop",
        "1. Create or update concrete tests that correspond to the generated test plan before major implementation changes.",
        "2. Run the generated or updated tests first and capture the failing baseline; explicit bug reports must have at least one reproducible failing regression test.",
        "3. Feed those failures back into the implementation as the target behavior.",
        "4. Re-run the relevant test subset after each meaningful code change.",
        "5. Track which specification statements are covered and which remain gaps.",
        "6. Warn if tests only validate superficial behavior.",
        "7. Prune duplicate or low-value tests before final validation.",
    ].join("\n");
}
export function shouldUseSpecDrivenTesting(task) {
    const lower = task.trim().toLowerCase();
    if (lower.length === 0)
        return false;
    if (startsWithAny(lower, QUESTION_PREFIXES))
        return false;
    return startsWithAny(lower, IMPLEMENTATION_VERBS) || /\b(bug|broken|crash|failing|implement|tests?)\b/u.test(lower);
}
//# sourceMappingURL=specDrivenTesting.js.map