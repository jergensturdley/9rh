declare function readFirstApiKey(): string | null;
export { readFirstApiKey };
export interface InitResult {
    baseURL: string;
    apiKey: string;
    wasStarted: boolean;
    error?: string;
}
export declare function ensureRouter(routerUrl?: string, apiKey?: string): Promise<InitResult>;
