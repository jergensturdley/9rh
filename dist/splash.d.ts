export declare const SPLASH_LOGO_WIDTH = 72;
export declare const SPLASH_ROWS = 13;
export interface SplashGateOpts {
    useColor?: boolean;
    isTTY?: boolean;
    columns?: number;
}
/**
 * Return true when the splash MAY be shown given runtime conditions.
 * Reads process.env at call time for testability. opts is optional for tests.
 */
export declare function shouldShowSplash(opts?: SplashGateOpts): boolean;
/**
 * Animation requires the same eligibility as showing the splash
 */
export declare function shouldAnimateSplash(opts?: SplashGateOpts): boolean;
/**
 * Generate a single aurora banner animation frame as plain text (no ANSI).
 * @param t - frame index (0..N), drives animation
 * @returns array of SPLASH_ROWS strings, each SPLASH_LOGO_WIDTH chars wide
 */
export declare function generatePlasmaFrame(t: number): string[];
/**
 * Apply ANSI color to a plain text frame.
 * @param frame - string[] from generatePlasmaFrame
 * @param opts  - { useColor: boolean }
 * @returns colorized multiline string (or plain if useColor=false)
 */
export declare function colorizeFrame(frame: string[] | string, opts?: {
    useColor: boolean;
}): string;
