export interface ReplInputCoalescerOptions {
  /** Delay for ordinary single-line input. Keeps interactive Enter responsive. */
  normalDelayMs?: number;
  /** Delay once input looks like a paste or a large payload. */
  pasteDelayMs?: number;
  /** Delay for very large payloads, where terminal/readline chunks may arrive slowly. */
  largePasteDelayMs?: number;
  pasteLineThreshold?: number;
  pasteCharThreshold?: number;
  largeLineThreshold?: number;
  largeCharThreshold?: number;
}

export interface ReplInputCoalescerCallbacks {
  onSubmit: (input: string) => void;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

const DEFAULT_OPTIONS: Required<ReplInputCoalescerOptions> = {
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
  private readonly options: Required<ReplInputCoalescerOptions>;
  private readonly onSubmit: (input: string) => void;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private timer: unknown = null;
  private pendingLines: string[] = [];
  private pendingChars = 0;

  constructor(callbacks: ReplInputCoalescerCallbacks, options: ReplInputCoalescerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.onSubmit = callbacks.onSubmit;
    this.setTimer = callbacks.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = callbacks.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  pushLine(line: string): void {
    this.pendingLines.push(line);
    this.pendingChars += line.length + (this.pendingLines.length > 1 ? 1 : 0);
    this.reschedule();
  }

  flush(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.pendingLines.length === 0) return;
    const input = this.pendingLines.join("\n");
    this.pendingLines = [];
    this.pendingChars = 0;
    this.onSubmit(input);
  }

  hasPending(): boolean {
    return this.pendingLines.length > 0;
  }

  currentDelayMs(): number {
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

  private reschedule(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.flush(), this.currentDelayMs());
  }
}
