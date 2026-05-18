import type { ContinuationPolicy } from "./agent.js";
export interface SessionState {
    baseURL: string;
    apiKey: string;
    model: string;
    workDir: string;
    useColor: boolean;
    wasStarted?: boolean;
    continuationPolicy?: ContinuationPolicy;
}
export interface ModelInfo {
    id: string;
    owned_by?: string;
}
export declare function toArray<T>(val: unknown): T[];
export declare function fetchModels(state: SessionState): Promise<ModelInfo[]>;
export declare function filterModels(models: ModelInfo[], filter: string): ModelInfo[];
export declare function formatModelsList(models: ModelInfo[], state: SessionState, filter?: string): string;
export declare function executeSlashCommand(line: string, state: SessionState): Promise<string | null>;
export declare function getSlashCommands(): Array<{
    name: string;
    description: string;
}>;
