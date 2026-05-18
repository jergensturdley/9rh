import { createHash } from "crypto";
const CACHE_TTL_MS = 30 * 60 * 1000;
export function createOrchestratorCache() {
    return { architectPlans: new Map(), testStrategies: new Map() };
}
function sha256slice(input) {
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
export function hashTask(task) {
    return sha256slice(task.trim().toLowerCase());
}
export function hashTaskAndFiles(task, files) {
    return sha256slice([task.trim().toLowerCase(), ...files.sort()].join("|"));
}
function isExpired(entry) {
    return Date.now() - entry.timestamp > CACHE_TTL_MS;
}
export function getCachedPlan(cache, key) {
    const entry = cache.architectPlans.get(key);
    if (!entry || isExpired(entry)) {
        cache.architectPlans.delete(key);
        return null;
    }
    entry.hits++;
    return entry.value;
}
export function cachePlan(cache, key, plan) {
    cache.architectPlans.set(key, { value: plan, timestamp: Date.now(), hits: 0 });
}
export function getCachedTestStrategy(cache, key) {
    const entry = cache.testStrategies.get(key);
    if (!entry || isExpired(entry)) {
        cache.testStrategies.delete(key);
        return null;
    }
    entry.hits++;
    return entry.value;
}
export function cacheTestStrategy(cache, key, result) {
    cache.testStrategies.set(key, { value: result, timestamp: Date.now(), hits: 0 });
}
export function getCacheStats(cache) {
    let totalHits = 0;
    for (const e of cache.architectPlans.values())
        totalHits += e.hits;
    for (const e of cache.testStrategies.values())
        totalHits += e.hits;
    return {
        planCacheSize: cache.architectPlans.size,
        testStrategyCacheSize: cache.testStrategies.size,
        totalHits,
    };
}
export function clearExpiredCache(cache) {
    for (const [k, v] of cache.architectPlans.entries()) {
        if (isExpired(v))
            cache.architectPlans.delete(k);
    }
    for (const [k, v] of cache.testStrategies.entries()) {
        if (isExpired(v))
            cache.testStrategies.delete(k);
    }
}
//# sourceMappingURL=performanceCache.js.map