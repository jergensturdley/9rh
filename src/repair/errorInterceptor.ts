import { type SourceLayer, type TaggedError, ErrorClass, ERROR_TAXONOMY, tagError } from "./errorTaxonomy.js";

export interface InterceptionOptions {
  sourceLayer: SourceLayer;
  onTaggedError?: (tagged: TaggedError) => void;
  onRepairTriggered?: (tagged: TaggedError, attempt: number) => Promise<void>;
  repairAgent?: (tagged: TaggedError, attempt: number) => Promise<RepairResult>;
  circuitBreaker?: CircuitBreakerRef;
}

export interface RepairResult {
  success: boolean;
  snapshotId?: string;
  userMessage?: string;
  escalate: boolean;
}

interface CircuitBreakerRef {
  isOpen: () => boolean;
  recordFailure: (errorClass: ErrorClass) => void;
  recordSuccess: () => void;
}

export async function withErrorInterception<T>(
  fn: () => Promise<T>,
  opts: InterceptionOptions
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
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
        } catch {
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
