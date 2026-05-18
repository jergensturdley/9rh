import { ReplInputCoalescer } from "../replInput.js";
describe("ReplInputCoalescer", () => {
    function makeHarness() {
        const submissions = [];
        const timers = new Map();
        let nextTimer = 1;
        const coalescer = new ReplInputCoalescer({
            onSubmit: (input) => submissions.push(input),
            setTimer: (callback, delay) => {
                const id = nextTimer++;
                timers.set(id, { callback, delay });
                return id;
            },
            clearTimer: (timer) => {
                timers.delete(timer);
            },
        });
        const fireLatest = () => {
            const latest = Math.max(...timers.keys());
            const timer = timers.get(latest);
            if (!timer)
                throw new Error("no pending timer");
            timers.delete(latest);
            timer.callback();
        };
        const latestDelay = () => {
            const latest = Math.max(...timers.keys());
            const timer = timers.get(latest);
            if (!timer)
                throw new Error("no pending timer");
            return timer.delay;
        };
        return { coalescer, submissions, fireLatest, latestDelay };
    }
    it("submits a single normal line quickly", () => {
        const h = makeHarness();
        h.coalescer.pushLine("hello");
        expect(h.latestDelay()).toBe(45);
        h.fireLatest();
        expect(h.submissions).toEqual(["hello"]);
    });
    it("coalesces multiline paste into one submission", () => {
        const h = makeHarness();
        h.coalescer.pushLine("first");
        h.coalescer.pushLine("second");
        h.coalescer.pushLine("third");
        expect(h.latestDelay()).toBe(250);
        h.fireLatest();
        expect(h.submissions).toEqual(["first\nsecond\nthird"]);
    });
    it("uses a longer idle window for large payloads", () => {
        const h = makeHarness();
        for (let i = 0; i < 25; i += 1)
            h.coalescer.pushLine(`line ${i}`);
        expect(h.latestDelay()).toBe(1_000);
        h.fireLatest();
        expect(h.submissions).toHaveLength(1);
        expect(h.submissions[0].split("\n")).toHaveLength(25);
    });
    it("flushes pending input on close without waiting for timer", () => {
        const h = makeHarness();
        h.coalescer.pushLine("pending");
        h.coalescer.flush();
        expect(h.submissions).toEqual(["pending"]);
        h.coalescer.flush();
        expect(h.submissions).toEqual(["pending"]);
    });
});
//# sourceMappingURL=replInput.test.js.map