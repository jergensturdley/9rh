import chalk from "chalk";
import { applyAgentEvent, createRunVisualization, inspectStep, renderRunVisualization, } from "./visualization.js";
import { colorizeFrame, generatePlasmaFrame, shouldShowSplash, SPLASH_ROWS } from "./splash.js";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const THINKING_LABELS = [
    "licking the type system…",
    "asking the AST if it feels held…",
    "warming a tiny cache goblin…",
    "checking if undefined misses us…",
    "staring into /dev/null until it blinks…",
    "rearranging stack frames by mouthfeel…",
    "triangulating vibes from stale closures…",
    "negotiating with a haunted monorepo…",
    "asking null to provide references…",
    "combing lint out of the event loop…",
    "massaging covariance until it squeaks…",
    "putting breakpoints in emotionally vulnerable places…",
    "waiting for entropy to pass code review…",
    "teaching recursion about boundaries…",
    "holding a semaphore's tiny hand…",
    "checking if the heap has a pulse…",
    "turning race conditions into jazz…",
    "seasoning the call stack with regret…",
    "asking the compiler for a second opinion…",
    "reading tea leaves in a stack trace…",
    "performing light dental work on generics…",
    "convincing pointers to point less aggressively…",
    "inventorying cursed edge cases…",
    "defragmenting the vibe buffer…",
    "whispering SOLID principles to spaghetti…",
    "asking Big-O to use its indoor voice…",
    "polishing a suspicious abstraction…",
    "extracting truth from boolean soup…",
    "checking if the regex is sentient…",
    "giving the scheduler a little snack…",
    "waiting for promises to develop object permanence…",
    "trying not to make eye contact with YAML…",
    "measuring technical debt in bone density…",
    "teaching the token stream table manners…",
    "sanding burrs off the control flow…",
    "consulting the sacred flamegraph…",
    "turning undefined into a teachable moment…",
    "folding stack traces into tiny cranes…",
    "counting how many footguns are loaded…",
    "asking the module graph who hurt it…",
    "preheating the inference oven…",
    "performing an exorcism on stale state…",
    "synthesizing a tasteful amount of dread…",
    "debugging by smell, responsibly…",
    "checking cache freshness with a tiny spoon…",
    "watering the syntax tree…",
    "letting the optimizer chew first…",
    "putting the bug in a little jar…",
    "asking the repl if it has dreams…",
    "aligning the dependency chakras…",
    "scraping barnacles off the abstraction layer…",
    "checking if the branch predictor is lying…",
    "making the happy path less smug…",
    "reading the room, then the heap dump…",
    "summoning a minimal reproduction homunculus…",
    "stapling invariants to the wall…",
];
const TOOL_LABELS = [
    "letting {tool} touch the wires…",
    "supervising {tool} with a clipboard and dread…",
    "pressing {tool} against the glass…",
    "feeding {tool} one ethically sourced byte…",
    "waiting for {tool} to stop making eye contact…",
    "asking {tool} to be normal for once…",
    "allowing {tool} near production-adjacent thoughts…",
    "watching {tool} chew through bytes…",
    "standing behind {tool} with a fire blanket…",
    "letting {tool} improvise near sharp objects…",
    "asking {tool} to hold the regex by the safe end…",
    "giving {tool} a helmet and rootless dreams…",
    "waiting while {tool} befriends stderr…",
    "observing {tool} in its little sandbox terrarium…",
    "letting {tool} sniff the filesystem…",
    "asking {tool} what it did with the newline…",
    "monitoring {tool} for sudden opinions…",
    "letting {tool} commune with POSIX ghosts…",
    "waiting for {tool} to return from the basement…",
    "checking whether {tool} brought snacks or errors…",
    "keeping {tool} away from the good scissors…",
    "asking {tool} to explain the smell…",
    "letting {tool} poke the dependency bruise…",
    "watching {tool} make terminal soup…",
    "giving {tool} exactly one adult supervision…",
    "waiting for {tool} to finish its tiny ritual…",
    "asking {tool} not to fork emotionally…",
    "letting {tool} stare into cwd…",
    "counting {tool}'s little syscalls…",
    "waiting for {tool} to cough up stdout…",
    "handing {tool} a map and a liability waiver…",
    "letting {tool} disturb the sediment…",
    "asking {tool} to stop licking file descriptors…",
    "waiting for {tool} to become legally output…",
    "keeping a respectful distance from {tool}…",
    "letting {tool} rearrange the furniture…",
    "asking {tool} if the exit code is in the room…",
    "watching {tool} negotiate with pipes…",
    "letting {tool} wear the ceremonial timeout…",
    "checking {tool}'s pockets for stack traces…",
    "waiting for {tool} to finish being folklore…",
    "asking {tool} to serialize its feelings…",
    "letting {tool} parse the forbidden fruit…",
    "standing by while {tool} meets reality…",
    "giving {tool} a stern look and stdin…",
    "waiting for {tool} to stop inventing whitespace…",
    "letting {tool} breathe near the repo…",
    "asking {tool} to use gentle hands…",
    "monitoring {tool} for feral globbing…",
    "waiting as {tool} consults the inode oracle…",
    "letting {tool} tap the glass of causality…",
    "asking {tool} why it smells like fork bombs…",
    "supervising {tool}'s relationship with PATH…",
    "waiting for {tool} to produce artisanal side effects…",
    "allowing {tool} one controlled scream…",
    "watching {tool} metabolize arguments…",
    "asking {tool} to make stdout pretty but not proud…",
    "letting {tool} count things with suspicious confidence…",
];
const BACKGROUND_LABELS = [
    "listening for kernel noises…",
    "counting suspiciously warm semicolons…",
    "waiting politely in O(n) silence…",
    "checking the basement for orphaned processes…",
    "letting the circuit breaker cool its little hooves…",
    "sweeping crumbs out of the sandbox…",
    "waiting for the incident log to stop breathing…",
    "asking telemetry to blink twice…",
    "putting a tarp over transient failures…",
    "checking if the repair agent bit anyone…",
    "listening to sockets whisper about DNS…",
    "counting retries like ceiling tiles…",
    "waiting for backoff to emotionally mature…",
    "taking the context window's temperature…",
    "checking whether the token budget has teeth…",
    "folding logs into unsettling shapes…",
    "watching the watchdog watch back…",
    "measuring latency with a damp ruler…",
    "asking the health check to cough…",
    "waiting for eventual consistency to arrive late…",
    "turning flaky signals into soup…",
    "checking if the sandbox needs enrichment…",
    "dusting fingerprints off the trace ID…",
    "listening for a panic in the walls…",
    "waiting under the mutex like a goblin…",
    "asking the replay log to remember gently…",
    "counting ghosts in the process table…",
    "checking if the rate limit is asleep…",
    "waiting for the queue to digest…",
    "making sure the timeout has a chaperone…",
];
function cols() {
    return process.stdout.columns ?? 80;
}
function boxWidth() {
    return Math.min(cols() - 4, 76);
}
function drawBox(label, body, borderFn, useColor) {
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
        return (borderFn("│") +
            " " +
            (useColor ? chalk.dim(safe) : safe) +
            pad +
            " " +
            borderFn("│"));
    });
    const bottom = borderFn(`╰${"─".repeat(inner)}╯`);
    return [top, ...bodyLines, bottom].join("\n");
}
function crop(text, max) {
    if (text.length <= max)
        return text;
    return text.slice(0, Math.max(0, max - 1)) + "…";
}
function normalizeWhitespace(text) {
    return text.replace(/\s+/g, " ").trim();
}
export function renderRecentTranscript(entries, maxLines = 8) {
    if (entries.length === 0)
        return "No agent messages yet.";
    const prefixes = {
        agent: "agent",
        tool: "tool",
        result: "result",
        system: "system",
        error: "error",
    };
    return entries
        .slice(-maxLines)
        .map((entry) => `${prefixes[entry.kind]}: ${normalizeWhitespace(entry.text) || "(empty)"}`)
        .join("\n");
}
function truncateMiddle(text, max) {
    if (text.length <= max)
        return text;
    if (max <= 1)
        return "…";
    const head = Math.ceil((max - 1) * 0.6);
    const tail = Math.floor((max - 1) * 0.4);
    return `${text.slice(0, head)}…${text.slice(-tail)}`;
}
function describeToolIntent(tool, args) {
    const target = typeof args.path === "string" ? args.path :
        typeof args.file_path === "string" ? args.file_path :
            typeof args.command === "string" ? args.command :
                typeof args.query === "string" ? args.query :
                    typeof args.url === "string" ? args.url :
                        undefined;
    const targetHint = target ? ` (${truncateMiddle(normalizeWhitespace(target), 42)})` : "";
    if (/^(read|agentgrep|grep|glob|ls|find|search|websearch|webfetch)/i.test(tool))
        return `gather evidence with ${tool}${targetHint}`;
    if (/^(write|edit|multiedit|apply_patch|patch)/i.test(tool))
        return `change workspace state with ${tool}${targetHint}`;
    if (/^(bash|test|npm|node)/i.test(tool))
        return `execute or validate with ${tool}${targetHint}`;
    if (/^(browser|mcp__playwright)/i.test(tool))
        return `inspect or operate a browser surface with ${tool}${targetHint}`;
    return `invoke ${tool}${targetHint}`;
}
export function summarizeLiveModelInsight(recentThinking, toolName, args) {
    const text = normalizeWhitespace(recentThinking.join(" "));
    const excerpt = text ? crop(text, 180) : "waiting for explicit reasoning text from the model";
    const approxTokens = text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
    return [
        `intent: ${describeToolIntent(toolName, args)}`,
        `reasoning: ${excerpt}`,
        `signal: ${approxTokens} approx reasoning tokens since last action`,
    ].join("\n");
}
function stripAnsi(text) {
    return text.replace(/\x1B\[[0-9;]*m/g, "");
}
function visibleLength(text) {
    return stripAnsi(text).length;
}
function padVisible(text, width) {
    return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}
function formatSessionClock(date) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function paint(useColor, line, row) {
    if (!useColor)
        return line;
    const palette = [chalk.cyan, chalk.blueBright, chalk.magentaBright, chalk.cyanBright, chalk.whiteBright];
    return palette[row % palette.length](line);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function shouldRepositionSplashFrame(startMs, nowMs, timeoutMs) {
    return nowMs - startMs < timeoutMs;
}
export function splashFrameDelayMs() {
    return 45;
}
export function splashAnimationFrameCount() {
    return 14;
}
export function splashCollapseFrameCount() {
    return 5;
}
function writeSplashFrame(text) {
    process.stdout.write(text + "\n");
}
function rewindSplashFrame() {
    process.stdout.write(`\x1b[${SPLASH_ROWS}A`);
}
function clearSplashFrame() {
    for (let row = 0; row < SPLASH_ROWS; row++) {
        process.stdout.write("\r\x1b[2K");
        if (row < SPLASH_ROWS - 1)
            process.stdout.write("\x1b[1B");
    }
    rewindSplashFrame();
}
function collapseFrame(frame, step, total) {
    const center = Math.floor(SPLASH_ROWS / 2);
    const keepRadius = Math.max(0, Math.ceil(((total - step - 1) / total) * center));
    return frame.map((line, row) => {
        const distance = Math.abs(row - center);
        if (distance > keepRadius)
            return " ".repeat(line.length);
        if (step === total - 1) {
            const mark = "  9RH ▸";
            return mark.padStart(Math.floor((line.length + mark.length) / 2)).padEnd(line.length);
        }
        return line;
    });
}
export async function printSplash(useColor) {
    const isTTY = Boolean(process.stdout.isTTY);
    const columns = process.stdout.columns ?? 80;
    if (!shouldShowSplash({ useColor, isTTY, columns }))
        return;
    const frameMs = splashFrameDelayMs();
    const restoreCursor = () => {
        process.stdout.write("\x1b[?25h");
    };
    const sigintHandler = () => {
        restoreCursor();
        process.exit(0);
    };
    process.on("SIGINT", sigintHandler);
    const frameCount = splashAnimationFrameCount();
    const collapseCount = splashCollapseFrameCount();
    let frameIndex = 0;
    process.stdout.write("\x1b[?25l");
    try {
        for (; frameIndex < frameCount; frameIndex++) {
            const frame = generatePlasmaFrame(frameIndex);
            writeSplashFrame(colorizeFrame(frame, { useColor }));
            await sleep(frameMs);
            rewindSplashFrame();
        }
        const finalFrame = generatePlasmaFrame(frameIndex);
        for (let step = 0; step < collapseCount; step++) {
            const frame = collapseFrame(finalFrame, step, collapseCount);
            writeSplashFrame(colorizeFrame(frame, { useColor }));
            await sleep(frameMs);
            rewindSplashFrame();
        }
        clearSplashFrame();
    }
    finally {
        restoreCursor();
        process.removeListener("SIGINT", sigintHandler);
    }
}
export function createTuiRenderer(opts) {
    let spinnerTimer = null;
    let liveMapTimer = null;
    let spinnerFrame = 0;
    let spinnerLabelIndex = 0;
    let spinnerActive = false;
    let thinkingActive = false;
    let recentThinking = [];
    let activeThinking = "";
    let transcript = [];
    let iterCurrent = 0;
    let iterMax = 0;
    const sessionStartedAt = new Date();
    const visualization = createRunVisualization();
    const argsStringCache = new WeakMap();
    function rememberTranscript(entry) {
        transcript.push(entry);
        transcript = transcript.slice(-20);
    }
    function printLiveMapNow() {
        if (liveMapTimer !== null) {
            clearTimeout(liveMapTimer);
            liveMapTimer = null;
        }
        const borderFn = opts.useColor ? chalk.blueBright : (s) => s;
        process.stdout.write("\n" + drawBox("◉  recent transcript", renderRecentTranscript(transcript), borderFn, opts.useColor) + "\n");
        process.stdout.write(drawBox("▣  live run map", renderRunVisualization(visualization, { collapseNoise: true }), borderFn, opts.useColor) + "\n");
    }
    function printLiveMap() {
        if (liveMapTimer !== null)
            return;
        liveMapTimer = setTimeout(printLiveMapNow, 300);
        liveMapTimer.unref?.();
    }
    function stringifyArgs(args) {
        const cached = argsStringCache.get(args);
        if (cached)
            return cached;
        const value = JSON.stringify(args);
        argsStringCache.set(args, value);
        return value;
    }
    function startSpinner(label) {
        if (spinnerActive)
            return;
        spinnerActive = true;
        spinnerFrame = 0;
        spinnerTimer = setInterval(() => {
            const frame = FRAMES[spinnerFrame % FRAMES.length];
            const line = opts.useColor
                ? `  ${chalk.cyan(frame)} ${chalk.dim(label)}`
                : `  ${frame} ${label}`;
            process.stdout.write(`\r${line}`);
            spinnerFrame++;
        }, 200);
    }
    function oddLabel(labels, replacements = {}) {
        const template = labels[spinnerLabelIndex++ % labels.length];
        return Object.entries(replacements).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template);
    }
    function thinkingLabel() {
        return oddLabel(THINKING_LABELS);
    }
    function toolLabel(tool) {
        return oddLabel(TOOL_LABELS, { tool });
    }
    function backgroundLabel() {
        return oddLabel(BACKGROUND_LABELS);
    }
    function stopSpinner() {
        if (!spinnerActive)
            return;
        if (spinnerTimer !== null) {
            clearInterval(spinnerTimer);
            spinnerTimer = null;
        }
        process.stdout.write("\r\x1b[2K");
        spinnerActive = false;
    }
    function printIterHeader() {
        const w = boxWidth() + 2;
        const inner = w - 2;
        const model = opts.getModel();
        const dir = opts.getWorkDir().replace(process.env.HOME ?? "", "~");
        const iterStr = `iter ${iterCurrent}/${iterMax}`;
        if (iterCurrent === 1) {
            const sep = "═".repeat(inner);
            const router = opts.getBaseURL?.().replace(/\/v1\/?$/, "") ?? "local";
            const routerMode = opts.getStartedByRouter?.() ? "auto-started" : "connected";
            const cwdName = dir.split("/").filter(Boolean).at(-1) ?? dir;
            const title = `  9rh  ·  ${model}`;
            const right = `${cwdName}  ·  ${formatSessionClock(sessionStartedAt)}  `;
            const gap = " ".repeat(Math.max(0, inner - title.length - right.length));
            const body = (title + gap + right).slice(0, inner).padEnd(inner);
            const metaPlain = [
                iterStr,
                `router ${crop(router, 28)}`,
                routerMode,
                `cwd ${crop(dir, 30)}`,
            ].join("  ·  ");
            const meta = opts.useColor ? chalk.dim(`  ${crop(metaPlain, inner - 4)}`) : `  ${crop(metaPlain, inner - 4)}`;
            process.stdout.write("\n");
            if (opts.useColor) {
                process.stdout.write(chalk.bold.blue(`╔${sep}╗`) + "\n");
                process.stdout.write(chalk.bold.blue("║") +
                    chalk.bold.white(body) +
                    chalk.bold.blue("║") +
                    "\n");
                process.stdout.write(chalk.bold.blue("║") + padVisible(meta, inner) + chalk.bold.blue("║") + "\n");
                process.stdout.write(chalk.bold.blue(`╚${sep}╝`) + "\n\n");
            }
            else {
                process.stdout.write(`╔${sep}╗\n║${body}║\n║${padVisible(meta, inner)}║\n╚${sep}╝\n\n`);
            }
        }
        else {
            const line = opts.useColor
                ? `\n  ${chalk.dim("─── " + iterStr + " ───")}\n`
                : `\n  --- ${iterStr} ---\n`;
            process.stdout.write(line);
        }
    }
    return function onEvent(event) {
        applyAgentEvent(visualization, event);
        switch (event.type) {
            case "iteration":
                iterCurrent = event.current;
                iterMax = event.max;
                thinkingActive = false;
                stopSpinner();
                printIterHeader();
                printLiveMap();
                startSpinner(thinkingLabel());
                break;
            case "thinking":
                if (!thinkingActive) {
                    stopSpinner();
                    process.stdout.write("  ");
                    thinkingActive = true;
                }
                recentThinking.push(event.text);
                activeThinking += event.text;
                if (recentThinking.join("").length > 1200) {
                    recentThinking = [recentThinking.join("").slice(-1200)];
                }
                if (activeThinking.length > 2_000)
                    activeThinking = activeThinking.slice(-2_000);
                process.stdout.write(event.text);
                break;
            case "tool_call": {
                stopSpinner();
                const argsStr = stringifyArgs(event.args);
                const insight = summarizeLiveModelInsight(recentThinking, event.name, event.args);
                const panelBody = [`model insight:\n${insight}`, `args:\n${argsStr}`].join("\n\n");
                const label = `⚙  ${event.name}`;
                const borderFn = opts.useColor ? chalk.cyan : (s) => s;
                if (normalizeWhitespace(activeThinking)) {
                    rememberTranscript({ kind: "agent", text: activeThinking });
                }
                rememberTranscript({ kind: "tool", text: `${event.name} ${argsStr}` });
                process.stdout.write("\n\n");
                process.stdout.write(drawBox(label, panelBody, borderFn, opts.useColor) + "\n");
                printLiveMapNow();
                thinkingActive = false;
                activeThinking = "";
                recentThinking = [];
                startSpinner(toolLabel(event.name));
                break;
            }
            case "tool_result": {
                stopSpinner();
                if (event.error) {
                    const content = [event.error, event.output].filter(Boolean).join("\n");
                    rememberTranscript({ kind: "error", text: content });
                    const borderFn = opts.useColor ? chalk.red : (s) => s;
                    process.stdout.write("\n" + drawBox("✗  error", content, borderFn, opts.useColor) + "\n");
                }
                else {
                    const lines = event.output.split("\n");
                    const preview = lines.slice(0, 6).join("\n");
                    rememberTranscript({ kind: "result", text: preview });
                    const moreHint = lines.length > 6
                        ? opts.useColor
                            ? chalk.dim(`\n  … ${lines.length - 6} more lines`)
                            : `\n  … ${lines.length - 6} more lines`
                        : "";
                    const tick = opts.useColor ? chalk.green("✓") : "✓";
                    process.stdout.write(`\n  ${tick}  ${opts.useColor ? chalk.dim(preview) : preview}${moreHint}\n`);
                }
                printLiveMapNow();
                thinkingActive = false;
                startSpinner(thinkingLabel());
                break;
            }
            case "compact":
                stopSpinner();
                rememberTranscript({ kind: "system", text: `compacting context — ${event.summary}` });
                process.stdout.write("\n" +
                    (opts.useColor
                        ? chalk.yellow(`  ⟳  compacting context — ${event.summary}`)
                        : `  compacting context — ${event.summary}`) +
                    "\n\n");
                printLiveMapNow();
                break;
            case "continuation":
                stopSpinner();
                rememberTranscript({ kind: "system", text: `continuing ${event.count}/${event.max}` });
                process.stdout.write("\n" +
                    (opts.useColor
                        ? chalk.yellow(`  ⟳  continuing ${event.count}/${event.max}`)
                        : `  continuing ${event.count}/${event.max}`) +
                    "\n\n");
                printLiveMapNow();
                startSpinner(thinkingLabel());
                break;
            case "model_switch":
                stopSpinner();
                rememberTranscript({ kind: "system", text: `switching model ${event.from} → ${event.to}` });
                process.stdout.write("\n" +
                    (opts.useColor
                        ? chalk.cyan(`  ⇄  switching model ${event.from} → ${event.to}`)
                        : `  switching model ${event.from} → ${event.to}`) +
                    "\n\n");
                printLiveMapNow();
                startSpinner(thinkingLabel());
                break;
            case "spec_plan": {
                stopSpinner();
                const borderFn = opts.useColor ? chalk.magentaBright : (s) => s;
                process.stdout.write("\n" + drawBox("☑  generated test plan", event.summary, borderFn, opts.useColor) + "\n");
                printLiveMapNow();
                thinkingActive = false;
                break;
            }
            case "done": {
                stopSpinner();
                if (normalizeWhitespace(activeThinking))
                    rememberTranscript({ kind: "agent", text: activeThinking });
                rememberTranscript({ kind: "system", text: "done" });
                const w = boxWidth() + 2;
                const sep = "═".repeat(w - 2);
                const body = "  ✓  done".padEnd(w - 2);
                process.stdout.write("\n\n");
                if (opts.useColor) {
                    process.stdout.write(chalk.green(`╔${sep}╗`) + "\n");
                    process.stdout.write(chalk.green("║") + chalk.bold.white(body) + chalk.green("║") + "\n");
                    process.stdout.write(chalk.green(`╚${sep}╝`) + "\n\n");
                }
                else {
                    process.stdout.write(`╔${sep}╗\n║${body}║\n╚${sep}╝\n\n`);
                }
                printLiveMap();
                break;
            }
            case "error":
                stopSpinner();
                rememberTranscript({ kind: "error", text: event.message });
                process.stdout.write("\n" +
                    (opts.useColor
                        ? chalk.red(`  ⚠  ${event.message}`)
                        : `  ⚠  ${event.message}`) +
                    "\n\n");
                printLiveMap();
                break;
            case "repair_start":
            case "repair_success":
            case "escalate":
            case "circuit_open":
            case "sandbox_health":
            case "branch_create":
            case "incident":
                stopSpinner();
                printLiveMap();
                startSpinner(backgroundLabel());
                break;
            case "step_inspect": {
                stopSpinner();
                const step = inspectStep(visualization, event.stepId);
                if (!step)
                    break;
                const details = [];
                if (event.params)
                    details.push(`params:\n${event.params}`);
                if (event.output)
                    details.push(`output:\n${event.output}`);
                if (event.diff)
                    details.push(`diff:\n${event.diff}`);
                if (event.trace)
                    details.push(`trace:\n${event.trace}`);
                if (event.policy)
                    details.push(`policy:\n${event.policy}`);
                if (!details.length)
                    break;
                const borderFn = opts.useColor ? chalk.blueBright : (s) => s;
                process.stdout.write("\n" + drawBox(`▸ inspect ${event.stepId}`, details.join("\n\n"), borderFn, opts.useColor) + "\n");
                break;
            }
            case "partial_output": {
                const step = visualization.steps.find((s) => s.id === event.stepId);
                if (step) {
                    if (opts.useColor)
                        process.stdout.write(chalk.dim(event.text));
                    else
                        process.stdout.write(event.text);
                }
                break;
            }
        }
    };
}
//# sourceMappingURL=tui.js.map