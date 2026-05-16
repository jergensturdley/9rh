import chalk from "chalk";
import type { AgentEvent } from "./agent.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function cols(): number {
  return process.stdout.columns ?? 80;
}

function boxWidth(): number {
  return Math.min(cols() - 4, 76);
}

function drawBox(
  label: string,
  body: string,
  borderFn: (s: string) => string,
  useColor: boolean,
): string {
  const w = boxWidth();
  const inner = w - 2;
  const labelFull = ` ${label} `;
  const dashCount = Math.max(0, inner - labelFull.length - 1);
  const top = borderFn(`╭─${labelFull}${"─".repeat(dashCount)}╮`);

  const bodyLines = body
    .split("\n")
    .slice(0, 24)
    .map((line) => {
      const safe = line.length > inner - 2 ? line.slice(0, inner - 5) + "…" : line;
      const pad = " ".repeat(Math.max(0, inner - 2 - safe.length));
      return (
        borderFn("│") +
        " " +
        (useColor ? chalk.dim(safe) : safe) +
        pad +
        " " +
        borderFn("│")
      );
    });

  const bottom = borderFn(`╰${"─".repeat(inner)}╯`);
  return [top, ...bodyLines, bottom].join("\n");
}

export interface TuiOptions {
  getModel: () => string;
  getWorkDir: () => string;
  useColor: boolean;
}

export interface SplashOptions extends TuiOptions {
  provider: string;
  project: string;
  status: string;
}

function crop(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

function paint(useColor: boolean, line: string, row: number): string {
  if (!useColor) return line;
  const palette = [chalk.cyan, chalk.blueBright, chalk.magentaBright, chalk.cyanBright, chalk.whiteBright];
  return palette[row % palette.length](line);
}

export function printSplash(opts: SplashOptions): void {
  const width = Math.max(64, Math.min(process.stdout.columns ?? 88, 104));
  const infoWidth = Math.max(28, Math.min(54, width - 44));
  const logo = [
    "        .-''''''-.",
    "     .-'  .----.  '-.",
    "   .'   .'  __  '.   '.",
    "  /    /   /  \\   \\    \\",
    " ;    ;   | () |   ;    ;",
    " |    |    \\__/    |    |",
    " ;    ;  .-.__.-.  ;    ;",
    "  \\    \\  '--'  /    /",
    "   '.   '------'   .'",
    "     '-.  9rh   .-'",
    "        '------'",
  ];
  const header = opts.useColor ? chalk.bold.white("9rh://agent-runtime") : "9rh://agent-runtime";
  const pairs: Array<[string, string]> = [
    ["model", opts.getModel()],
    ["provider", opts.provider],
    ["project", opts.project],
    ["workdir", opts.getWorkDir().replace(process.env.HOME ?? "", "~")],
    ["status", opts.status],
  ];
  const info = [header, ""].concat(
    pairs.map(([key, value]) => {
      const k = opts.useColor ? chalk.dim(key.padEnd(8)) : key.padEnd(8);
      const v = opts.useColor ? chalk.bold(crop(value, infoWidth - 10)) : crop(value, infoWidth - 10);
      return `${k} ${v}`;
    }),
    ["", opts.useColor ? chalk.dim("/help commands  •  /doctor health  •  Ctrl+C quit") : "/help commands  •  /doctor health  •  Ctrl+C quit"],
  );

  const logoWidth = Math.max(...logo.map((line) => line.length));
  const gap = "    ";
  const rows = Math.max(logo.length, info.length);
  const top = opts.useColor ? chalk.dim("╭" + "─".repeat(Math.min(width - 2, logoWidth + gap.length + infoWidth)) + "╮") : "╭" + "─".repeat(Math.min(width - 2, logoWidth + gap.length + infoWidth)) + "╮";
  const bottom = opts.useColor ? chalk.dim("╰" + "─".repeat(Math.min(width - 2, logoWidth + gap.length + infoWidth)) + "╯") : "╰" + "─".repeat(Math.min(width - 2, logoWidth + gap.length + infoWidth)) + "╯";

  process.stdout.write("\n" + top + "\n");
  for (let i = 0; i < rows; i++) {
    const left = paint(opts.useColor, (logo[i] ?? "").padEnd(logoWidth), i);
    const right = info[i] ?? "";
    const body = left + gap + right;
    process.stdout.write(`  ${body}\n`);
  }
  process.stdout.write(bottom + "\n\n");
}

export function createTuiRenderer(opts: TuiOptions): (event: AgentEvent) => void {
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  let spinnerActive = false;
  let thinkingActive = false;
  let iterCurrent = 0;
  let iterMax = 0;

  function startSpinner(label: string): void {
    if (spinnerActive) return;
    spinnerActive = true;
    spinnerFrame = 0;
    spinnerTimer = setInterval(() => {
      const frame = FRAMES[spinnerFrame % FRAMES.length];
      const line = opts.useColor
        ? `  ${chalk.cyan(frame)} ${chalk.dim(label)}`
        : `  ${frame} ${label}`;
      process.stdout.write(`\r${line}`);
      spinnerFrame++;
    }, 80);
  }

  function stopSpinner(): void {
    if (!spinnerActive) return;
    if (spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    process.stdout.write("\r\x1b[2K");
    spinnerActive = false;
  }

  function printIterHeader(): void {
    const w = boxWidth() + 2;
    const model = opts.getModel();
    const dir = opts.getWorkDir().replace(process.env.HOME ?? "", "~");
    const iterStr = `iter ${iterCurrent}/${iterMax}`;

    if (iterCurrent === 1) {
      const sep = "═".repeat(w - 2);
      const title = `  9rh  ·  ${model}`;
      const right = `${dir}  `;
      const gap = " ".repeat(Math.max(0, w - 2 - title.length - right.length));
      const body = (title + gap + right).slice(0, w - 2).padEnd(w - 2);

      process.stdout.write("\n");
      if (opts.useColor) {
        process.stdout.write(chalk.bold.blue(`╔${sep}╗`) + "\n");
        process.stdout.write(
          chalk.bold.blue("║") +
            chalk.bold.white(body) +
            chalk.bold.blue("║") +
            "\n",
        );
        process.stdout.write(chalk.bold.blue(`╚${sep}╝`) + "\n\n");
      } else {
        process.stdout.write(`╔${sep}╗\n║${body}║\n╚${sep}╝\n\n`);
      }
    } else {
      const line = opts.useColor
        ? `\n  ${chalk.dim("─── " + iterStr + " ───")}\n`
        : `\n  --- ${iterStr} ---\n`;
      process.stdout.write(line);
    }
  }

  return function onEvent(event: AgentEvent): void {
    switch (event.type) {
      case "iteration":
        iterCurrent = event.current;
        iterMax = event.max;
        thinkingActive = false;
        stopSpinner();
        printIterHeader();
        startSpinner("thinking…");
        break;

      case "thinking":
        if (!thinkingActive) {
          stopSpinner();
          process.stdout.write("  ");
          thinkingActive = true;
        }
        process.stdout.write(event.text);
        break;

      case "tool_call": {
        stopSpinner();
        const argsStr = JSON.stringify(event.args, null, 2);
        const label = `⚙  ${event.name}`;
        const borderFn = opts.useColor ? chalk.cyan : (s: string) => s;
        process.stdout.write("\n\n");
        process.stdout.write(drawBox(label, argsStr, borderFn, opts.useColor) + "\n");
        thinkingActive = false;
        startSpinner(`running ${event.name}…`);
        break;
      }

      case "tool_result": {
        stopSpinner();
        if (event.error) {
          const content = [event.error, event.output].filter(Boolean).join("\n");
          const borderFn = opts.useColor ? chalk.red : (s: string) => s;
          process.stdout.write(
            "\n" + drawBox("✗  error", content, borderFn, opts.useColor) + "\n",
          );
        } else {
          const lines = event.output.split("\n");
          const preview = lines.slice(0, 6).join("\n");
          const moreHint =
            lines.length > 6
              ? opts.useColor
                ? chalk.dim(`\n  … ${lines.length - 6} more lines`)
                : `\n  … ${lines.length - 6} more lines`
              : "";
          const tick = opts.useColor ? chalk.green("✓") : "✓";
          process.stdout.write(
            `\n  ${tick}  ${opts.useColor ? chalk.dim(preview) : preview}${moreHint}\n`,
          );
        }
        thinkingActive = false;
        startSpinner("thinking…");
        break;
      }

      case "compact":
        stopSpinner();
        process.stdout.write(
          "\n" +
            (opts.useColor
              ? chalk.yellow(`  ⟳  compacting context — ${event.summary}`)
              : `  compacting context — ${event.summary}`) +
            "\n\n",
        );
        break;

      case "done": {
        stopSpinner();
        const w = boxWidth() + 2;
        const sep = "═".repeat(w - 2);
        const body = "  ✓  done".padEnd(w - 2);
        process.stdout.write("\n\n");
        if (opts.useColor) {
          process.stdout.write(chalk.green(`╔${sep}╗`) + "\n");
          process.stdout.write(
            chalk.green("║") + chalk.bold.white(body) + chalk.green("║") + "\n",
          );
          process.stdout.write(chalk.green(`╚${sep}╝`) + "\n\n");
        } else {
          process.stdout.write(`╔${sep}╗\n║${body}║\n╚${sep}╝\n\n`);
        }
        break;
      }

      case "error":
        stopSpinner();
        process.stdout.write(
          "\n" +
            (opts.useColor
              ? chalk.red(`  ⚠  ${event.message}`)
              : `  ⚠  ${event.message}`) +
            "\n\n",
        );
        break;
    }
  };
}
