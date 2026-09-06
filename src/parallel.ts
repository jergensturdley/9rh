/**
 * Zero-dependency concurrency primitives shared across the harness.
 *
 * mapPool: bounded-concurrency map that preserves input order.
 * AsyncLock: async mutex used to serialize mutating tool execution.
 */

/**
 * Maps `items` through `fn` with at most `limit` invocations in flight.
 * Results are returned in input order regardless of completion order.
 *
 * On the first rejection, no *new* items are dispatched; in-flight
 * invocations are awaited (so their side effects finish) and the first
 * error is then propagated.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = Math.max(1, Math.min(limit, items.length || 1));
  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: unknown;
  let failed = false;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      if (failed) return; // stop pulling new work after a failure
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}

/**
 * Async mutex. `run(fn)` executes `fn` only after every previously queued
 * run has settled. A failing fn does not stall the chain.
 */
export class AsyncLock {
  private chain: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
