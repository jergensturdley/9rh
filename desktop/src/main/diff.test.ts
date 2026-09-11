import { describe, expect, it } from "vitest";
import { computeLineDiff } from "./diff";

// Expected added/removed values follow the engine's countLineChanges
// (ledger.ts): split on "\n", LCS over lines, added = after - lcs,
// removed = before - lcs. A trailing newline yields an empty last line on
// both sides, so "a\nb\n" is three lines.

describe("computeLineDiff", () => {
  it("create: every line is an add", () => {
    const d = computeLineDiff(undefined, "x\ny\n");
    expect(d.added).toBe(3);
    expect(d.removed).toBe(0);
    expect(d.lines).toEqual([
      { kind: "add", text: "x", newLine: 1 },
      { kind: "add", text: "y", newLine: 2 },
      { kind: "add", text: "", newLine: 3 },
    ]);
  });

  it("identical: all context, zero counts", () => {
    const d = computeLineDiff("a\nb\n", "a\nb\n");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.lines.every((l) => l.kind === "context")).toBe(true);
    expect(d.lines.map((l) => [l.oldLine, l.newLine])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("single-line edit: one remove and one add", () => {
    const d = computeLineDiff("a\nb\nc\n", "a\nB\nc\n");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.lines).toEqual([
      { kind: "context", text: "a", oldLine: 1, newLine: 1 },
      { kind: "remove", text: "b", oldLine: 2 },
      { kind: "add", text: "B", newLine: 2 },
      { kind: "context", text: "c", oldLine: 3, newLine: 3 },
      { kind: "context", text: "", oldLine: 4, newLine: 4 },
    ]);
  });

  it("insert in the middle", () => {
    const d = computeLineDiff("a\nc\n", "a\nb\nc\n");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
    expect(d.lines.filter((l) => l.kind === "add")).toEqual([{ kind: "add", text: "b", newLine: 2 }]);
    expect(d.lines.map((l) => l.kind)).toEqual(["context", "add", "context", "context"]);
  });

  it("delete at the end (trailing newline dropped too)", () => {
    const d = computeLineDiff("a\nb\nc\n", "a\nb");
    // before: [a, b, c, ""], after: [a, b]; lcs 2.
    expect(d.added).toBe(0);
    expect(d.removed).toBe(2);
    expect(d.lines.map((l) => l.kind)).toEqual(["context", "context", "remove", "remove"]);
    expect(d.lines[2]).toEqual({ kind: "remove", text: "c", oldLine: 3 });
  });

  it("counts follow the LCS, not the gross delta", () => {
    // Same length, every line rewritten: 3 added and 3 removed.
    const d = computeLineDiff("a\nb\nc", "x\ny\nz");
    expect(d.added).toBe(3);
    expect(d.removed).toBe(3);
  });

  it("falls back to whole-file replace above 4000 lines", () => {
    const big = Array.from({ length: 4001 }, (_, i) => `l${i}`).join("\n");
    const d = computeLineDiff(big, big + "\nextra");
    expect(d.lines[0]).toEqual({ kind: "context", text: "(diff too large; showing whole-file replace)" });
    expect(d.removed).toBe(4001);
    expect(d.added).toBe(4002);
    expect(d.lines).toHaveLength(1 + 4001 + 4002);
  });
});
