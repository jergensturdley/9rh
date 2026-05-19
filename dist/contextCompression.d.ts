export interface ContextCompressionOptions {
    charThreshold?: number;
    lineThreshold?: number;
    maxChars?: number;
}
export interface ContextCompressionResult {
    text: string;
    changed: boolean;
    originalChars: number;
    compressedChars: number;
}
export declare function compressContextText(text: string, label?: string, options?: ContextCompressionOptions): ContextCompressionResult;
export declare function compressToolResultForContext(toolName: string, output: string, error?: string, options?: ContextCompressionOptions): ContextCompressionResult;
