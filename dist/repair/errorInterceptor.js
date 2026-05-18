import { ErrorClass, ERROR_TAXONOMY, tagError } from "./errorTaxonomy.js";
export async function withErrorInterception(fn, opts) {
    try {
        return await fn();
    }
    catch (err) {
        const tagged = tagError(err, opts.sourceLayer);
        opts.onTaggedError?.(tagged);
        if (tagged.errorClass === ErrorClass.FATAL) {
            throw err;
        }
        opts.circuitBreaker?.recordFailure(tagged.errorClass);
        if (opts.circuitBreaker?.isOpen()) {
            throw err;
        }
        const meta = ERROR_TAXONOMY[tagged.errorClass];
        if (meta.triggersRepair && opts.repairAgent) {
            let attempts = 0;
            const maxAttempts = meta.maxRetries;
            while (attempts < maxAttempts) {
                attempts++;
                try {
                    const result = await opts.repairAgent(tagged, attempts);
                    if (result.success) {
                        opts.circuitBreaker?.recordSuccess();
                        return await fn();
                    }
                    if (result.escalate || attempts >= maxAttempts) {
                        await opts.onRepairTriggered?.(tagged, attempts);
                        throw err;
                    }
                }
                catch {
                    if (attempts >= maxAttempts) {
                        await opts.onRepairTriggered?.(tagged, attempts);
                        throw err;
                    }
                }
            }
        }
        throw err;
    }
}
//# sourceMappingURL=errorInterceptor.js.map