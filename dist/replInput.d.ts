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
/**
 * Coalesces readline `line` events into one submitted prompt.
 *
 * Readline emits one event per newline, including for terminal paste. Large pastes
 * can be split across OS/TTY chunks, so a tiny fixed debounce may submit only the
 * first slice. This class grows the idle window as soon as the pending input
 * resembles a paste or large payload, while keeping normal Enter submissions fast.
 */
export declare class ReplInputCoalescer {
    private readonly options;
    private readonly onSubmit;
    private readonly setTimer;
    private readonly clearTimer;
    private timer;
    private pendingLines;
    private pendingChars;
    constructor(callbacks: ReplInputCoalescerCallbacks, options?: ReplInputCoalescerOptions);
    pushLine(line: string): void;
    flush(): void;
    hasPending(): boolean;
    currentDelayMs(): number;
    private reschedule;
}
