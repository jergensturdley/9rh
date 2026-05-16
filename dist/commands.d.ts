export interface SessionState {
    baseURL: string;
    apiKey: string;
    model: string;
    workDir: string;
    useColor: boolean;
    wasStarted?: boolean;
}
export declare function toArray<T>(val: unknown): T[];
export declare function executeSlashCommand(line: string, state: SessionState): Promise<string | null>;
export declare function getSlashCommands(): Array<{
    name: string;
    description: string;
}>;
