import { describe, it, expect } from "@jest/globals";
import { mapPool, AsyncLock } from "../parallel.js";
import { setTimeout as delay } from "timers/promises";

describe("mapPool", () => {
  it("returns results in input order even when fn resolves out of order", async () => {
    const items = [10, 20, 30];
    const result = await mapPool(items, 3, async (n) => {
      // Reverse the delays: first item finishes last.
      await delay(n === 10 ? 60 : n === 20 ? 30 : 5);
      return n * 2;
    });
    expect(result).toEqual([20, 40, 60]);
  });

  it("never runs more than `limit` fns at once", async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapPool(items, 4, async () => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      await delay(5);
      inFlight--;
    });
    expect(maxObserved).toBeLessThanOrEqual(4);
    expect(maxObserved).toBeGreaterThan(1); // actually ran concurrently
  });

  it("resolves an empty input to an empty array", async () => {
    const result = await mapPool([1, 2, 3], 8, async (n) => n);
    expect(result).toEqual([1, 2, 3]);
    await expect(mapPool([], 4, async () => 1)).resolves.toEqual([]);
  });

  it("runs strictly sequentially with limit 1", async () => {
    const events: string[] = [];
    const items = ["a", "b", "c"];
    await mapPool(items, 1, async (item) => {
      events.push(`start:${item}`);
      await delay(5);
      events.push(`end:${item}`);
    });
    expect(events).toEqual([
      "start:a", "end:a",
      "start:b", "end:b",
      "start:c", "end:c",
    ]);
  });

  it("propagates a rejected fn rejection", async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("AsyncLock", () => {
  it("serializes runs so intervals never overlap", async () => {
    const lock = new AsyncLock();
    const intervals: Array<[number, number]> = [];
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        lock.run(async () => {
          const start = Date.now();
          await delay(10);
          intervals[i] = [start, Date.now()];
        }),
      ),
    );
    // Every interval must end before the next one starts.
    intervals.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i][0]).toBeGreaterThanOrEqual(intervals[i - 1][1]);
    }
  });

  it("propagates the value and the error of the wrapped fn", async () => {
    const lock = new AsyncLock();
    await expect(lock.run(async () => 42)).resolves.toBe(42);
    await expect(lock.run(async () => {
      throw new Error("locked boom");
    })).rejects.toThrow("locked boom");
    // Lock is still usable after a failure.
    await expect(lock.run(async () => "ok")).resolves.toBe("ok");
  });

  it("runs the next queued fn after a failure does not stall the chain", async () => {
    const lock = new AsyncLock();
    const order: string[] = [];
    const failing = lock.run(async () => {
      order.push("failing");
      throw new Error("x");
    }).catch(() => "swallowed");
    const second = lock.run(async () => {
      order.push("second");
      return "done";
    });
    await Promise.all([failing, second]);
    expect(order).toEqual(["failing", "second"]);
  });
});
