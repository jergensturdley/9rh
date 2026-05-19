import ts from "typescript";
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const CONTROL_RE = /\b(if|else|switch|case|for|while|catch|throw|return|await)\b/u;
const SIDE_EFFECT_RE = /\b(writeFile|appendFile|unlink|rm|mkdir|exec|spawn|fetch|axios|client\.|\.save\(|\.delete\(|\.update\(|\.insert\(|\.write\(|process\.env|console\.)/u;
const VALIDATION_RE = /\b(validate|sanitize|authorize|auth|permission|guard|check|assert|schema|zod|joi|required|null|undefined)\b/iu;
const DATA_RE = /\b(select|find|insert|update|delete|query|db\.|database|prisma|sequelize|repository|sql)\b|\.delete\(|\.update\(|\.insert\(|\.find\(|\.select\(/iu;
const SECURITY_RE = /\b(auth|token|secret|password|permission|role|cors|csrf|crypto|encrypt|decrypt|sandbox|path traversal|admin)\b/iu;
function normalizeCode(code) {
    return code.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "").replace(/\s+/gu, "").trim();
}
function lineOf(source, node) {
    return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}
function functionName(node) {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) {
        return node.name?.getText() ?? null;
    }
    if (ts.isArrowFunction(node)) {
        const parent = node.parent;
        if (ts.isVariableDeclaration(parent) && parent.name)
            return parent.name.getText();
        if (ts.isPropertyAssignment(parent))
            return parent.name.getText();
    }
    return null;
}
function collectFunctions(path, code) {
    const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const functions = new Map();
    const visit = (node) => {
        const name = functionName(node);
        if (name) {
            const text = node.getText(source);
            const bodyNode = "body" in node ? node.body : undefined;
            const body = bodyNode?.getText(source) ?? text;
            const params = "parameters" in node ? node.parameters.map((p) => p.getText(source)).join(", ") : "";
            const returnType = "type" in node && node.type ? `: ${node.type?.getText(source)}` : "";
            functions.set(name, {
                name,
                signature: `${name}(${params})${returnType}`,
                body: normalizeCode(body),
                line: lineOf(source, node),
                hasControlFlow: CONTROL_RE.test(body),
                hasSideEffects: SIDE_EFFECT_RE.test(body),
                hasValidation: VALIDATION_RE.test(body),
                hasDataAccess: DATA_RE.test(body),
                hasSecurity: SECURITY_RE.test(body),
            });
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return functions;
}
function changedLine(after, needle) {
    const lines = after.split(/\r?\n/u);
    const idx = lines.findIndex((line) => line.includes(needle));
    return idx >= 0 ? idx + 1 : undefined;
}
function addChange(changes, change) {
    changes.push({ id: `sem-${changes.length + 1}`, ...change });
}
function analyzeFile(snapshot) {
    const changes = [];
    if (normalizeCode(snapshot.before) === normalizeCode(snapshot.after)) {
        addChange(changes, {
            file: snapshot.path,
            severity: "info",
            behavior: "formatting",
            summary: "Formatting/comment-only change; no semantic code change detected.",
            evidence: snapshot.path,
        });
        return changes;
    }
    const before = collectFunctions(snapshot.path, snapshot.before);
    const after = collectFunctions(snapshot.path, snapshot.after);
    const allNames = new Set([...before.keys(), ...after.keys()]);
    for (const name of allNames) {
        const b = before.get(name);
        const a = after.get(name);
        if (!b && a) {
            addChange(changes, { file: snapshot.path, line: a.line, severity: a.hasSecurity ? "high" : "low", behavior: "signature", summary: `New function ${a.signature} added.`, evidence: a.signature });
            continue;
        }
        if (b && !a) {
            addChange(changes, { file: snapshot.path, line: b.line, severity: b.hasSecurity ? "high" : "medium", behavior: "signature", summary: `Function ${b.name} removed.`, evidence: b.signature });
            continue;
        }
        if (!a || !b)
            continue;
        if (a.signature !== b.signature) {
            addChange(changes, { file: snapshot.path, line: a.line, severity: "medium", behavior: "signature", summary: `Function signature changed for ${name}.`, evidence: `${b.signature} -> ${a.signature}` });
        }
        if (a.body !== b.body) {
            if (a.hasControlFlow !== b.hasControlFlow || /\b(if|throw|return)\b/u.test(a.body + b.body)) {
                addChange(changes, { file: snapshot.path, line: a.line, severity: "medium", behavior: "control_flow", summary: `Control flow changed inside ${name}.`, evidence: name });
            }
            if (a.hasSideEffects && !b.hasSideEffects) {
                addChange(changes, { file: snapshot.path, line: a.line, severity: "medium", behavior: "side_effect", summary: `New side effect introduced inside ${name}.`, evidence: name });
            }
            if (!a.hasValidation && b.hasValidation) {
                addChange(changes, { file: snapshot.path, line: a.line, severity: "high", behavior: "validation", summary: `Validation or guard logic appears removed from ${name}.`, evidence: name });
            }
            else if (a.hasValidation !== b.hasValidation) {
                addChange(changes, { file: snapshot.path, line: a.line, severity: "medium", behavior: "validation", summary: `Validation behavior changed inside ${name}.`, evidence: name });
            }
            if (a.hasDataAccess !== b.hasDataAccess || (a.hasDataAccess && b.hasDataAccess)) {
                addChange(changes, { file: snapshot.path, line: a.line, severity: "high", behavior: "data_access", summary: `Database/data access behavior changed inside ${name}.`, evidence: name });
            }
            if (a.hasSecurity !== b.hasSecurity) {
                addChange(changes, { file: snapshot.path, line: a.line, severity: "high", behavior: "security", summary: `Security-sensitive behavior changed inside ${name}.`, evidence: name });
            }
        }
    }
    const removedAuth = /[-].*\b(auth|authorize|permission|role|token)\b/iu.test(unifiedDiffForFile(snapshot));
    if (removedAuth) {
        addChange(changes, { file: snapshot.path, line: changedLine(snapshot.after, "auth"), severity: "critical", behavior: "security", summary: "Security/auth-related line was removed or relaxed.", evidence: "removed auth/permission/token line" });
    }
    return changes;
}
function unifiedDiffForFile(snapshot) {
    const beforeLines = snapshot.before.split(/\r?\n/u);
    const afterLines = snapshot.after.split(/\r?\n/u);
    const out = [`--- a/${snapshot.path}`, `+++ b/${snapshot.path}`];
    const max = Math.max(beforeLines.length, afterLines.length);
    for (let i = 0; i < max; i++) {
        if (beforeLines[i] === afterLines[i])
            continue;
        if (beforeLines[i] !== undefined)
            out.push(`-${beforeLines[i]}`);
        if (afterLines[i] !== undefined)
            out.push(`+${afterLines[i]}`);
    }
    return out.join("\n");
}
export function createPlainDiff(files) {
    return files.map(unifiedDiffForFile).join("\n");
}
function assessIntent(task, files, changes) {
    const taskLower = task.toLowerCase();
    const modified = files.map((f) => f.path);
    const scopeHints = Array.from(task.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|json|md)|\b(?:auth|login|database|db|tui|replay|sandbox|test|memory|diff|review)\b/giu), (m) => m[0].toLowerCase());
    const scopeJustificationsRequired = modified.filter((file) => scopeHints.length > 0 && !scopeHints.some((hint) => file.toLowerCase().includes(hint.replace(/\..*$/u, ""))));
    const nonFormatting = changes.filter((c) => c.behavior !== "formatting");
    const mismatches = [];
    if (/format|typo|comment|docs?/iu.test(task) && nonFormatting.length > 0)
        mismatches.push("Task appears formatting/docs-only but implementation changed executable behavior.");
    if (/auth|login|permission|security/iu.test(task) && !changes.some((c) => c.behavior === "security" || c.file.toLowerCase().includes("auth")))
        mismatches.push("Task mentions auth/security but no security-sensitive semantic change was detected.");
    if (/test/iu.test(task) && !modified.some((f) => /test|spec|__tests__/iu.test(f)))
        mismatches.push("Task requests tests but no test files were modified.");
    if (scopeJustificationsRequired.length > 0)
        mismatches.push("Implementation touches files outside the explicit task/module hints and needs justification.");
    const riskFactors = new Set();
    for (const change of changes) {
        if (change.severity === "critical" || change.severity === "high")
            riskFactors.add(change.summary);
        if (change.behavior === "data_access")
            riskFactors.add("Data access behavior changed.");
        if (change.behavior === "security")
            riskFactors.add("Security-sensitive behavior changed.");
        if (change.behavior === "validation")
            riskFactors.add("Validation behavior changed.");
    }
    const surfaceRisk = Math.min(20, modified.length * 4);
    const behaviorRisk = changes.reduce((sum, c) => sum + SEVERITY_RANK[c.severity] * 8, 0);
    const riskScore = Math.min(100, surfaceRisk + behaviorRisk + (scopeJustificationsRequired.length > 0 ? 10 : 0));
    const riskLevel = riskScore >= 80 ? "critical" : riskScore >= 55 ? "high" : riskScore >= 30 ? "medium" : riskScore > 0 ? "low" : "info";
    const downstreamEffects = changes.flatMap((change) => {
        if (change.behavior === "signature")
            return [`Callers of ${change.evidence} may need updates.`];
        if (change.behavior === "validation")
            return [`Inputs reaching ${change.file}:${change.line ?? "?"} may now be accepted/rejected differently.`];
        if (change.behavior === "data_access")
            return [`Persistence/query behavior may affect stored data or query load.`];
        if (change.behavior === "side_effect")
            return [`Runtime side effects may affect filesystem, network, logs, or external services.`];
        return [];
    });
    return {
        matchesIntent: mismatches.length === 0,
        mismatches,
        scopeJustificationsRequired,
        riskScore,
        riskLevel,
        riskFactors: Array.from(riskFactors),
        downstreamEffects: Array.from(new Set(downstreamEffects)),
    };
}
export function createSemanticReview(task, files) {
    const semanticSummary = files.flatMap(analyzeFile);
    return { plainDiff: createPlainDiff(files), semanticSummary, intentRisk: assessIntent(task, files, semanticSummary) };
}
export function filterSemanticChanges(changes, filter) {
    return changes.filter((change) => {
        if (filter.severity && SEVERITY_RANK[change.severity] < SEVERITY_RANK[filter.severity])
            return false;
        if (filter.module && !change.file.includes(filter.module))
            return false;
        if (filter.behavior && change.behavior !== filter.behavior)
            return false;
        return true;
    });
}
export function formatSemanticReview(review, filter = {}) {
    const changes = filterSemanticChanges(review.semanticSummary, filter);
    const semantic = changes.length
        ? changes.map((c) => `- [${c.severity}/${c.behavior}] ${c.summary} (${c.file}${c.line ? `:${c.line}` : ""}; evidence: ${c.evidence})`).join("\n")
        : "- No semantic changes matched the filter.";
    const risk = review.intentRisk;
    return [
        "## Plain diff",
        "```diff",
        review.plainDiff,
        "```",
        "## Semantic summary",
        semantic,
        "## Intent/risk assessment",
        `- Intent match: ${risk.matchesIntent ? "yes" : "no"}`,
        `- Risk: ${risk.riskLevel} (${risk.riskScore}/100)`,
        `- Mismatches: ${risk.mismatches.length ? risk.mismatches.join("; ") : "none"}`,
        `- Scope justification required: ${risk.scopeJustificationsRequired.length ? risk.scopeJustificationsRequired.join(", ") : "none"}`,
        `- Risk factors: ${risk.riskFactors.length ? risk.riskFactors.join("; ") : "none"}`,
        `- Likely downstream effects: ${risk.downstreamEffects.length ? risk.downstreamEffects.join("; ") : "none"}`,
    ].join("\n");
}
//# sourceMappingURL=semanticDiff.js.map