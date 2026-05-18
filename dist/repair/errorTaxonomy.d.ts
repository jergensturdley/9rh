export declare enum ErrorClass {
    RECOVERABLE = "RECOVERABLE",
    AGENT_ERROR = "AGENT_ERROR",
    ENVIRONMENT_ERROR = "ENVIRONMENT_ERROR",
    FATAL = "FATAL"
}
export interface ErrorClassMetadata {
    description: string;
    retryable: boolean;
    maxRetries: number;
    triggersRepair: boolean;
}
export declare const ERROR_TAXONOMY: Record<ErrorClass, ErrorClassMetadata>;
export type SourceLayer = "sandbox" | "llm" | "tool" | "orchestrator";
export interface TaggedError {
    cause: unknown;
    message: string;
    sourceLayer: SourceLayer;
    errorClass: ErrorClass;
    timestamp: number;
}
export declare function classifyError(err: unknown): {
    errorClass: ErrorClass;
    reason: string;
};
export declare function tagError(cause: unknown, sourceLayer: SourceLayer): TaggedError;
