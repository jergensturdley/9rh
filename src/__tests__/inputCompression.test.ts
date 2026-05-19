import { compressUserInput } from "../inputCompression.js";

describe("compressUserInput", () => {
  it("condenses traceback-style box drawing output instead of preserving the full wall", () => {
    const frame = `  ✓  ╭${"─".repeat(120)} Traceback (most recent call last) ${"─".repeat(120)}╮\n` +
      Array.from({ length: 18 }, (_, i) =>
        `│ /Volumes/M.2 2TB/code/todo/todo_app.py:${200 + i} in function_${i} ${" ".repeat(120)}│\n` +
        `│   ${String(200 + i).padStart(3)} │   │   self.mount(label) ${" ".repeat(150)}│\n` +
        `│ ╭${"─".repeat(80)} locals ${"─".repeat(80)}╮ ${" ".repeat(40)}│\n` +
        `│ │ self = TodoApp(title='TodoApp', classes={'-dark-mode'}, pseudo_classes={'focus', 'dark'}) │ ${" ".repeat(55)}│\n` +
        `│ ╰${"─".repeat(170)}╯\n`
      ).join("") +
      `╰${"─".repeat(260)}╯\nMountError: Can't mount widget(s) before TodoItem() is mounted`;

    const result = compressUserInput(frame);

    expect(result.changed).toBe(true);
    expect(result.text).toContain("Terminal traceback/box output condensed");
    expect(result.text).toContain("MountError: Can't mount widget(s) before TodoItem() is mounted");
    expect(result.text.length).toBeLessThan(1800);
    expect(result.text.length).toBeLessThan(frame.length / 5);
  });

  it("compresses large pasted logs while preserving actionable signals", () => {
    const log = [
      "Please debug this failing test run:",
      "$ npm test -- --runInBand",
      ...Array.from({ length: 60 }, (_, i) => `noise line ${i} lorem ipsum dolor sit amet ${"x".repeat(70)}`),
      "FAIL src/widget.test.ts",
      "Expected: 200",
      "Received: 500",
      "Error: database timeout at src/api.ts:42",
      ...Array.from({ length: 30 }, (_, i) => `more noise ${i} ${"y".repeat(90)}`),
      "Please fix the regression without changing public API.",
    ].join("\n");

    const result = compressUserInput(log, { textLineThreshold: 20, maxChars: 1800 });

    expect(result.changed).toBe(true);
    expect(result.text).toContain("User input compressed for token frugality");
    expect(result.text).toContain("FAIL src/widget.test.ts");
    expect(result.text).toContain("Expected: 200");
    expect(result.text).toContain("Received: 500");
    expect(result.text).toContain("Error: database timeout at src/api.ts:42");
    expect(result.text).toContain("Please fix the regression");
    expect(result.text.length).toBeLessThan(log.length / 2);
    expect(result.notices[0]).toContain("pasted large input compressed");
  });

  it("summarizes long code fences with head and tail context", () => {
    const code = [
      "Can you review this file?",
      "```ts",
      "export function first() { return 1; }",
      ...Array.from({ length: 35 }, (_, i) => `const value${i} = ${i};`),
      "export function last() { return 2; }",
      "```",
    ].join("\n");

    const result = compressUserInput(code, { textLineThreshold: 10, maxChars: 1400 });

    expect(result.changed).toBe(true);
    expect(result.text).toContain("[Code fences summarized]");
    expect(result.text).toContain("fence 1: ts");
    expect(result.text).toContain("export function first");
    expect(result.text).toContain("export function last");
    expect(result.text).toContain("code lines omitted");
  });
});
