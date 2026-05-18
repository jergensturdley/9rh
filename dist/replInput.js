const DEFAULT_OPTIONS = {
    normalDelayMs: 45,
    pasteDelayMs: 250,
    largePasteDelayMs: 1_000,
    pasteLineThreshold: 2,
    pasteCharThreshold: 1_000,
    largeLineThreshold: 20,
    largeCharThreshold: 4_000,
};
/**
 * Coalesces readline `line` events into one submitted prompt.
 *
 * Readline emits one event per newline, including for terminal paste. Large pastes
 * can be split across OS/TTY chunks, so a tiny fixed debounce may submit only the
 * first slice. This class grows the idle window as soon as the pending input
 * resembles a paste or large payload, while keeping normal Enter submissions fast.
 */
export class ReplInputCoalescer {
    options;
    onSubmit;
    setTimer;
    clearTimer;
    timer = null;
    pendingLines = [];
    pendingChars = 0;
    constructor(callbacks, options = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
        this.onSubmit = callbacks.onSubmit;
        this.setTimer = callbacks.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
        this.clearTimer = callbacks.clearTimer ?? ((timer) => clearTimeout(timer));
    }
    pushLine(line) {
        this.pendingLines.push(line);
        this.pendingChars += line.length + (this.pendingLines.length > 1 ? 1 : 0);
        this.reschedule();
    }
    flush() {
        if (this.timer !== null) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
        if (this.pendingLines.length === 0)
            return;
        const input = this.pendingLines.join("\n");
        this.pendingLines = [];
        this.pendingChars = 0;
        this.onSubmit(input);
    }
    hasPending() {
        return this.pendingLines.length > 0;
    }
    currentDelayMs() {
        const lineCount = this.pendingLines.length;
        const charCount = this.pendingChars;
        if (lineCount >= this.options.largeLineThreshold || charCount >= this.options.largeCharThreshold) {
            return this.options.largePasteDelayMs;
        }
        if (lineCount >= this.options.pasteLineThreshold || charCount >= this.options.pasteCharThreshold) {
            return this.options.pasteDelayMs;
        }
        return this.options.normalDelayMs;
    }
    reschedule() {
        if (this.timer !== null)
            this.clearTimer(this.timer);
        this.timer = this.setTimer(() => this.flush(), this.currentDelayMs());
    }
}
//# sourceMappingURL=replInput.js.map