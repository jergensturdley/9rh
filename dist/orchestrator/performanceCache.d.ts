import type { ArchitectPlan, TestStrategyResult } from "./taskState.js";
export interface CacheEntry<T> {
    value: T;
    timestamp: number;
    hits: number;
}
export interface OrchestratorCache {
    architectPlans: Map<string, CacheEntry<ArchitectPlan>>;
    testStrategies: Map<string, CacheEntry<TestStrategyResult>>;
}
export declare function createOrchestratorCache(): OrchestratorCache;
export declare function hashTask(task: string): string;
export declare function hashTaskAndFiles(task: string, files: string[]): string;
export declare function getCachedPlan(cache: OrchestratorCache, key: string): ArchitectPlan | null;
export declare function cachePlan(cache: OrchestratorCache, key: string, plan: ArchitectPlan): void;
export declare function getCachedTestStrategy(cache: OrchestratorCache, key: string): TestStrategyResult | null;
export declare function cacheTestStrategy(cache: OrchestratorCache, key: string, result: TestStrategyResult): void;
export declare function getCacheStats(cache: OrchestratorCache): {
    planCacheSize: number;
    testStrategyCacheSize: number;
    totalHits: number;
};
export declare function clearExpiredCache(cache: OrchestratorCache): void;
