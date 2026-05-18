import fs from 'fs';
// Import the splash module (ESM .js extension)
import { generatePlasmaFrame, shouldShowSplash, shouldAnimateSplash, colorizeFrame } from '../splash.js';
import { shouldRepositionSplashFrame, splashAnimationFrameCount, splashCollapseFrameCount, splashFrameDelayMs, } from '../tui.js';
describe('splash module', () => {
    describe('generatePlasmaFrame', () => {
        it('returns frame with expected dimensions', () => {
            const frame = generatePlasmaFrame(0);
            // rows and columns are numbers; do not assert full content
            expect(Array.isArray(frame)).toBe(true);
            // basic shape checks
            expect(frame.length).toBeGreaterThan(0);
            expect(frame[0].length).toBeGreaterThan(0);
        });
        it('generates different frames for different seeds', () => {
            const a = generatePlasmaFrame(0);
            const b = generatePlasmaFrame(1);
            // frames should not be strictly equal
            expect(a).not.toEqual(b);
        });
        it('base frame contains no ANSI escape codes', () => {
            const frame = generatePlasmaFrame(0);
            const joined = frame.join('\n');
            // simple ANSI CSI regex
            const ansi = /\x1B\[[0-9;]*m/;
            expect(ansi.test(joined)).toBe(false);
        });
    });
    describe('shouldShowSplash', () => {
        const envBackup = {};
        beforeEach(() => {
            envBackup.CI = process.env.CI;
            envBackup.NO_COLOR = process.env.NO_COLOR;
            delete process.env.CI;
            delete process.env.NO_COLOR;
        });
        afterEach(() => {
            if (envBackup.CI === undefined)
                delete process.env.CI;
            else
                process.env.CI = envBackup.CI;
            if (envBackup.NO_COLOR === undefined)
                delete process.env.NO_COLOR;
            else
                process.env.NO_COLOR = envBackup.NO_COLOR;
        });
        it('is false when CI is set', () => {
            process.env.CI = 'true';
            // re-import fresh module if needed
            expect(shouldShowSplash()).toBe(false);
        });
        it('is false when NO_COLOR is set', () => {
            const saved = process.env.NO_COLOR;
            process.env.NO_COLOR = '1';
            try {
                expect(shouldShowSplash({ useColor: true, isTTY: true, columns: 120 })).toBe(false);
            }
            finally {
                if (saved === undefined)
                    delete process.env.NO_COLOR;
                else
                    process.env.NO_COLOR = saved;
            }
        });
        it('is true under eligible conditions', () => {
            expect(shouldShowSplash({ useColor: true, isTTY: true, columns: 120 })).toBe(true);
        });
    });
    describe('shouldAnimateSplash', () => {
        const envBackup2 = {};
        beforeEach(() => {
            envBackup2.CI = process.env.CI;
            envBackup2.NO_COLOR = process.env.NO_COLOR;
            delete process.env.CI;
            delete process.env.NO_COLOR;
        });
        afterEach(() => {
            if (envBackup2.CI === undefined)
                delete process.env.CI;
            else
                process.env.CI = envBackup2.CI;
            if (envBackup2.NO_COLOR === undefined)
                delete process.env.NO_COLOR;
            else
                process.env.NO_COLOR = envBackup2.NO_COLOR;
        });
        it('is false when not a TTY', () => {
            expect(shouldAnimateSplash({ useColor: true, isTTY: false, columns: 120 })).toBe(false);
        });
        it('is true when environment allows animation', () => {
            expect(shouldAnimateSplash({ useColor: true, isTTY: true, columns: 120 })).toBe(true);
        });
    });
    describe('colorizeFrame', () => {
        it('returns plain text when useColor=false', () => {
            const frame = generatePlasmaFrame(0);
            const colored = colorizeFrame(frame, { useColor: false });
            const ansi = /\x1B\[[0-9;]*m/;
            expect(ansi.test(colored)).toBe(false);
        });
        it('includes ANSI codes when useColor=true', () => {
            const frame = generatePlasmaFrame(0);
            const colored = colorizeFrame(frame, { useColor: true });
            const ansi = /\x1B\[[0-9;]*m/;
            expect(ansi.test(colored)).toBe(true);
        });
    });
    describe('splash cursor repositioning', () => {
        it('continues redrawing in place before animation timeout', () => {
            expect(shouldRepositionSplashFrame(1_000, 1_999, 1_000)).toBe(true);
        });
        it('does not move back up after the final frame', () => {
            expect(shouldRepositionSplashFrame(1_000, 2_000, 1_000)).toBe(false);
            expect(shouldRepositionSplashFrame(1_000, 2_001, 1_000)).toBe(false);
        });
    });
    describe('splash animation budget', () => {
        it('uses a short bounded animation that completes before input starts', () => {
            const totalMs = (splashAnimationFrameCount() + splashCollapseFrameCount()) * splashFrameDelayMs();
            expect(totalMs).toBeLessThanOrEqual(900);
        });
        it('keeps a visible intro and collapse sequence', () => {
            expect(splashAnimationFrameCount()).toBeGreaterThanOrEqual(8);
            expect(splashCollapseFrameCount()).toBeGreaterThanOrEqual(3);
        });
    });
});
// Ensure evidence directory exists for test run output
try {
    fs.mkdirSync('.sisyphus/evidence', { recursive: true });
}
catch (e) {
    // ignore
}
//# sourceMappingURL=splash.test.js.map