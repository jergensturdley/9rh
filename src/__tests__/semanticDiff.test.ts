import { describe, expect, it } from "@jest/globals";
import { createSemanticReview, filterSemanticChanges, formatSemanticReview } from "../semanticDiff.js";

describe("semantic diff review", () => {
  it("describes removed login validation/auth checks as high-risk semantic changes", () => {
    const before = `
      export function login(user: User | null, password: string) {
        if (!user) throw new Error("missing user");
        authorize(user, "login");
        return createSession(user.id, password);
      }
    `;
    const after = `
      export function login(user: User | null, password: string) {
        return createSession(user!.id, password);
      }
    `;

    const review = createSemanticReview("Fix login flow null checks in src/auth.ts", [{ path: "src/auth.ts", before, after }]);

    expect(review.semanticSummary.some((c) => c.behavior === "validation" && c.summary.includes("removed"))).toBe(true);
    expect(review.semanticSummary.some((c) => c.behavior === "security" && c.severity === "critical")).toBe(true);
    expect(review.intentRisk.riskLevel === "high" || review.intentRisk.riskLevel === "critical").toBe(true);
    expect(review.intentRisk.downstreamEffects.join("\n")).toContain("accepted/rejected differently");
  });

  it("detects changed function signatures and downstream caller impact", () => {
    const before = `export function loadUser(id: string): User { return db.user.find(id); }`;
    const after = `export function loadUser(id: string, includeDeleted = false): Promise<User> { return db.user.find(id, { includeDeleted }); }`;

    const review = createSemanticReview("Update database user loading behavior", [{ path: "src/users.ts", before, after }]);

    expect(review.semanticSummary.some((c) => c.behavior === "signature" && c.evidence.includes("loadUser"))).toBe(true);
    expect(review.semanticSummary.some((c) => c.behavior === "data_access")).toBe(true);
    expect(review.intentRisk.downstreamEffects.some((effect) => effect.includes("Callers"))).toBe(true);
  });

  it("flags scope creep when modules outside the requested scope change", () => {
    const review = createSemanticReview("Only update TUI spinner UX", [
      { path: "src/tui.ts", before: `export function spin(){ return 1; }`, after: `export function spin(){ return 2; }` },
      { path: "src/auth.ts", before: `export function canEdit(){ return authorize(); }`, after: `export function canEdit(){ return true; }` },
    ]);

    expect(review.intentRisk.matchesIntent).toBe(false);
    expect(review.intentRisk.scopeJustificationsRequired).toContain("src/auth.ts");
    expect(review.intentRisk.mismatches.join("\n")).toContain("outside the explicit task/module hints");
  });

  it("does not misclassify formatting-only changes as logic changes", () => {
    const before = `export function add(a:number,b:number){return a+b;}`;
    const after = `// Adds two numbers\nexport function add(a: number, b: number) {\n  return a + b;\n}`;

    const review = createSemanticReview("Format src/math.ts", [{ path: "src/math.ts", before, after }]);

    expect(review.semanticSummary).toHaveLength(1);
    expect(review.semanticSummary[0].behavior).toBe("formatting");
    expect(review.semanticSummary[0].severity).toBe("info");
    expect(review.intentRisk.riskLevel).toBe("low");
  });

  it("renders reviewer interface layers and supports severity/module/behavior filtering", () => {
    const review = createSemanticReview("Review auth and db changes", [{
      path: "src/auth.ts",
      before: `export function check(user){ if (!user) throw new Error("no"); return db.roles.select(user.id); }`,
      after: `export function check(user){ return db.roles.delete(user.id); }`,
    }]);

    const filtered = filterSemanticChanges(review.semanticSummary, { severity: "high", module: "auth", behavior: "data_access" });
    const rendered = formatSemanticReview(review, { severity: "medium" });

    expect(filtered.some((c) => c.behavior === "data_access")).toBe(true);
    expect(rendered).toContain("## Plain diff");
    expect(rendered).toContain("## Semantic summary");
    expect(rendered).toContain("## Intent/risk assessment");
    expect(rendered).toContain("src/auth.ts");
  });
});
