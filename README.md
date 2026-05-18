# 9rh

9rh is a lightweight coding agent for local repositories that routes model traffic through [9router](https://github.com/decolua/9router). It supports one-shot tasks, an interactive REPL, a small sandboxed toolset, and automatic 9router startup when the router is not already running.

## What it does

- Runs coding tasks against a local working directory.
- Streams agent thoughts, tool calls, and tool results in the terminal.
- Uses 9router's OpenAI-compatible API for completions and native REST API for diagnostics and slash commands.
- Auto-starts 9router when possible, then reuses the first configured API key.

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
npm install
npm run build
```

The build script also marks `dist/index.js` executable so the `9rh` CLI symlink works correctly on all shells (fish, zsh, bash).

Run the CLI from the repo with:

```sh
node dist/index.js --doctor
```

## 9router setup

9rh expects 9router at `http://localhost:20128/v1` by default.

If 9router is not running, 9rh will try to:

1. install `9router` globally with npm, or fall back to `npx`
2. start `9router --no-browser`
3. wait for the server to become reachable
4. use the first API key stored by 9router

You still need at least one provider connected in the 9router dashboard:

```text
http://localhost:20128/dashboard
```

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

9rh "fix the failing tests"
```

## CLI options

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `-m, --model <model>` | `NINE_ROUTER_MODEL` | `kr/claude-sonnet-4.5` | Model identifier |
| `-u, --url <url>` | `NINE_ROUTER_URL` | `http://localhost:20128/v1` | 9router API URL |
| `-k, --key <key>` | `NINE_ROUTER_KEY` | `9router` | 9router API key |
| `-d, --dir <dir>` | — | current working directory | Target directory for agent tools |
| `-i, --max-iter <n>` | — | `100` | Maximum agent iterations |
| `--repl` | — | — | Start an interactive REPL |
| `--doctor` | — | — | Run diagnostics and exit |
| `--no-color` | — | — | Disable colored output |

## REPL slash commands

| Command | Description |
|---------|-------------|
| `/help` | List slash commands |
| `/status` | Show 9router health, version, active model, and working directory |
| `/models [filter]` | List available models |
| `/providers` | List configured provider connections |
| `/combos` | List fallback combos |
| `/keys` | List configured 9router API keys |
| `/switch <model>` | Change the active model |
| `/dir [path]` | Show or change the working directory |
| `/setup` | Install and start 9router if needed |
| `/doctor` | Diagnose router connectivity and configuration |
| `/clear` | Clear the terminal |

## Built-in agent tools

The agent can call five sandboxed tools within the selected working directory:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents, optionally by line range |
| `write_file` | Write or create a file inside the work directory |
| `run_bash` | Run a shell command in the work directory |
| `list_files` | List files and directories |
| `search_files` | Search files with grep |

Paths are sandboxed to the active work directory and cannot escape it.

## Programmatic API

9rh also exposes the core agent as a library:

```ts
import { Agent } from "9rh";

const agent = new Agent({
  baseURL: "http://localhost:20128/v1",
  apiKey: "9router",
  model: "kr/claude-sonnet-4.5",
  maxIterations: 20,
  workDir: process.cwd(),
  onEvent: (event) => {
    if (event.type === "thinking") process.stdout.write(event.text);
    if (event.type === "tool_call") console.log(`-> ${event.name}`, event.args);
  },
});

await agent.run("Create a fibonacci function in src/math.ts");
```

The package exports:

- `Agent`
- `TOOL_DEFINITIONS`
- `executeTool`
- `ensureRouter`
- `parseTaskSpecification`
- `synthesizeTestPlan`
- `formatSpecDrivenPrompt`
- `shouldUseSpecDrivenTesting`
- `createRunVisualization`
- `applyAgentEvent`
- `applyReplayEvent`
- `renderRunVisualization`
- `exportRunVisualization`
- `visibleSteps`

## Spec-driven testing mode

For implementation-like tasks, 9rh wraps the raw request with a generated specification and test-plan artifact before the agent loop begins. The artifact preserves the original wording, extracts functional behavior, edge cases, constraints, non-goals, explicit bug reports, and ambiguities, then maps those statements to reviewable unit, integration, edge-case, failure-path, or regression test targets.

The harness emits a `spec_plan` event before major code changes. That event is shown in the TUI and written to replay logs when replay is enabled, so reviewers can inspect which assumptions, coverage entries, gaps, and baseline-failure expectations guided the implementation. Set `specDrivenTesting: false` in `AgentConfig` to opt out for custom embeddings.

## Live run visualization

The terminal renderer maintains a live run map during each agent run. It projects streamed `AgentEvent` and `ReplayEvent` data into a timeline plus dependency graph, showing planning, execution, review, repair, and completion stages with statuses such as running, failed, repaired, blocked, and done. Tool calls are linked to outputs and file paths when available; checkpoints, circuit-breaker events, repair attempts, and sandbox health are surfaced alongside the current step.

Embedders can build exportable audit or handoff views with `createRunVisualization()`, `applyAgentEvent()`, `applyReplayEvent()`, `visibleSteps()`, `renderRunVisualization()`, and `exportRunVisualization()`. These helpers support filtering by stage, status, severity, tool, file, branch, and collapsed-noise views.

The REPL splash uses an original bounded ASCII plasma intro that completes in under one second, briefly collapses into a compact `9RH ▸` mark, then clears itself before the interactive prompt starts. All characters and structure are own-design; the style is inspired by classic ASCII plasma effects (e.g. Joacim Wejdin/Injosoft), but all code and assets are original. The animation runs only in interactive color terminals (TTY + no CI) with a width of at least 72 columns. It is skipped entirely in CI, non-TTY/piped output, `--no-color`/`NO_COLOR` environments, or narrow terminals.

## Sandbox System

9rh uses an isolation layer to execute tool calls (particularly `run_bash`) in a restricted environment that limits filesystem access, network connectivity, and process privileges.

### Architecture

| Component | File | Responsibility |
|-----------|------|----------------|
| **Sandbox** | `src/sandbox/sandboxer.ts` | Core sandbox class — generates OS-native sandbox profiles (macOS `sandbox-exec`, Linux cgroup) and executes commands through them |
| **Executor** | `src/sandbox/executor.ts` | `SandboxExecutor` (uses sandbox) vs `DirectExecutor` (no sandbox) — both implement `SandboxProvider` interface |
| **Index** | `src/sandbox/index.ts` | Re-exports all sandbox types and `createExecutor()` factory |
| **Observability** | `src/sandbox/executor.ts` | `ObservabilityCollector` records every execution (stdout, stderr, exitCode, timedOut, durationMs, sandboxUsed) and exposes a summary |

### How it works

On macOS, the `Sandbox` class generates an `sandbox-exec` profile (Apple's sandboxing mechanism) that:
- Denies all file access by default
- Allows read/write only within `workDir` and `/tmp`
- Denies access to SSH keys (`~/.ssh/**`), shell configs, home directories, and sensitive system paths
- Allows execution of specific binaries: `node`, `sh`, `git`, `grep`, `find`, `xargs`, `npx`
- Blocks network outbound unless explicitly enabled via `networkEnabled: true`
- Enforces resource limits (timeout, max buffer)

On Linux, the sandbox uses cgroup-based profiles — fallback is to `DirectExecutor` (no sandbox) until cgroup support is implemented.

### Sandbox provisioning

Each agent run creates a `Sandbox` instance configured with:
- `workDir` — the project workspace (read/write allowed here only)
- `allowedPaths` — extra directories to permit access to
- `deniedPaths` — always-blocked paths (home dirs, SSH, etc.)
- `networkEnabled` — default false; enable only when needed
- `maxMemoryMB` — memory cap (default 512 MB)
- `maxCPUMs` — CPU time cap (default 30s)
- `timeoutMs` — per-command timeout (default 60s)

The sandbox profile is generated as a string and passed to `sandbox-exec` on each command invocation.

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

// Use sandbox (macOS sandbox-exec, Linux fallback to direct)
const executor = createExecutor(workDir, { useSandbox: true });

// Bypass sandbox for trusted environments
const executor = createExecutor(workDir, { useSandbox: false });
```

The agent automatically uses sandboxed execution when available. If `sandbox-exec` is not present on the host, it falls back to `DirectExecutor`.

### Path isolation

All file-based tools (`read_file`, `write_file`, `list_files`, `search_files`) use `sandboxPath()` to resolve and validate that paths stay within `workDir`. Symlinks are explicitly blocked for write operations. `read_file` also blocks reading through symlinks to prevent exfiltration via crafted symlinks inside the workspace.

## Replay System

The replay system reproduces any agent run step-by-step, detects divergence between recorded and fresh executions, and supports time-travel branching from recorded checkpoints. Events are written as JSON Lines to `9rh-runs/<runId>/events.jsonl`.

### Architecture

The system is composed of seven modules:

| Module | File | Responsibility |
|--------|------|----------------|
| **eventSchema** | `src/replay/eventSchema.ts` | Defines all event types, run metadata, step context, and the `ReplayEvent` union |
| **eventLogger** | `src/replay/eventLogger.ts` | Records events during agent runs; async batched writes to JSON Lines; exposes `readEventLog()` for replay |
| **replayEngine** | `src/replay/replayEngine.ts` | Loads an event log and replays it sequentially; optionally uses a live LLM provider instead of recorded responses; detects output divergence on `tool_call` vs stored `tool_result` |
| **divergenceDetector** | `src/replay/divergenceDetector.ts` | Compares two event logs or a fresh run against a recorded one; reports the exact field, step, and severity of mismatch |
| **checkpointManager** | `src/replay/checkpointManager.ts` | Saves named snapshots of agent state before major steps; supports restore, list, and prune operations |
| **branchManager** | `src/replay/branchManager.ts` | Tracks run lineage and branching; stores branch metadata in `branchDir/index.json`; provides `getLineage()` and `getBranchesForRun()` |
| **index** | `src/replay/index.ts` | Re-exports all public types and classes |

### Event Types

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

### Recording a Run

```ts
import { EventLogger } from "./replay/index.js";

const logger = new EventLogger({
  runId: "run_abc123",
  branchId: "main",
  runDir: "./9rh-runs/run_abc123",
});

await logger.init();

// Wire into agent event stream
agent.on("event", (event) => logger.write(event));
```

### Replaying a Run

```ts
import { ReplayEngine } from "./replay/index.js";

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

### Divergence Detection

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

### Time-Travel Branching

When divergence is detected, you can branch from the last checkpoint before the diverging step:

```ts
import { BranchManager } from "./replay/index.js";

const bm = new BranchManager({ branchDir: "./9rh-runs/branches" });
await bm.init();

const branch = bm.createBranch({
  newBranchId: "run_def456",
  runId: "run_def456",
  parentRunId: "run_abc123",   // replayed run
  parentStep: divergedStep - 1,
  branchReason: "agent went wrong at step N — retry with claude-sonnet-5",
  eventLogPath: "./9rh-runs/run_abc123/events.jsonl",
});
```

`getLineage(branchId)` walks parent links back to the root run. `getBranchesForRun(runId)` returns all branches forked from a given run.

### Checkpoints

Checkpoints serialize the full agent state (messages, tool history, step index, iteration count) to `snapshots/<snapshotId>.json`. The `checkpointManager` supports:

- `save(reason)` — periodic, pre-compact, pre-repair, or manual
- `restore(snapshotId)` — restore workDir git state and agent state
- `list()` — enumerate all snapshots with timestamps and reasons

On replay with `fromStep > 0`, the engine skips to the nearest checkpoint at or before `fromStep`, restores it, then processes remaining events from that point.

## Repair System

The repair system automatically detects, classifies, and fixes harness-level errors. It is composed of six modules under `src/repair/`.

### Error Taxonomy

All errors are classified into four tiers:

| Class | Retryable | Max Retries | Triggers Repair |
|-------|-----------|-------------|-----------------|
| `RECOVERABLE` | Yes | 3 | Yes |
| `AGENT_ERROR` | No | 1 | Yes |
| `ENVIRONMENT_ERROR` | No | 1 | Yes |
| `FATAL` | No | 0 | No — halts immediately |

### Circuit Breaker

The `CircuitBreaker` guards against cascading failures. It opens after 3 consecutive `ENVIRONMENT_ERROR` or `FATAL` occurrences and halts the agent loop until the timeout elapses (default 60s).

### Snapshot Manager

Before each major step, the agent serializes its state to `./snapshots/` as JSON. On repair success, execution can resume from the last known good state.

### Repair Playbook

`src/repair/repairPlaybook.json` maps error patterns to suggested fixes. Entries with `autoApply: true` are applied automatically on HIGH confidence. Current patterns:

- Out-of-memory → increase Node.js heap
- API timeout/rate-limit → exponential backoff
- Malformed LLM JSON → strip markdown fences before parsing
- Missing environment variable → surface to user
- Sandbox process crash → restart sandbox subprocess
- Premature close (undici) → retry with fresh connection

### Repair Agent

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

### Incident Logging

All repair attempts write structured JSON incident reports to `./logs/incidents/`. Successful repairs auto-generate a new playbook entry appended to `repairPlaybook.json`.

## Development

```sh
npm install
npm run build
```

Development entrypoints:

- `npm run build` compiles TypeScript to `dist/`
- `npm run dev` runs the CLI through `ts-node`
- `npm start` runs the compiled CLI from `dist/index.js`

## Notes

- This package uses NodeNext module resolution and ESM imports.
- When authoring internal TypeScript files, imports use `.js` extensions.
- 9router native endpoints live under `/api/*`; model completion traffic goes through `/v1/*`.
