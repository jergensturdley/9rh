export interface CompressionOptions {
    textCharThreshold?: number;
    textLineThreshold?: number;
    maxChars?: number;
}
export interface CompressionResult {
    text: string;
    changed: boolean;
    notices: string[];
}
export declare function compressUserInput(input: string, options?: CompressionOptions): CompressionResult;
