# 9rh

9rh is a coding agent for local repositories. It runs one-shot tasks or an interactive REPL, and its tools are sandboxed to the working directory you point it at.

9rh talks to a **backend** for its model traffic. Two backends ship today:

- **Router** (default): routes through [9router](https://github.com/decolua/9router), giving you combo chains, the dashboard, and `/api/*` diagnostics.
- **Direct**: talks straight to any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, LM Studio, etc.) with no local proxy required.

The backend is auto-detected at startup and can be overridden per-invocation. See [Backends](#backends) below.

## What it does

- Runs coding tasks against a local working directory.
- Streams agent thoughts, tool calls, and tool results in the terminal.
- Uses 9router's OpenAI-compatible API for completions (in router mode) and native REST API for diagnostics and slash commands.
- Caches 9router configuration briefly during REPL sessions so slash menus and model pickers stay responsive.

## Install

### Global CLI install

```sh
npm install -g 9rh
```

Then verify your setup:

```sh
9rh --doctor
```

### Local development install

```sh
git clone https://github.com/jergensturdley/9rh.git
cd 9rh
npm install
npm run build
```

The build script also marks `dist/index.js` executable so the `9rh` CLI symlink works correctly on all shells (fish, zsh, bash).

Run the CLI from the repo with:

```sh
node dist/index.js --doctor
```

## 9router setup

In router mode (the default), 9rh expects 9router at `http://localhost:20128/v1`.

Install and start 9router separately, then connect at least one provider in the 9router dashboard:

```text
http://localhost:20128/dashboard
```

Most first-time users should expect to finish setup in the browser. If 9router is not already running, install and start it in another terminal with `npm install -g 9router` and `9router`, open the dashboard, add an API key/provider, then run `node dist/index.js --doctor` or `/refresh`.

In direct mode, 9rh does not require 9router at all; see [Backends](#backends) below.

## Quick start

One-shot task:

```sh
9rh "list all TypeScript files in src"
9rh "read package.json and summarize the dependencies"
9rh "write a hello world Express server to src/server.ts"
```

Run against a specific directory and model:

```sh
9rh \
  --dir /path/to/project \
  --model kr/claude-sonnet-4.5 \
  "refactor the auth module to use JWT"
```

Start the REPL:

```sh
9rh --repl
```

Use environment variables instead of flags:

```sh
export NINE_ROUTER_URL=http://localhost:20128/v1
export NINE_ROUTER_KEY=your-key-from-dashboard
export NINE_ROUTER_MODEL=kr/claude-sonnet-4.5
export NINE_ROUTER_CONTINUATION_MODEL=continuation-heavy

9rh "fix the failing tests"
```

Or skip 9router entirely with direct mode:

```sh
# OpenAI
export OPENAI_API_KEY=sk-...
9rh "fix the failing tests"

# OpenRouter via the preset
export OPENROUTER_API_KEY=sk-or-v1-...
9rh --provider=openrouter --model anthropic/claude-3.5-sonnet "fix the failing tests"

# Local Ollama
9rh --provider=ollama --model llama3.1:70b "fix the failing tests"
```

## CLI options

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `-m, --model <model>` | `NINE_ROUTER_MODEL` | `kr/claude-sonnet-4.5` | Model identifier |
| `-b, --backend <name>` | `NINE_ROUTER_BACKEND` | _(auto-detect)_ | Backend choice: `router` or `direct` |
| `-p, --provider <name>` | n/a | _(none)_ | Direct-mode preset: `openrouter`, `openai`, `ollama`, `lmstudio`. Fills `--direct-url` and the matching API-key env var |
| `--direct-url <url>` | `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` / `OPENROUTER_BASE_URL` | _(none)_ | Direct-mode base URL (overrides `--provider` preset) |
| `--direct-key <key>` | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` | _(none)_ | Direct-mode API key (overrides env-var detection) |
| `--report-path <path>` | n/a | `~/.9rh/last-run.html` | Override the run report path |
| `--no-report` | n/a | n/a | Disable run report generation entirely |
| `-u, --url <url>` | `NINE_ROUTER_URL` | `http://localhost:20128/v1` | 9router API URL (router mode) |
| `-k, --key <key>` | `NINE_ROUTER_KEY` | `9router` | 9router API key (router mode) |
| `-d, --dir <dir>` | n/a | current working directory | Target directory for agent tools |
| `-i, --max-iter <n>` | n/a | `100` | Maximum agent iterations |
| `--no-continue` | n/a | n/a | Disable automatic continuation after max iterations |
| `--continue-model <model>` | `NINE_ROUTER_CONTINUATION_MODEL` | n/a | Model or 9router combo to switch to after max iterations |
| `--continue-max <n>` | `NINE_ROUTER_CONTINUATION_MAX` | `20` | Maximum continuation rounds |
| `--continue-iter <n>` | `NINE_ROUTER_CONTINUATION_ITER` | same as `--max-iter` | Iterations per continuation round |
| `--continue-switch-after <n>` | `NINE_ROUTER_CONTINUATION_SWITCH_AFTER` | `1` | Continuation round that triggers model switch |
| `--repl` | n/a | n/a | Start an interactive REPL |
| `--orchestrate` | n/a | n/a | Route the task through the multi-role team pipeline (architect → implementer → security audit → test strategist → reviewer). Without the flag, structured-looking tasks get a visible "run as a team?" prompt instead of silent rerouting |
| `--allow-skill-install` | n/a | n/a | Allow the agent to call `install_skill` without prompting |
| `--doctor` | n/a | n/a | Run diagnostics and exit |
| `--no-color` | n/a | n/a | Disable colored output |
| `--set-default-model <model>` | n/a | n/a | Save a default model in `~/.9rh/config.json` |
| `--set-default-provider <provider>` | n/a | n/a | Save a default provider/prefix in `~/.9rh/config.json` |
| `--show-config` | n/a | n/a | Print persisted defaults, the effective model, and the resolved backend |

Persistent defaults are used when `--model` and `NINE_ROUTER_MODEL` are not set. If the saved model does not include a provider prefix and `defaultProvider` is set, 9rh combines them, for example `--set-default-provider kr --set-default-model claude-sonnet-4.5` resolves to `kr/claude-sonnet-4.5`.

When a run reaches `--max-iter`, 9rh compacts into a structured continuation packet instead of a bare free-form summary. The packet carries the original task and current objective, completed and pending steps, files touched, commands and tests run, known failures, important outputs verbatim, recent tool history, and long-horizon memory. It also snapshots live repository state from `git status --short`, `git diff --stat`, and `git diff --name-only`. Long-running work loses less context this way, and the model context still stays bounded. Use `--no-continue` to disable it.

## Backends

A `Backend` in 9rh owns the LLM endpoint, the API key, and model enumeration. Two backends ship today, plus one reserved name:

- **`RouterBackend`**: talks to a running 9router. Default. Exposes 9router's native `/api/*` endpoints for `/providers`, `/combos`, `/keys`, `/router`.
- **`DirectBackend`**: talks to any OpenAI-compatible endpoint directly. No local proxy. Does not expose 9router's `/api/*` endpoints.
- **`EmbeddedBackend`**: _(planned)_ 9rh spawns and supervises 9router as a child process. Reserved; currently falls back to `RouterBackend`.

### Auto-detection

`detectBackend()` resolves the backend at startup using this precedence (first non-empty wins):

1. `--backend=router|direct` CLI flag
2. `NINE_ROUTER_BACKEND` env var
3. `~/.9rh/config.json` → `backend` field
4. Env-var heuristic: `NINE_ROUTER_URL` set → router; `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` set without a router URL → direct
5. Reachability probe on `:20128`
6. Last-resort: try to auto-start 9router

For most users, this means "9router is running" → router, and "I have an `OPENAI_API_KEY` but no 9router" → direct. No flags needed.

### Direct-mode provider presets

When using `--backend=direct`, the `--provider=<name>` flag is a shortcut for the common cases:

| Preset | Base URL | API key env var |
|--------|----------|-----------------|
| `--provider=openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `--provider=openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `--provider=ollama` | `http://127.0.0.1:11434/v1` | _(none)_ |
| `--provider=lmstudio` | `http://127.0.0.1:1234/v1` | _(none)_ |

The preset only fills in values that weren't supplied explicitly; `--direct-url` and `--direct-key` always win over the preset. To target a custom proxy, pass `--direct-url` and `--direct-key` directly.

### Mode behavior

- **Router mode**: all slash commands work. `/providers`, `/combos`, `/keys`, `/router` hit 9router's `/api/*` endpoints. Setup wizard is `/setup` (installs/starts 9router).
- **Direct mode**: `/models`, `/switch`, `/status`, `/doctor`, `/sandbox`, `/dir`, `/help`, and `/default-model` all work. `/providers`, `/combos`, `/keys`, `/router` are short-circuited with a "requires 9router mode" message. `/status` shows the backend, baseURL, active model, and workdir. `/doctor` runs a direct-mode check (chat endpoint reachability, API key shape) without the 9router-specific probes.

## REPL slash commands

| Command | Mode | Description |
|---------|------|-------------|
| `/help` | both | List slash commands |
| `/status` | both | Backend, health, active model, working directory |
| `/models [filter]` | both | List available models |
| `/switch <model>` | both | Change the active model for the current REPL session |
| `/default-model <model>` | both | Persist the startup model for future 9rh runs |
| `/dir [path]` | both | Show or change the working directory |
| `/sandbox` | both | Show command sandbox/isolation backend status |
| `/doctor` | both | Diagnose connectivity and configuration |
| `/clear` | both | Clear the terminal |
| `/router` | router | Show a cached 9router configuration summary |
| `/refresh` | router | Clear and reload cached 9router configuration |
| `/providers` | router | List configured 9router provider connections |
| `/combos` | router | List 9router fallback combos |
| `/keys` | router | List configured 9router API keys |
| `/setup` | router | Install and start 9router if needed |
| `/report [open]` | both | Show the path of the most recent run report; `/report open` launches it in the default browser |
| `/brief` | both | Session brief: goal, turns, files touched, commands run, token totals |
| `/usage` | both | Token usage per turn and session total; team turns get a per-role breakdown |
| `/team <task>` | both | Run a task through the multi-role team pipeline (see [Team pipeline](#team-pipeline)) |
| `/rewind` | both | Restore the workdir to before a chosen turn, files only (see [/rewind](#rewind-turn-level-workdir-undo)) |
| `/replay [speed]` | both | Re-render a recorded run through the live TUI (see [/replay](#replay-flight-recorder)) |
| `/quiet [on\|off\|status]` | both | Toggle live thinking narration in the transcript (dashboard, receipts, and final summary unaffected) |
| `/last [n]` | both | Reprint the full output of a recent tool result (1 = most recent), which makes the 6-line preview cap safe instead of lossy |
| `/skills [list\|reload]` | both | List local agent skills from `~/.9rh/skills` |
| `/allow-skill-install [on\|off]` | both | Toggle the `install_skill` policy for this session |

Typing `/` opens a fuzzy command palette: type to filter, ↑/↓ to focus, Enter runs the focused command, Tab completes it (with argument hints shown per command), Esc cancels. `/models`, `/switch`, `/team`-suggestion, `/rewind`, and `/replay` use a shared arrow-key picker (↑/↓, PgUp/PgDn, mouse wheel, Enter selects, Esc cancels).

9router configuration reads for `/models`, `/providers`, `/combos`, `/keys`, `/router`, and the model picker are cached briefly within the current REPL session. Run `/refresh` after changing providers, API keys, combos, or model settings in the 9router dashboard.

## Session UX

The terminal session is built around one rule: report only what the harness observed. Files written, commands run, and tokens spent are rendered as fact; the model's prose renders below them.

### Receipts digest

Every turn ends with a boxed digest computed entirely from tool results and stream metadata (never from the model's self-report):

```
╔══════════════════════════════════════════════╗
║ ✓ done · 3m 42s · 6 steps · 12.4k↑ 3.1k↓ tok ║
║ goal   fix flaky retry test                  ║
║ files  src/backends/router.ts  +18 −4        ║
║ ran    ✓ npm test                            ║
║ assume ⚠ picked "vitest" (ask_user default)  ║
╚══════════════════════════════════════════════╝
```

File lines show net +/- line counts (first-seen before vs last-seen after, so a file edited five times shows one honest delta). `assume` lines list defaults the harness picked when nobody answered an `ask_user` call, so silent decisions stay visible.

### Session ledger

A per-session, append-only record accumulates across turns: goals and outcomes, files touched, commands run, and token usage. It feeds the dashboard's GOAL / SESSION / LAST panels, the receipts digest, `/brief` (turn-by-turn summary), and `/usage` (per-turn token table). Token counts only: 9rh is multi-backend, so it shows no dollar estimates anywhere.

### Clarifying questions (`ask_user`)

The agent has an `ask_user` tool for decisions only the user can make. In a TTY the agent loop pauses and the question renders as an arrow-key picker (options first, recommended default on top, optional free-text escape). In non-interactive sessions the first option is auto-selected and recorded as an **assumption** in the turn digest. The system prompt directs the agent to ask up to 3 clarifying questions upfront on ambiguous tasks and to confirm before destructive actions.

### Team pipeline

`Orchestrator.orchestrate()` runs a multi-role pipeline: **architect → implementer → security audit (risk-gated) → test strategist (task-gated) → reviewer loop** (up to 2 revision rounds), with plan/test-strategy caching and conflict resolution.

Three explicit ways in, with no silent keyword routing:

- `/team <task>` in the REPL
- `--orchestrate` on the CLI
- accepting the suggestion prompt: tasks that look structured (mention plan/design/audit/architect/implement) get a visible "This looks multi-step. Run it as a team?" picker; the streaming agent stays the default, and non-interactive sessions never escalate

Pipeline progress streams through the same event channel as normal runs: role transitions render as `─── architect ───` transcript sections, and the dashboard shows a **TEAM panel** while the pipeline is active, with one lane per role with a status icon (`⚙` active, `✓` done, `⊘` skipped, `↻` cache hit), live elapsed time, and per-role token counts. Team turns close with a normal receipts digest, and `/usage` shows a `└ role` breakdown under the turn.

### `/rewind`: turn-level workdir undo

The ledger retains each turn's raw before/after file-change records (as observed by the harness, capped at 32KB per side). `/rewind` opens a picker over completed turns; selecting "before turn N" walks turns newest→N and restores every recorded change to its pre-turn content, deleting files that a rewound turn created.

Safety rules:

- records truncated at capture time are **skipped** (a truncated restore would corrupt the file)
- files whose current on-disk content no longer matches the recorded post-turn state are **skipped**; rewind never clobbers edits it didn't see
- paths outside the working directory are refused

Conversation history is unchanged: this is a files-only undo, not a conversation fork.

### `/replay`: flight recorder

Every CLI run records its event stream (LLM requests/responses, tool calls and results, checkpoints, all redacted before write) to `~/.9rh/runs/run-<runId>.jsonl`. `/replay` lists recorded runs newest-first, and re-renders the chosen log through the live TUI renderer: iteration headers, tool calls, result previews, and thinking snapshots play back paced by the recorded timestamps (default x2 speed, single gaps capped at 400ms; `/replay 5` plays at x5). Esc or `q` stops playback.

Replay through the TUI is a **pure re-render**: no tools are executed and no LLM is called. (Programmatic re-execution with divergence detection is a separate facility; see [Replay System](#replay-system).)

### Data layout

Everything the harness writes for itself lives under one home, never the current working directory:

| Path | Contents |
|------|----------|
| `~/.9rh/last-run.html` | Most recent run report (or `~/.9rh/reports/` with `keepReports`) |
| `~/.9rh/runs/` | Recorded run event logs (`/replay` reads these) |
| `~/.9rh/snapshots/` | Per-iteration agent-state snapshots (checkpoint restore) |
| `~/.9rh/logs/incidents/` | Repair-system incident reports |
| `~/.9rh/config.json` | Persisted defaults (model, provider, report path) |
| `~/.9rh/skills/` | Installed agent skills |

Set `NINE_RH_HOME` to relocate the whole tree (the test suite points it at a tmpdir).

## Run reports

Every agent turn writes a self-contained HTML summary of the run: what the model reasoned about, which tools it called (with args, output, duration, errors), which files it changed (with before/after diffs), how many tokens it used, and any errors or repairs that happened along the way.

When a run completes, the TUI prints the report path as a `file://` link in the chat:

```
  report: file:///Users/you/.9rh/last-run.html  (open with /report open)
```

From the REPL:

- `/report`: show the path of the most recent report
- `/report open`: launch the report in the default browser (macOS `open`, Linux `xdg-open`, Windows `start`)

### Lifecycle

By default the report is **overwritten on every turn** at `~/.9rh/last-run.html`. The path is configurable:

- CLI: `--report-path <path>` overrides per-invocation
- CLI: `--no-report` disables reports entirely
- Config: `reportPath` in `~/.9rh/config.json` sets the default

To preserve each turn's report instead of overwriting, set `keepReports: true` in `~/.9rh/config.json`. The reports then go to `~/.9rh/reports/run-<runId>.html`.

### File change tracking

For every `write_file` call, 9rh captures the file's content **before** the call and reads it **after** the call. The report shows a real before/after diff (computed inline using LCS, with no external diff library). File contents larger than ~32KB are truncated for the diff with a marker.

### Token usage

Token counts come from the final `usage` chunk of the streaming response (`stream_options: { include_usage: true }` is set on every chat-completion call). The report shows prompt, completion, and total tokens.

## Built-in agent tools

The agent can call sandboxed tools within the selected working directory:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents, optionally by line range |
| `write_file` | Write or create a file inside the work directory |
| `run_bash` | Run a shell command in the work directory |
| `list_files` | List files and directories |
| `search_files` | Search files with grep |
| `codegraph_search` | Search CodeGraph's local semantic index for symbols |
| `codegraph_context` | Build task-focused repository context from CodeGraph |
| `codegraph_files` | Show indexed file structure from CodeGraph |
| `codegraph_affected` | Find tests affected by changed source files |
| `codegraph_status` | Show CodeGraph index health and statistics |

Paths are sandboxed to the active work directory and cannot escape it. File tools also refuse to read or write through symlinks.

When a project has `.codegraph/`, 9rh's default prompt tells the agent to prefer CodeGraph tools for discovery before broad `list_files`, `search_files`, or `read_file` exploration. CodeGraph must be installed on `PATH`; initialize a project with `codegraph init -i` and refresh stale indexes with `codegraph sync .`.

### Sandbox limitations

The default tool path checks are cross-platform, but OS-level process sandboxing is currently only enabled when macOS `sandbox-exec` is available. Use `/sandbox` in the REPL to see whether shell commands are using `macos-sandbox` or direct fallback. On Linux and other platforms, `run_bash` falls back to direct execution unless you provide a custom `SandboxProvider` through the programmatic API. Treat shell commands as trusted on those platforms and use container-level isolation if you need hard process boundaries.

## Programmatic API

9rh exposes the core agent, the backends, and the support modules as a library:

```ts
import { Agent, detectBackend, DirectBackend, RouterBackend } from "9rh";

// Auto-detect: returns a RouterBackend if 9router is running, otherwise
// a DirectBackend from env-var hints.
const backend = (await detectBackend()).backend;

const agent = new Agent({
  baseURL: backend.baseURL,
  apiKey: backend.apiKey,
  model: "kr/claude-sonnet-4.5",
  maxIterations: 20,
  continuationPolicy: {
    maxContinuations: 1,
    modelSwitch: { toModel: "continuation-heavy" },
  },
  workDir: process.cwd(),
  onEvent: (event) => {
    if (event.type === "thinking") process.stdout.write(event.text);
    if (event.type === "tool_call") console.log(`-> ${event.name}`, event.args);
  },
});

await agent.run("Create a fibonacci function in src/math.ts");
```

The package exports:

- `Agent`: the ReAct loop and tool execution
- `TOOL_DEFINITIONS`, `executeTool`: the sandboxed tool set and its dispatcher
- `ensureRouter`: start 9router and return its baseURL/apiKey (legacy helper, superseded by `detectBackend`)
- `detectBackend`: auto-detect a `Backend` from env vars, CLI flags, and reachability
- `DirectBackend`, `RouterBackend`: concrete backend implementations
- `Backend`, `BackendName`, `ModelInfo`, `ProviderInfo`, `ComboInfo`, `KeyInfo`, `HealthSnapshot`: backend interface and types
- `parseTaskSpecification`, `synthesizeTestPlan`, `formatSpecDrivenPrompt`, `shouldUseSpecDrivenTesting`: spec-driven testing helpers
- `createRunVisualization`, `applyAgentEvent`, `applyReplayEvent`, `renderRunVisualization`, `exportRunVisualization`, `visibleSteps`: live run visualization

## Spec-driven testing mode

For implementation-like tasks, 9rh wraps the raw request with a generated specification and test-plan artifact before the agent loop begins. The artifact preserves the original wording, extracts functional behavior, edge cases, constraints, non-goals, explicit bug reports, and ambiguities, then maps those statements to reviewable unit, integration, edge-case, failure-path, or regression test targets.

The harness emits a `spec_plan` event before major code changes. That event is shown in the TUI and written to replay logs when replay is enabled, so reviewers can inspect which assumptions, coverage entries, gaps, and baseline-failure expectations guided the implementation. Set `specDrivenTesting: false` in `AgentConfig` to opt out.

## Live run visualization

The terminal renderer maintains a live run map during each agent run. It projects streamed `AgentEvent` and `ReplayEvent` data into a timeline and a dependency graph. Every step carries a stage (planning, execution, review, repair, completion) and a status (running, failed, repaired, blocked, done). Tool calls link to their outputs and file paths when available, and checkpoints, circuit-breaker events, repair attempts, and sandbox health render alongside the current step.

Embedders can build exportable audit or handoff views with `createRunVisualization()`, `applyAgentEvent()`, `applyReplayEvent()`, `visibleSteps()`, `renderRunVisualization()`, and `exportRunVisualization()`. These helpers support filtering by stage, status, severity, tool, file, branch, and collapsed-noise views.

The REPL splash is a bounded ASCII plasma animation that finishes in under a second, collapses into a compact `9RH ▸` mark, then clears itself before the prompt appears. The style nods to classic ASCII plasma effects (Joacim Wejdin/Injosoft among them); the code and character art are written for this repo. It runs only in an interactive color terminal (TTY, no CI) at least 72 columns wide, and is skipped in CI, piped output, `--no-color`/`NO_COLOR` environments, and narrow terminals.

## Sandbox system

9rh runs tool calls through an isolation layer that restricts filesystem access, network access, and process privileges. `run_bash` is the main consumer.

### Architecture

| Component | File | Responsibility |
|-----------|------|----------------|
| **Sandbox** | `src/sandbox/sandboxer.ts` | Core sandbox class that validates workspace paths and executes through macOS `sandbox-exec` when available |
| **Executor** | `src/sandbox/executor.ts` | `SandboxExecutor` (uses sandbox) vs `DirectExecutor` (no sandbox); both implement the `SandboxProvider` interface |
| **Index** | `src/sandbox/index.ts` | Re-exports what callers actually use: executors, `createExecutor()`, status helpers, and the `SandboxProvider`/`ExecutionResult` types |
| **Observability** | `src/sandbox/executor.ts` | `ObservabilityCollector` records every execution (stdout, stderr, exitCode, timedOut, durationMs, sandboxUsed) and exposes a summary |

### How it works

On macOS, the `Sandbox` class uses `sandbox-exec` when it is installed. On Linux and other platforms, no built-in OS-level sandbox is currently available, so `createExecutor(workDir, { useSandbox: true })` returns `DirectExecutor` instead. Direct `Sandbox.exec()` calls fail closed with a clear "sandbox execution is unavailable" error when the platform sandbox is missing.

The built-in isolation guarantees are path-level checks around the selected `workDir`, symlink blocking for file reads/writes, command timeouts, and output limits. If you need hard Linux process isolation, run 9rh inside a container or provide a custom `SandboxProvider`.

### Sandbox provisioning

Each agent run creates a `Sandbox` instance configured with:
- `workDir`: the project workspace (read/write allowed here only)
- `allowedPaths`: extra directories to permit access to
- `deniedPaths`: always-blocked paths (home dirs, SSH, etc.)
- `networkEnabled`: default false; enable only when needed
- `maxMemoryMB`: memory cap (default 512 MB)
- `maxCPUMs`: CPU time cap (default 30s)
- `timeoutMs`: per-command timeout (default 60s)

When macOS `sandbox-exec` is available, the sandbox profile is generated as a string and passed to `sandbox-exec` on each command invocation.

### Observability

The `ObservabilityCollector` tracks every tool execution and emits a `sandbox_health` event on each agent iteration:

```ts
{ type: "sandbox_health", total, sandboxed, direct, timedOut }
```

This lets operators see:
- How many commands ran in sandboxed vs direct mode
- Which commands timed out
- Whether the sandbox is active and healthy

### Configuration

```ts
import { createExecutor } from "./sandbox/index.js";

// Use sandbox when available, otherwise fall back to direct execution
const executor = createExecutor(workDir, { useSandbox: true });

// Bypass sandbox for trusted environments
const executor = createExecutor(workDir, { useSandbox: false });
```

The agent automatically uses sandboxed execution when available. If `sandbox-exec` is not present on the host, it falls back to `DirectExecutor`.

### Path isolation

All file-based tools (`read_file`, `write_file`, `list_files`, `search_files`) use `sandboxPath()` to resolve and validate that paths stay within `workDir`. Symlinks are explicitly blocked for write operations. `read_file` also blocks reading through symlinks to prevent exfiltration via crafted symlinks inside the workspace.

## Replay system

The replay system reproduces any agent run step-by-step, detects divergence between recorded and fresh executions, and supports time-travel branching from recorded checkpoints. The CLI records every run by default: events are written as JSON Lines to `~/.9rh/runs/run-<runId>.jsonl` (with a `.meta.json` sidecar on clean finalization), redacted before write. Programmatic embedders choose their own `logDir` via `ReplayConfig`. The REPL's `/replay` command (see [Session UX](#replay-flight-recorder)) is a render-only consumer of these logs; the `ReplayEngine` below is the re-execution facility.

### Architecture

Six modules make up the system:

| Module | File | Responsibility |
|--------|------|----------------|
| **eventSchema** | `src/replay/eventSchema.ts` | Defines all event types, run metadata, step context, and the `ReplayEvent` union |
| **eventLogger** | `src/replay/eventLogger.ts` | Records events during agent runs; async batched writes to JSON Lines; exposes `readEventLog()` for replay |
| **replayEngine** | `src/replay/replayEngine.ts` | Loads an event log and replays it sequentially; optionally uses a live LLM provider instead of recorded responses; detects output divergence on `tool_call` vs stored `tool_result` |
| **divergenceDetector** | `src/replay/divergenceDetector.ts` | Compares two event logs or a fresh run against a recorded one; reports the exact field, step, and severity of mismatch |
| **checkpointManager** | `src/replay/checkpointManager.ts` | Saves named snapshots of agent state before major steps; supports restore, list, and prune operations |
| **branchManager** | `src/replay/branchManager.ts` | Tracks run lineage and branching; stores branch metadata in `branchDir/index.json`; provides `getLineage()` and `getBranchesForRun()` |

Import replay classes from their concrete modules (there is no barrel `index.ts`).

### Event types

The event log records these types (each with monotonic `seq` and `ts`):

| Event | Description |
|-------|-------------|
| `run_start` | Run metadata (model, params, workDir, environment, versions) |
| `step_start` / `step_end` | Step boundaries with stepIndex and iteration |
| `llm_request` / `llm_response` | LLM calls with messages, tools, text, and tool calls |
| `tool_call` / `tool_result` | Tool invocation and result with `callId`, output, durationMs |
| `checkpoint` | Named snapshot (periodic, pre-compact, pre-repair, manual) |
| `branch_create` | Branch fork with parentRunId, parentStep, reason |
| `compact` | Message summarization with before/after counts |
| `spec_plan` | Generated specification/test-plan artifact for implementation-like tasks |
| `run_end` | Final run reason and summary |

### Recording a run

```ts
import { EventLogger } from "./replay/eventLogger.js";

const logger = new EventLogger({
  runId: "run_abc123",
  branchId: "main",
  runDir: "./9rh-runs/run_abc123",
});

await logger.init();

// Wire into agent event stream
agent.on("event", (event) => logger.write(event));
```

### Replaying a run

```ts
import { ReplayEngine } from "./replay/replayEngine.js";

const engine = new ReplayEngine({
  eventLogPath: "./9rh-runs/run_abc123/events.jsonl",
  workDir: process.cwd(),
  fromStep: 0,           // 0 = from beginning; N = resume from step N
  stopOnDivergence: true,
  onDivergence(report) {
    console.error("Diverged at step", report.divergedAt.step);
  },
  llmProvider: {
    async complete(messages, model, params) {
      // Optional: get live LLM responses instead of replaying recorded ones
      return openai.complete(messages, model, params);
    },
  },
});

await engine.load();
const { eventCount, divergenceReport } = await engine.replay();
```

### Divergence detection

During replay, before executing each `tool_call`, the engine looks up the stored output for that `callId` from the matching `tool_result` event. If `freshResult.output !== recordedOutput` and `stopOnDivergence` is true, the engine emits an `onDivergence` callback with the full report:

```ts
divergedAt: {
  seq: number,
  eventType: "tool_call",
  step: number,
  field: "output",
  expected: string,   // first 200 chars of recorded output
  actual: string,    // first 200 chars of fresh output
  severity: "critical" | "major" | "minor",
}
```

### Time-travel branching

When divergence is detected, you can branch from the last checkpoint before the diverging step:

```ts
import { BranchManager } from "./replay/branchManager.js";

const bm = new BranchManager({ branchDir: "./9rh-runs/branches" });
await bm.init();

const branch = bm.createBranch({
  newBranchId: "run_def456",
  runId: "run_def456",
  parentRunId: "run_abc123",   // replayed run
  parentStep: divergedStep - 1,
  branchReason: "agent went wrong at step N, retry with claude-sonnet-5",
  eventLogPath: "./9rh-runs/run_abc123/events.jsonl",
});
```

`getLineage(branchId)` walks parent links back to the root run. `getBranchesForRun(runId)` returns all branches forked from a given run.

### Checkpoints

Checkpoints serialize the full agent state (messages, tool history, step index, iteration count) to `~/.9rh/snapshots/<snapshotId>.json` (relocatable via `NINE_RH_HOME`). The `checkpointManager` supports:

- `save(reason)`: periodic, pre-compact, pre-repair, or manual
- `restore(snapshotId)`: restore workDir git state and agent state
- `list()`: enumerate all snapshots with timestamps and reasons

On replay with `fromStep > 0`, the engine skips to the nearest checkpoint at or before `fromStep`, restores it, then processes remaining events from that point.

## Repair system

The repair system detects, classifies, and fixes harness-level errors on its own. Six modules under `src/repair/` do the work.

### Error taxonomy

All errors are classified into four tiers:

| Class | Retryable | Max Retries | Triggers Repair |
|-------|-----------|-------------|-----------------|
| `RECOVERABLE` | Yes | 3 | Yes |
| `AGENT_ERROR` | No | 1 | Yes |
| `ENVIRONMENT_ERROR` | No | 1 | Yes |
| `FATAL` | No | 0 | No; halts immediately |

### Circuit breaker

The `CircuitBreaker` guards against cascading failures. It opens after 3 consecutive `ENVIRONMENT_ERROR` or `FATAL` occurrences and halts the agent loop until the timeout elapses (default 60s).

### Snapshot manager

Before each major step, the agent serializes its state to `~/.9rh/snapshots/` as JSON. On repair success, execution can resume from the last known good state.

### Repair playbook

`src/repair/repairPlaybook.json` maps error patterns to suggested fixes. Entries with `autoApply: true` are applied automatically on HIGH confidence. Current patterns:

- Out-of-memory → increase Node.js heap
- API timeout/rate-limit → exponential backoff
- Malformed LLM JSON → strip markdown fences before parsing
- Missing environment variable → surface to user
- Sandbox process crash → restart sandbox subprocess
- Premature close (undici) → retry with fresh connection

### Repair agent

When an error cannot be resolved by the playbook, the repair sub-agent is invoked via the LLM using a structured prompt. It returns a JSON response:

```json
{
  "error_classification": "RECOVERABLE|AGENT_ERROR|ENVIRONMENT_ERROR|FATAL",
  "root_cause": "one sentence",
  "confidence": "HIGH|MEDIUM|LOW",
  "fix_applied": "exact description",
  "validation_result": "PASSED|FAILED|PENDING",
  "escalate": true|false,
  "user_message": "plain language summary"
}
```

After 3 failed attempts, it escalates to the user.

### Incident logging

All repair attempts write structured JSON incident reports to `~/.9rh/logs/incidents/`. Successful repairs auto-generate a new playbook entry appended to `repairPlaybook.json`.

## Development

```sh
npm install
npm run build
```

Development entrypoints:

- `npm run build` compiles TypeScript to `dist/`
- `npm run dev` runs the CLI through `ts-node`
- `npm start` runs the compiled CLI from `dist/index.js`
- `npm test` runs the Jest suite. Worktree-exclusion patterns in `jest.config.ts` are anchored to `<rootDir>`, so the suite runs both from the repo root (agent worktrees under `.claude/worktrees/` are excluded) and from inside such a worktree.

## Notes

- This package uses NodeNext module resolution and ESM imports.
- When authoring internal TypeScript files, imports use `.js` extensions.
- 9router native endpoints live under `/api/*`; model completion traffic goes through `/v1/*`.
- In direct mode, the model registry comes from `${baseURL}/models` (OpenAI-compatible). Custom endpoints must implement this for `/models` and `/switch` to work.
