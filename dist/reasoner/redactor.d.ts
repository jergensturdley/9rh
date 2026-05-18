export declare function redact<T>(value: T): T;
export declare function redactEvent<T extends {
    type: string;
    payload?: unknown;
}>(event: T): T;
