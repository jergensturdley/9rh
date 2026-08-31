import { describe, it, expect } from "@jest/globals";
import { modelProvider, groupModelsByProvider, diffModelCatalog, type ModelInfo } from "../commands.js";
import { computeColumnLayout, renderColumnPickerLines, type PickColumn } from "../tui.js";

describe("modelProvider", () => {
  it("prefers owned_by, falls back to id prefix, then 'other'", () => {
    expect(modelProvider({ id: "gpt-4o", owned_by: "openai" })).toBe("openai");
    expect(modelProvider({ id: "kr/claude-sonnet-4.5" })).toBe("kr");
    expect(modelProvider({ id: "llama3" })).toBe("other");
    expect(modelProvider({ id: "gpt-4o", owned_by: "  " })).toBe("other");
  });
});

describe("groupModelsByProvider", () => {
  it("groups in first-seen provider order, keeps model order within", () => {
    const models: ModelInfo[] = [
      { id: "kr/a", owned_by: "kr" },
      { id: "gpt-1", owned_by: "openai" },
      { id: "kr/b", owned_by: "kr" },
      { id: "llama3" },
    ];
    const groups = groupModelsByProvider(models);
    expect(groups.map((g) => g.provider)).toEqual(["kr", "openai", "other"]);
    expect(groups[0].models.map((m) => m.id)).toEqual(["kr/a", "kr/b"]);
  });
});

describe("diffModelCatalog", () => {
  it("reports added and removed ids, order-insensitive", () => {
    const { added, removed } = diffModelCatalog(["a", "b", "c"], ["c", "b", "d", "e"]);
    expect(added).toEqual(["d", "e"]);
    expect(removed).toEqual(["a"]);
  });

  it("empty diff on identical catalogs", () => {
    const { added, removed } = diffModelCatalog(["a", "b"], ["b", "a"]);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });
});

describe("computeColumnLayout", () => {
  it("fits as many columns as width allows, capped at column count", () => {
    expect(computeColumnLayout(3, 120).visibleCols).toBe(3);
    expect(computeColumnLayout(2, 120).visibleCols).toBe(2);
    expect(computeColumnLayout(6, 70).visibleCols).toBe(3);
  });

  it("never returns fewer than one column and respects width bounds", () => {
    const tight = computeColumnLayout(4, 40);
    expect(tight.visibleCols).toBeGreaterThanOrEqual(1);
    expect(tight.colWidth).toBeGreaterThanOrEqual(20);
    const wide = computeColumnLayout(2, 300);
    expect(wide.colWidth).toBeLessThanOrEqual(34);
  });
});

describe("renderColumnPickerLines", () => {
  const columns: PickColumn[] = [
    {
      title: "kr (2)",
      items: [
        { id: "kr/a", label: "a", active: true },
        { id: "kr/b", label: "b" },
      ],
    },
    {
      title: "openai (3)",
      items: [
        { id: "gpt-1", label: "gpt-1" },
        { id: "gpt-2", label: "gpt-2" },
        { id: "gpt-3", label: "gpt-3" },
      ],
    },
  ];
  const layout = { colWidth: 20, visibleCols: 2 };

  it("renders provider headers side by side with the focus marker in the active column", () => {
    const lines = renderColumnPickerLines(columns, 1, [0, 1], 6, layout, false);
    expect(lines[0]).toContain("kr (2)");
    expect(lines[0]).toContain("openai (3)");
    // Active model marked in its column, focused model marked in the active one.
    const grid = lines.join("\n");
    expect(grid).toContain("▶ a");
    expect(grid).toContain("› gpt-2");
    expect(grid).not.toContain("› gpt-1");
  });

  it("shows vertical overflow counts per column", () => {
    const tall: PickColumn[] = [
      { title: "p (10)", items: Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, label: `m${i}` })) },
    ];
    const lines = renderColumnPickerLines(tall, 0, [9], 4, { colWidth: 20, visibleCols: 1 }, false);
    const overflow = lines[lines.length - 1];
    expect(overflow).toMatch(/\d+↑ \d+↓/);
  });

  it("shows horizontal overflow when providers exceed visible columns", () => {
    const many: PickColumn[] = Array.from({ length: 5 }, (_, i) => ({
      title: `p${i}`,
      items: [{ id: `p${i}/m`, label: "m" }],
    }));
    const lines = renderColumnPickerLines(many, 0, [0, 0, 0, 0, 0], 6, { colWidth: 20, visibleCols: 2 }, false);
    expect(lines[lines.length - 1]).toContain("more provider");
  });
});
