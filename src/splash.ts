export const SPLASH_LOGO_WIDTH = 72;
export const SPLASH_ROWS = 13;

export interface SplashGateOpts {
  useColor?: boolean;
  isTTY?: boolean;
  columns?: number;
}

/**
 * Return true when the splash MAY be shown given runtime conditions.
 * Reads process.env at call time for testability. opts is optional for tests.
 */
export function shouldShowSplash(opts: SplashGateOpts = {}): boolean {
  const useColor = opts.useColor ?? true;
  const isTTY = opts.isTTY ?? Boolean(process.stdout.isTTY);
  const columns = opts.columns ?? (process.stdout.columns ?? 80);

  if (!useColor) return false;
  if (process.env.CI) return false;
  if (process.env.NO_COLOR) return false;
  if (!isTTY) return false;
  if (columns < SPLASH_LOGO_WIDTH) return false;
  return true;
}

/**
 * Animation requires the same eligibility as showing the splash
 */
export function shouldAnimateSplash(opts: SplashGateOpts = {}): boolean {
  return shouldShowSplash(opts);
}

const EMPTY_FRAME = Array.from({ length: SPLASH_ROWS }, () =>
  Array.from({ length: SPLASH_LOGO_WIDTH }, () => " ")
);

const LOGO = [
  "  █████╗  ██████╗  ██╗  ██╗ ",
  " ██╔══██╗ ██╔══██╗ ██║  ██║ ",
  " ╚██████║ ██████╔╝ ███████║ ",
  "  ╚═══██║ ██╔══██╗ ██╔══██║ ",
  "  █████╔╝ ██║  ██║ ██║  ██║ ",
  "  ╚════╝  ╚═╝  ╚═╝ ╚═╝  ╚═╝ ",
];

const TAGLINE = "agentic terminal runtime";
const FRAME_RAMP = [" ", "·", "˙", "•", "✦", "✶"];
const LOGO_RAMP = ["░", "▒", "▓", "█"];

function cloneEmptyFrame(): string[][] {
  return EMPTY_FRAME.map((row) => [...row]);
}

function putText(canvas: string[][], row: number, col: number, text: string): void {
  if (row < 0 || row >= SPLASH_ROWS) return;
  for (let i = 0; i < text.length; i++) {
    const targetCol = col + i;
    if (targetCol >= 0 && targetCol < SPLASH_LOGO_WIDTH) {
      canvas[row][targetCol] = text[i];
    }
  }
}

/**
 * Generate a single aurora banner animation frame as plain text (no ANSI).
 * @param t - frame index (0..N), drives animation
 * @returns array of SPLASH_ROWS strings, each SPLASH_LOGO_WIDTH chars wide
 */
export function generatePlasmaFrame(t: number): string[] {
  const canvas = cloneEmptyFrame();
  const phase = t * 0.16;

  // Hairline chrome frame with animated corner glints.
  canvas[0][0] = "╭";
  canvas[0][SPLASH_LOGO_WIDTH - 1] = "╮";
  canvas[SPLASH_ROWS - 1][0] = "╰";
  canvas[SPLASH_ROWS - 1][SPLASH_LOGO_WIDTH - 1] = "╯";
  for (let col = 1; col < SPLASH_LOGO_WIDTH - 1; col++) {
    const glint = Math.sin(col * 0.22 - phase * 2.4) > 0.94;
    canvas[0][col] = glint ? "✦" : "─";
    canvas[SPLASH_ROWS - 1][col] = glint ? "✧" : "─";
  }
  for (let row = 1; row < SPLASH_ROWS - 1; row++) {
    canvas[row][0] = "│";
    canvas[row][SPLASH_LOGO_WIDTH - 1] = "│";
  }

  // Soft aurora particles behind the logo.
  const logoStartRow = 3;
  const logoStartCol = Math.floor((SPLASH_LOGO_WIDTH - LOGO[0].length) / 2);
  const logoEndRow = logoStartRow + LOGO.length;
  const logoEndCol = logoStartCol + LOGO[0].length;
  for (let row = 1; row < SPLASH_ROWS - 1; row++) {
    for (let col = 1; col < SPLASH_LOGO_WIDTH - 1; col++) {
      const insideLogoStage =
        row >= logoStartRow - 1 &&
        row <= logoEndRow &&
        col >= logoStartCol - 3 &&
        col <= logoEndCol + 3;
      if (insideLogoStage) continue;

      const x = col / SPLASH_LOGO_WIDTH;
      const y = row / SPLASH_ROWS;
      const ribbon =
        Math.sin(col * 0.16 + phase) +
        Math.sin((col - row * 3) * 0.09 - phase * 1.35) +
        Math.cos((x * x + y) * 8.5 + phase * 0.75);
      const normalized = (ribbon + 3) / 6;
      const idx = Math.max(0, Math.min(FRAME_RAMP.length - 1, Math.floor(normalized * FRAME_RAMP.length)));
      if (idx > 2) canvas[row][col] = FRAME_RAMP[idx];
    }
  }

  // Centered 9rh mark with a moving highlight, preserving the block logo silhouette.
  for (let row = 0; row < LOGO.length; row++) {
    const source = LOGO[row];
    for (let col = 0; col < source.length; col++) {
      if (source[col] === " ") continue;
      const shimmer = Math.sin((col - row * 1.8) * 0.42 - phase * 3.2);
      const idx = Math.max(0, Math.min(LOGO_RAMP.length - 1, Math.floor(((shimmer + 1) / 2) * LOGO_RAMP.length)));
      canvas[logoStartRow + row][logoStartCol + col] = source[col] === "█" ? LOGO_RAMP[idx] : source[col];
    }
  }

  const tagline = `◇ ${TAGLINE} ◇`;
  const pulse = Math.sin(phase * 2) > 0 ? "✧" : "✦";
  putText(canvas, 10, Math.floor((SPLASH_LOGO_WIDTH - tagline.length) / 2), tagline.replaceAll("◇", pulse));

  return canvas.map((row) => row.join(""));
}

const AURORA_COLORS = [45, 51, 87, 123, 159, 219, 213, 207, 201, 165, 129, 93];
const FRAME_COLORS = [60, 66, 72, 78, 84, 120, 156, 192, 228, 222, 216, 210];
const LOGO_COLORS = [51, 87, 123, 159, 195, 225, 219, 213, 207, 201];

/**
 * Apply ANSI color to a plain text frame.
 * @param frame - string[] from generatePlasmaFrame
 * @param opts  - { useColor: boolean }
 * @returns colorized multiline string (or plain if useColor=false)
 */
export function colorizeFrame(
  frame: string[] | string,
  opts: { useColor: boolean } = { useColor: false }
): string {
  const lines = Array.isArray(frame) ? frame : frame.split("\n");
  if (!opts.useColor) return lines.join("\n");

  return lines
    .map((line, row) => {
      let out = "";
      for (let col = 0; col < line.length; col++) {
        const ch = line[col];
        if (ch === " ") {
          out += ch;
          continue;
        }
        const isFrame = row === 0 || row === lines.length - 1 || col === 0 || col === line.length - 1;
        const isLogo = "░▒▓█╔╗╚╝╦╩╠╣═║╭╮╰╯".includes(ch);
        const palette = isFrame ? FRAME_COLORS : isLogo ? LOGO_COLORS : AURORA_COLORS;
        const colorIdx = palette[(row * 3 + col) % palette.length];
        const weight = isLogo ? "1;" : isFrame ? "2;" : "";
        out += `\x1b[${weight}38;5;${colorIdx}m${ch}\x1b[0m`;
      }
      return out;
    })
    .join("\n");
}
