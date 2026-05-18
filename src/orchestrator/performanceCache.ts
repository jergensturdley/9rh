import { createHash } from "crypto";
import type { ArchitectPlan, TestStrategyResult } from "./taskState.js";

const CACHE_TTL_MS = 30 * 60 * 1000;

export interface CacheEntry<T> {
  value: T;
  timestamp: number;
  hits: number;
}

export interface OrchestratorCache {
  architectPlans: Map<string, CacheEntry<ArchitectPlan>>;
  testStrategies: Map<string, CacheEntry<TestStrategyResult>>;
}

export function createOrchestratorCache(): OrchestratorCache {
  return { architectPlans: new Map(), testStrategies: new Map() };
}

function sha256slice(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function hashTask(task: string): string {
  return sha256slice(task.trim().toLowerCase());
}

export function hashTaskAndFiles(task: string, files: string[]): string {
  return sha256slice([task.trim().toLowerCase(), ...files.sort()].join("|"));
}

function isExpired(entry: CacheEntry<unknown>): boolean {
  return Date.now() - entry.timestamp > CACHE_TTL_MS;
}

export function getCachedPlan(cache: OrchestratorCache, key: string): ArchitectPlan | null {
  const entry = cache.architectPlans.get(key);
  if (!entry || isExpired(entry)) {
    cache.architectPlans.delete(key);
    return null;
  }
  entry.hits++;
  return entry.value;
}

export function cachePlan(cache: OrchestratorCache, key: string, plan: ArchitectPlan): void {
  cache.architectPlans.set(key, { value: plan, timestamp: Date.now(), hits: 0 });
}

export function getCachedTestStrategy(
  cache: OrchestratorCache,
  key: string
): TestStrategyResult | null {
  const entry = cache.testStrategies.get(key);
  if (!entry || isExpired(entry)) {
    cache.testStrategies.delete(key);
    return null;
  }
  entry.hits++;
  return entry.value;
}

export function cacheTestStrategy(
  cache: OrchestratorCache,
  key: string,
  result: TestStrategyResult
): void {
  cache.testStrategies.set(key, { value: result, timestamp: Date.now(), hits: 0 });
}

export function getCacheStats(cache: OrchestratorCache): {
  planCacheSize: number;
  testStrategyCacheSize: number;
  totalHits: number;
} {
  let totalHits = 0;
  for (const e of cache.architectPlans.values()) totalHits += e.hits;
  for (const e of cache.testStrategies.values()) totalHits += e.hits;
  return {
    planCacheSize: cache.architectPlans.size,
    testStrategyCacheSize: cache.testStrategies.size,
    totalHits,
  };
}

export function clearExpiredCache(cache: OrchestratorCache): void {
  for (const [k, v] of cache.architectPlans.entries()) {
    if (isExpired(v)) cache.architectPlans.delete(k);
  }
  for (const [k, v] of cache.testStrategies.entries()) {
    if (isExpired(v)) cache.testStrategies.delete(k);
  }
}
