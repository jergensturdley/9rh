import chalk from "chalk";
import { applyAgentEvent, createRunVisualization, inspectStep, renderRunMapCompact, } from "./visualization.js";
import { colorizeFrame, generatePlasmaFrame, shouldShowSplash, SPLASH_ROWS } from "./splash.js";
const SPINNER_SETS = [
    ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    ["◜", "◠", "◝", "◞", "◡", "◟"],
    ["✶", "✸", "✹", "✺", "✹", "✷"],
    ["▖", "▘", "▝", "▗"],
    ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"],
];
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
    "building a tiny bridge over undefined behavior…",
    "installing handrails on the happy path…",
    "asking the bug to step into better lighting…",
    "knitting a stack trace into a little scarf…",
    "teaching the build graph object permanence…",
    "putting the race condition in time-out…",
    "checking whether the abstraction has a permit…",
    "building a tasteful shrine to deterministic output…",
    "convincing the cache that secrets are not snacks…",
    "polishing the yak before shaving it responsibly…",
    "measuring vibes with a calibrated rubber duck…",
    "building a small fence around spooky action at a distance…",
    "asking the linter to use its inside voice…",
    "turning vague dread into actionable diffs…",
    "feeding breadcrumbs to the control flow…",
    "checking if the monorepo needs a weighted blanket…",
    "assembling a bug trap from promises and string cheese…",
    "building context scaffolding out of exact filenames…",
    "letting the type checker sniff the evidence…",
    "pressing the flaky test until it squeaks…",
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
    "asking {tool} to build a tiny ramp for the bytes…",
    "letting {tool} operate the repo forklift very slowly…",
    "checking whether {tool} filed its side effects correctly…",
    "watching {tool} perform filesystem cartography…",
    "asking {tool} to bring back facts, not folklore…",
    "giving {tool} a reflective vest and a timeout…",
    "letting {tool} rummage through the evidence drawer…",
    "asking {tool} to keep stdout on a short leash…",
    "waiting while {tool} translates chaos into exit codes…",
    "letting {tool} build a little report out of crumbs…",
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
    "building suspense in a strictly bounded buffer…",
    "rotating the tiny moon of progress…",
    "dusting the live map for fingerprints…",
    "checking whether context loss left footprints…",
    "watering the continuation packet…",
    "counting progress sparks in the terminal rafters…",
    "keeping the transcript warm by the compiler fire…",
    "asking the sandbox hamster wheel for telemetry…",
    "building a small lighthouse for the next tool call…",
    "listening for suspiciously confident silence…",
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
export function formatElapsed(start) {
    const ms = Date.now() - start.getTime();
    const secs = Math.floor(ms / 1000) % 60;
    const mins = Math.floor(ms / 60000) % 60;
    const hrs = Math.floor(ms / 3600000);
    if (hrs > 0)
        return `${hrs}h ${mins}m`;
    if (mins > 0)
        return `${mins}m ${secs}s`;
    return `${secs}s`;
}
export function toolTarget(args) {
    const raw = typeof args.path === "string" ? args.path :
        typeof args.file_path === "string" ? args.file_path :
            typeof args.command === "string" ? args.command :
                typeof args.query === "string" ? args.query :
                    typeof args.url === "string" ? args.url : "";
    return crop(normalizeWhitespace(raw), 30);
}
export function renderDashboardLines(state, useColor, w, runMap) {
    const inner = w - 4;
    if (inner < 10)
        return [];
    const lines = [];
    const model = crop("9rh", inner - 5);
    const headerText = ` 9rh · ${model} `;
    const dashFill = Math.max(1, w - 2 - headerText.length);
    lines.push(`╭${headerText}${"─".repeat(dashFill)}╮`);
    const elapsed = formatElapsed(state.startedAt);
    const iterStr = state.iterMax > 0 ? `iter ${state.iterCurrent}/${state.iterMax}` : "iter —";
    lines.push(`│ ` + `⏱ ${elapsed}    ${iterStr}`.padEnd(inner) + ` │`);
    lines.push(`│${" ".repeat(inner + 2)}│`);
    if (state.activity === "thinking") {
        const countStr = `${state.thinkingCharCount} chars`;
        const actLine = `⚡ thinking · ${countStr}`;
        lines.push(`│ ${actLine.padEnd(inner)} │`);
        if (state.thinkingPreview) {
            const preview = normalizeWhitespace(state.thinkingPreview);
            const snippet = preview.length > inner - 4 ? `…${preview.slice(-(inner - 5))}` : preview;
            lines.push(`│ ` + `…${snippet}`.padEnd(inner) + ` │`);
        }
        else {
            lines.push(`│${" ".repeat(inner + 2)}│`);
        }
    }
    else if (state.activity === "tool" && state.currentTool) {
        const toolLine = `⚙ ${state.currentTool}${state.currentToolTarget ? ` · ${crop(state.currentToolTarget, inner - 8)}` : ""}`;
        lines.push(`│ ${toolLine.padEnd(inner)} │`);
        lines.push(`│${" ".repeat(inner + 2)}│`);
    }
    else if (state.activity === "done") {
        lines.push(`│ ${"✓ done".padEnd(inner)} │`);
        lines.push(`│${" ".repeat(inner + 2)}│`);
    }
    else if (state.activity === "error") {
        lines.push(`│ ${"⚠ error".padEnd(inner)} │`);
        lines.push(`│${" ".repeat(inner + 2)}│`);
    }
    else {
        lines.push(`│ ${"idle".padEnd(inner)} │`);
        lines.push(`│${" ".repeat(inner + 2)}│`);
    }
    lines.push(`│${" ".repeat(inner + 2)}│`);
    const history = state.toolHistory.slice(-5);
    for (const entry of history) {
        const icon = entry.status === "running" ? "⚙" : entry.status === "error" ? "⚠" : "✓";
        const text = `${icon} ${entry.name}${entry.target ? ` · ${entry.target}` : ""}`;
        lines.push(`│ ${crop(text, inner).padEnd(inner)} │`);
    }
    const padCount = Math.max(0, 5 - history.length);
    for (let i = 0; i < padCount; i++) {
        lines.push(`│${" ".repeat(inner + 2)}│`);
    }
    lines.push(`│${" ".repeat(inner + 2)}│`);
    lines.push(`│ ${"▸ timeline".padEnd(inner)} │`);
    const mapLines = renderRunMapCompact(runMap, inner);
    const showing = mapLines.slice(-6);
    for (const ml of showing) {
        lines.push(`│ ${crop(ml, inner).padEnd(inner)} │`);
    }
    const mapPad = Math.max(0, 6 - showing.length);
    for (let i = 0; i < mapPad; i++) {
        lines.push(`│${" ".repeat(inner + 2)}│`);
    }
    lines.push(`│${" ".repeat(inner + 2)}│`);
    const sandStr = runMap.sandboxHealth
        ? `${runMap.sandboxHealth.sandboxed}/${runMap.sandboxHealth.direct}/${runMap.sandboxHealth.timedOut}`
        : "—";
    const checkStr = runMap.lastGoodCheckpointId ? crop(runMap.lastGoodCheckpointId, Math.max(1, inner - 22)) : "none";
    const footer = `sandbox ${sandStr}  check ${checkStr}`;
    lines.push(`│ ${footer.padEnd(inner)} │`);
    lines.push(`╰${"─".repeat(inner + 2)}╯`);
    if (useColor) {
        return lines.map((line, idx) => {
            if (idx === 0 || idx === lines.length - 1)
                return chalk.blue(line);
            return line;
        });
    }
    return lines;
}
export function createTuiRenderer(opts) {
    let spinnerTimer = null;
    let thinkingSnapshotTimer = null;
    let spinnerFrame = 0;
    let spinnerLabelIndex = 0;
    let activeSpinnerFrames = SPINNER_SETS[0];
    let spinnerActive = false;
    let thinkingActive = false;
    let recentThinking = [];
    let activeThinking = "";
    let iterCurrent = 0;
    let iterMax = 0;
    let lastThinkingSnapshot = 0;
    const sessionStartedAt = new Date();
    const visualization = createRunVisualization();
    const argsStringCache = new WeakMap();
    const dashboard = {
        startedAt: sessionStartedAt,
        iterCurrent: 0,
        iterMax: 0,
        activity: "idle",
        thinkingCharCount: 0,
        thinkingPreview: "",
        currentTool: null,
        currentToolTarget: null,
        toolHistory: [],
    };
    let lastDashboardHeight = 0;
    function stringifyArgs(args) {
        const cached = argsStringCache.get(args);
        if (cached)
            return cached;
        const value = JSON.stringify(args);
        argsStringCache.set(args, value);
        return value;
    }
    function drawDashboard() {
        if (!process.stdout.isTTY)
            return;
        const termWidth = cols();
        const dashWidth = Math.max(36, Math.min(Math.floor(termWidth * 0.28), 48));
        const dashCol = termWidth - dashWidth + 1;
        const lines = renderDashboardLines(dashboard, opts.useColor, dashWidth, visualization);
        if (lines.length === 0)
            return;
        process.stdout.write("\x1b[s");
        // Clear previous dashboard area
        const maxRows = Math.max(lines.length, lastDashboardHeight);
        for (let i = 0; i < maxRows; i++) {
            process.stdout.write(`\x1b[${2 + i};${dashCol}H\x1b[0K`);
        }
        // Draw new lines
        for (let i = 0; i < lines.length; i++) {
            process.stdout.write(`\x1b[${2 + i};${dashCol}H${lines[i]}`);
        }
        lastDashboardHeight = lines.length;
        process.stdout.write("\x1b[u");
    }
    function printThinkingSnapshot() {
        if (!activeThinking)
            return;
        const now = Date.now();
        if (now - lastThinkingSnapshot < 1000)
            return;
        lastThinkingSnapshot = now;
        const snippet = normalizeWhitespace(activeThinking).slice(-200);
        process.stdout.write("\n  ⚡ ");
        if (opts.useColor)
            process.stdout.write(chalk.cyan(snippet));
        else
            process.stdout.write(snippet);
        // Update dashboard with latest thinking state
        dashboard.thinkingCharCount = activeThinking.length;
        dashboard.thinkingPreview = activeThinking.slice(-200);
        drawDashboard();
    }
    function startSpinner(label) {
        if (spinnerActive)
            return;
        spinnerActive = true;
        spinnerFrame = 0;
        activeSpinnerFrames = SPINNER_SETS[(spinnerLabelIndex + label.length) % SPINNER_SETS.length] ?? SPINNER_SETS[0];
        spinnerTimer = setInterval(() => {
            const frame = activeSpinnerFrames[spinnerFrame % activeSpinnerFrames.length];
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
                dashboard.iterCurrent = event.current;
                dashboard.iterMax = event.max;
                dashboard.activity = "thinking";
                thinkingActive = false;
                stopSpinner();
                printIterHeader();
                drawDashboard();
                startSpinner(thinkingLabel());
                break;
            case "thinking":
                if (!thinkingActive) {
                    stopSpinner();
                    thinkingActive = true;
                }
                recentThinking.push(event.text);
                activeThinking += event.text;
                if (recentThinking.join("").length > 1200) {
                    recentThinking = [recentThinking.join("").slice(-1200)];
                }
                if (activeThinking.length > 2_000)
                    activeThinking = activeThinking.slice(-2_000);
                // Throttled snapshot instead of streaming every char
                printThinkingSnapshot();
                break;
            case "tool_call": {
                stopSpinner();
                const target = toolTarget(event.args);
                // Compact 2-line summary instead of full drawBox
                const intent = describeToolIntent(event.name, event.args);
                const line1 = opts.useColor ? chalk.cyan(`⚙ ${event.name}`) : `⚙ ${event.name}`;
                const line2 = opts.useColor ? chalk.dim(`  ${intent}`) : `  ${intent}`;
                process.stdout.write(`\n${line1}\n${line2}\n`);
                // Print final thinking snippet if any
                if (normalizeWhitespace(activeThinking)) {
                    const snippet = normalizeWhitespace(activeThinking).slice(-200);
                    const pre = opts.useColor ? chalk.dim(`  reasoning: ${snippet}`) : `  reasoning: ${snippet}`;
                    process.stdout.write(`${pre}\n`);
                }
                // Update dashboard state
                dashboard.activity = "tool";
                dashboard.currentTool = event.name;
                dashboard.currentToolTarget = target || null;
                dashboard.thinkingCharCount = 0;
                dashboard.thinkingPreview = "";
                dashboard.toolHistory.push({ status: "running", name: event.name, target: target || "" });
                if (dashboard.toolHistory.length > 20)
                    dashboard.toolHistory = dashboard.toolHistory.slice(-20);
                drawDashboard();
                thinkingActive = false;
                activeThinking = "";
                recentThinking = [];
                startSpinner(toolLabel(event.name));
                break;
            }
            case "tool_result": {
                stopSpinner();
                // Mark the matching tool in history as done/failed
                const lastRunning = [...dashboard.toolHistory].reverse().find(h => h.status === "running");
                if (lastRunning) {
                    lastRunning.status = event.error ? "error" : "success";
                }
                dashboard.activity = "idle";
                dashboard.currentTool = null;
                dashboard.currentToolTarget = null;
                if (event.error) {
                    const content = [event.error, event.output].filter(Boolean).join("\n");
                    const borderFn = opts.useColor ? chalk.red : (s) => s;
                    process.stdout.write("\n" + drawBox("✗  error", content, borderFn, opts.useColor) + "\n");
                }
                else {
                    const lines = event.output.split("\n");
                    const preview = lines.slice(0, 6).join("\n");
                    const moreHint = lines.length > 6
                        ? opts.useColor
                            ? chalk.dim(`\n  … ${lines.length - 6} more lines`)
                            : `\n  … ${lines.length - 6} more lines`
                        : "";
                    const tick = opts.useColor ? chalk.green("✓") : "✓";
                    process.stdout.write(`\n  ${tick}  ${opts.useColor ? chalk.dim(preview) : preview}${moreHint}\n`);
                }
                drawDashboard();
                thinkingActive = false;
                startSpinner(thinkingLabel());
                break;
            }
            case "compact":
                stopSpinner();
                process.stdout.write("\n" +
                    (opts.useColor
                        ? chalk.yellow(`  ⟳  compacting context — ${event.summary}`)
                        : `  compacting context — ${event.summary}`) +
                    "\n\n");
                drawDashboard();
                break;
            case "continuation":
                stopSpinner();
                process.stdout.write("\n" +
                    (opts.useColor
                        ? chalk.yellow(`  ⟳  continuing ${event.count}/${event.max}`)
                        : `  continuing ${event.count}/${event.max}`) +
                    "\n\n");
                drawDashboard();
                startSpinner(thinkingLabel());
                break;
            case "model_switch":
                stopSpinner();
                process.stdout.write("\n" +
                    (opts.useColor
                        ? chalk.cyan(`  ⇄  switching model ${event.from} → ${event.to}`)
                        : `  switching model ${event.from} → ${event.to}`) +
                    "\n\n");
                drawDashboard();
                startSpinner(thinkingLabel());
                break;
            case "spec_plan": {
                stopSpinner();
                const borderFn = opts.useColor ? chalk.magentaBright : (s) => s;
                process.stdout.write("\n" + drawBox("☑  generated test plan", event.summary, borderFn, opts.useColor) + "\n");
                drawDashboard();
                thinkingActive = false;
                break;
            }
            case "done": {
                stopSpinner();
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
                dashboard.activity = "done";
                drawDashboard();
                break;
            }
            case "error":
                stopSpinner();
                process.stdout.write("\n" +
                    (opts.useColor
                        ? chalk.red(`  ⚠  ${event.message}`)
                        : `  ⚠  ${event.message}`) +
                    "\n\n");
                dashboard.activity = "error";
                drawDashboard();
                break;
            case "repair_start":
            case "repair_success":
            case "escalate":
            case "circuit_open":
            case "sandbox_health":
            case "branch_create":
            case "incident":
                stopSpinner();
                drawDashboard();
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
                drawDashboard();
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