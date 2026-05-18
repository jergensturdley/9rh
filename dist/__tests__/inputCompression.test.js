import { compressUserInput } from "../inputCompression.js";
describe("compressUserInput", () => {
    it("condenses traceback-style box drawing output instead of preserving the full wall", () => {
        const frame = `  ✓  ╭${"─".repeat(120)} Traceback (most recent call last) ${"─".repeat(120)}╮\n` +
            Array.from({ length: 18 }, (_, i) => `│ /Volumes/M.2 2TB/code/todo/todo_app.py:${200 + i} in function_${i} ${" ".repeat(120)}│\n` +
                `│   ${String(200 + i).padStart(3)} │   │   self.mount(label) ${" ".repeat(150)}│\n` +
                `│ ╭${"─".repeat(80)} locals ${"─".repeat(80)}╮ ${" ".repeat(40)}│\n` +
                `│ │ self = TodoApp(title='TodoApp', classes={'-dark-mode'}, pseudo_classes={'focus', 'dark'}) │ ${" ".repeat(55)}│\n` +
                `│ ╰${"─".repeat(170)}╯\n`).join("") +
            `╰${"─".repeat(260)}╯\nMountError: Can't mount widget(s) before TodoItem() is mounted`;
        const result = compressUserInput(frame);
        expect(result.changed).toBe(true);
        expect(result.text).toContain("Terminal traceback/box output condensed");
        expect(result.text).toContain("MountError: Can't mount widget(s) before TodoItem() is mounted");
        expect(result.text.length).toBeLessThan(1800);
        expect(result.text.length).toBeLessThan(frame.length / 5);
    });
});
//# sourceMappingURL=inputCompression.test.js.map