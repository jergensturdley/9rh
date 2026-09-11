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
| `--parallel-tools <n>` | `NINE_RH_PARALLEL_TOOLS` | `4` | Max tool calls executed concurrently per turn; `1` = sequential (previous behavior). Invalid values fall back to the default |
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

## Parallelism & performance

Several stages of a run use bounded concurrency:

- **Tool calls within a turn.** With `--parallel-tools <n>` (default `4`), the tool calls requested in a single assistant step execute up to `n` at a time. Only tools classified as read-only run truly concurrently; everything else (including `run_bash`, `write_file`, and anything with side effects) is serialized through a shared mutation lock. Tool results are always appended in the original call order regardless of completion order, so the conversation transcript is identical to sequential execution.
- **Workdir snapshots.** Before and after `run_bash`, 9rh snapshots the working directory. In git repositories it uses `git status --porcelain -z` to track only the dirty set instead of walking every file. Note: files ignored by git are not tracked by the fast path, so modifications to ignored files are not reported as file changes.
- **Repo indexer.** Repository discovery, hashing, and sizing run as a single async traversal per repo with concurrent stat'ing, and repos are processed two at a time.

What stays sequential: the model loop itself (one assistant step at a time), mutating tool calls (shared lock), and report/ledger writes. Set `--parallel-tools 1` to restore fully sequential tool execution.

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
| `~/.9rh/desktop.json` | Desktop app state: recent workdirs, last model and backend choice, window bounds, preferences |

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

## Desktop app

`desktop/` holds an Electron app with two jobs: run 9rh agent sessions against local repositories with a graphical workbench, and administer the local 9router from the same window. The Electron main process imports the `9rh` package for every engine (the agent, the orchestrator, the session ledger, rewind, the flight recorder, backend detection, config, skills, sandbox status), and the renderer is a React app that only sees typed data over IPC. There is no second agent loop, ledger, or router client, and agent behavior, tool sandboxing, and the CLI are unchanged. The folder has its own `package.json`, tests, and [README](../desktop/README.md).

### Prerequisites

- Node 22.12 or newer. Electron 44 and Vite 7 require it; the CLI alone still runs on Node 18.
- The root package built. `desktop/package.json` depends on `"9rh": "file:.."`, so `desktop/node_modules/9rh` links to the repository root and resolves to `dist/main.js`. Run `npm install && npm run build` at the root before anything in `desktop/`.
- The Electron binary. If `node_modules/electron/dist` is missing after `npm install` (seen with npm 11), run `node node_modules/electron/install.js` inside `desktop/`. `npm run dev`, `npm run preview`, and the smoke test all need it.
- 9router at `http://127.0.0.1:20128` for router-mode sessions and the Router page. Direct-mode sessions work without it. `NINE_ROUTER_URL` moves the router base for sessions and the console; the embedded dashboard only allows the default local address.

### Running and building

All commands run inside `desktop/`.

| Command | Effect |
|---------|--------|
| `npm install` | Installs Electron, React, electron-vite, Vitest, electron-builder, and the `9rh` link |
| `npm run dev` | Electron against the Vite dev server: the renderer hot-reloads, main and preload rebuild on change |
| `npm run build` | Builds main (ESM), preload, and renderer into `desktop/out/` |
| `npm run preview` | Builds, then launches the built app |
| `npm run typecheck` | `tsc --noEmit` for the Node side (main, preload, shared) and the web side (renderer, shared) |
| `npm test` | Vitest over `src/**/*.test.ts` in a Node environment; reducers and services only, no DOM |
| `npm run package` | Builds, then runs `electron-builder --dir` (see [Packaging stub](#packaging-stub)) |

The window is single-instance; a second launch focuses the first. Window bounds persist in `desktop.json`. The Electron settings behind the window are listed under [Security posture](#security-posture).

### Sessions and the workbench

The Agent page has three columns: the sessions sidebar, the transcript with a toolbar above and the composer below, and the HUD on the right.

**Creating a session.** The New session dialog asks for a working directory (native folder picker, or one of the recent directories), an optional model (typed, or picked from the router catalog once a connection test succeeds), a backend mode (`auto`, `router`, or `direct`; direct mode takes a preset, a base URL, and an API key that stays in memory), team mode, and advanced knobs (max iterations, parallel tools, allow skill install, keep reports). "Test connection" runs the same six-layer `detectBackend` the CLI uses and shows what it would connect to, including warnings. Creation validates the directory, resolves the backend, and picks the default model the way the CLI does (`NINE_ROUTER_MODEL`, then the `config.json` defaults with provider prefixing); a direct backend with nothing configured asks the endpoint for its first model. Backend warnings stay attached to the session and show above the transcript.

**Session hosting.** Each session is a `SessionHost` in the main process with its own `SessionLedger`, a monotonic event sequence, and a ring buffer of the last 5000 events, so a renderer reload replays history instead of losing it. Sessions run side by side; the sidebar shows a status dot (idle, running, waiting for you, error), the directory name, the model, and elapsed time while a turn runs. Model and working directory can be changed while the session is idle.

**Running a task.** The composer takes multi-line input: Enter runs, Shift+Enter adds a line, Cmd/Ctrl+Enter also runs, and `/` in an empty box opens the command palette. Tasks that look structured get the same "run as a team?" prompt as the CLI (`shouldSuggestTeam`), with the streaming agent as the default. A turn goes through `compressUserInput` and `ledger.beginTurn`, then either `new Agent(...)` or the orchestrator pipeline (the same wiring as `runTeamPipeline` in the CLI, with orchestrator events wrapped as `team` events). Every `AgentEvent` is folded into the ledger first, then pushed to the renderer with the session id, a sequence number, and a timestamp. Two desktop-only events, `turn_start` and `turn_end`, bracket each turn so the transcript can show the task text and close a turn that ended without `done` or `error`, which is what an abort looks like.

**Transcript.** One block per event kind: the task text; the thinking stream coalesced into one block (quiet mode collapses it to its first line with a toggle); tool cards that pair the call with its result in place and show the name, a target summary, duration, a six-line output preview that expands, the arguments behind a disclosure, and a copy button; one-line markers for iteration, continuation, model switch, compaction, repair, escalation, circuit open, incident, spec plan, branch, sandbox health, step inspect, and partial output; team role sections; and a receipts card at the end of every turn. The view follows the bottom until you scroll up, then offers a "jump to latest" pill.

**Toolbar.** The goal (pulsing while active), a model chip that opens the picker, `team` and `quiet` toggles, Stop and Abort while running, Brief, Skills, Rewind, Report, a status badge, and a HUD toggle. Stop is graceful (`Agent.requestStop`: the current tool call finishes, then the loop stops); Abort cancels the in-flight stream (`Agent.abort`). In team mode the orchestrator has no abort hook, so Abort marks the outcome and the pipeline runs to completion.

**HUD.** GOAL; NOW (activity, current tool and target, iteration, elapsed, thinking size, continuation round, turn tokens); SESSION (turns, files, commands, tokens, model, backend, and a sandbox chip reading `seatbelt` or `none` from `getSandboxStatus`); LAST (previous outcome); TEAM lanes while a pipeline runs (role, status, elapsed, tokens; a pure port of the TUI's `applyTeamEvent`); and the recent tools list. The HUD is a pure reduction of the event stream that mirrors the TUI's dashboard state.

**Brief and Skills.** Brief shows the `/brief` and `/usage` views together: goal, totals, one row per turn (status, duration, tokens in, out, and total, files, commands, assumptions), and a per-role token table under team turns. Token counts only, as in the CLI. Skills lists `discoverSkills(workDir)` with name, source, description, and path; Refresh re-runs discovery.

**Command palette.** Cmd/Ctrl+K (or `/` in an empty composer) opens it: new session, switch session, brief, quiet and team toggles, change model, rewind, skills, open last report, stop and abort while running, start, stop, and restart 9router, and go to page. Filtering uses the CLI completer's fuzzy scoring. Cmd/Ctrl+1 to 4 switch pages directly.

**Settings page.** Four sections, each with its own Save and an inline saved or error note. Defaults: default model, default provider, backend (`auto`, `router`, `direct`), report path, and keep reports, written to `~/.9rh/config.json` through `updateUserConfig` and shared with the CLI. App: `quietByDefault`, `routerPollMs`, and the recent workdirs list with Remove all, in `~/.9rh/desktop.json`. Backend check: the same mode, preset, URL, and key form as the new-session dialog, run through `detectBackend`; it shows the backend name, reachability, base URL, and warnings, and saves nothing. About: app version, platform, and the 9rh home.

### Human in the loop

The engine's `onAskUser` and `onToolApproval` hooks become a pending request on the session (status `waiting`) and a modal in the renderer.

- Ask-user modal: the question, the options as a list with the recommended default first (arrow keys move, Enter picks), a free-text field when the agent allows it, and Dismiss. Dismiss and Esc send an empty answer, which is what the TUI does on Esc.
- Approval modal: the tool name, its risk level next to the session threshold, the arguments as pretty-printed JSON, an optional reason, and Approve and Reject. Esc rejects. A reject without a reason is recorded as "rejected by user".

One request is pending at a time (the agent serializes approval-gated calls behind its mutation lock). Abort, session removal, and app shutdown dismiss a pending request the same way (empty answer, or approval refused with reason "aborted"), so `Agent.run` always resolves.

### Receipts, rewind, and replay

**Receipts.** Every turn closes with a card built from the ledger's `TurnDigest`: status, duration, tokens, steps, files with net +/- line counts and a Diff button, commands with pass or fail, tool counts, assumptions, and the report path, followed by the model's prose. The raw before/after file records stay in the main process; the card carries the diffable paths and the Diff button fetches a unified line diff on demand. The diff's added and removed counts use the same rule as the ledger, and files above 4000 lines on either side fall back to a whole-file replace. The report link opens the HTML run report in an in-app viewer (a fully sandboxed iframe, and the main process only serves `.html` files under the 9rh home) with an "Open externally" button.

**Rewind.** The Rewind dialog lists completed turns that touched files, previews the plan from `planRewind` over the ledger (files to restore, files to delete because a rewound turn created them, and skips with reasons), and applies it with `applyRewind`. The safety rules are those of `/rewind`: truncated records and files changed since are skipped, paths outside the working directory are refused, and conversation history is untouched. Rewind is available only while the session is idle.

**Replay.** The Replays page lists `~/.9rh/runs` (run id, age, event count, end reason) and plays one log through the engine's `renderEventLog` at 1x, 2x (default), 5x, or 10x into a read-only transcript built by the same reducer as live sessions. Nothing executes and no model is called; Stop ends playback early, and starting another replay aborts the current one. Desktop agent turns record to `~/.9rh/runs` like CLI runs, so a turn you just ran appears in the list after Refresh.

### 9router console

The Router page starts with a status card and has eight tabs. Only the visible tab is mounted, so each panel refreshes on demand (the Refresh button) and on a 15 s poll while it is visible and the window is not hidden. Errors render inline in the panel that requested them, and destructive actions confirm in-app before calling the API.

| Tab | Shows | Actions |
|-----|-------|---------|
| Status card | Reachability, version and an update badge, auth mode and whether login is required, the tunnel URL with a Copy button | Start (`ensureRouter`: probe, install if missing, spawn, wait), Stop (`POST /api/shutdown`, then wait up to 10 s for the port to close), Restart, open the dashboard in the browser |
| Providers | Connections sorted by priority: name, provider, auth type, priority, active flag, test status with the last error, last used; a filter box | Test (the result opens as JSON), toggle active, Delete |
| Combos | Named fallback chains: name, kind, model count, the first models | New, Edit (name, ordered model list with Up, Down, and Remove, and a search over the router catalog to add models), Delete |
| Keys | API keys masked by default, with Reveal and Copy, active flag, created time | New key (the key opens in a copy dialog and stays in the list), Delete |
| Models | The catalog grouped by provider with availability badges and capability chips (vision, reasoning, search, context window, max output); search | Use in session (sets the active session's model while it is idle) |
| Usage | Totals (requests, prompt, completion, and cached tokens, cost as 9router reports it), a token bar chart over the last periods, a per-provider table, and the recent request log | Live totals from the router's server-sent events stream while the tab is open, reconnecting with backoff |
| Update | Every 9router install found on the machine with its version, npm prefix, and whether PATH resolves it; the version the daemon reports; the latest published version; a plain-language diagnosis when they disagree | Update (refresh the install on PATH, restart, verify), Force update (refresh every install, stop every 9router process, restart, verify), Recheck; a live log of the npm and restart output |
| Settings | A read-only summary of `GET /api/settings`: login and API key requirements, auth mode, tunnel, combo and fallback strategies, request logs, observability, MITM, outbound proxy, and feature flags | None; edit these in the dashboard |
| Dashboard | The stock 9router dashboard in an Electron `<webview>` | Reload, open externally |

Every call goes through `desktop/src/main/routerClient.ts`, the only module that knows 9router URLs. Reads time out after 5 s and mutations after 30 s; an unreachable router is reported as a panel error, never as a crash. The session model picker reads `/v1/models` through the session's backend; the console reads `/api/models`.

### Updating 9router

9router ships its own updater, and it can leave a machine pinned to an old version in three ways. Its update runs `npm i -g 9router@latest`, which writes into npm's global prefix; when the `9router` that PATH resolves lives in a different prefix, the update lands in a copy that never runs. Its relaunch starts the same `cli.js` path the daemon was started from, so a stale path stays stale. And a daemon that is never restarted keeps serving the old build even after the files change.

The Update tab addresses all three. It reads every `9router` on PATH (`which -a`, resolved through symlinks to the package directory) plus the install under `npm prefix -g`, reads each `package.json` version, finds the running daemon in the process list, and asks the npm registry for the latest version. When those disagree it says so in plain sentences, for example that npm's global prefix holds a newer copy than the one PATH resolves.

| Mode | What it does |
|------|--------------|
| Update | `npm i -g 9router@latest --prefer-online --prefix <prefix of the install PATH resolves>`, a clean shutdown over `POST /api/shutdown`, a start through `ensureRouter`, then a check that the daemon reports the version now on disk |
| Force update | The same install for every install found, with `--force`, and it keeps going when one prefix fails; then a shutdown followed by SIGTERM and, if needed, SIGKILL for every remaining 9router process; then start and verify |

Both modes stream their output to the panel and both verify the result: if the daemon comes back on a different version than the copy on PATH, if any install failed to update, or if the daemon is still behind the published version, the update is reported as failed with the reason. Process matching only accepts a node process running `9router/cli.js` or a path inside a `9router` package directory, so editors, greps, and this app are never killed. Nothing here runs as root; a prefix that needs elevated permissions fails with npm's own error.

The command palette has "Update 9router", which opens this tab rather than updating silently.

Because a Dock launch inherits launchd's minimal `PATH` (no npm, no `~/.local/bin`), the app asks your login shell for its `PATH` once at startup and merges it in front of its own. Without that, both the updater and `ensureRouter` would be unable to find npm or 9router.

### Authentication to 9router

Two mechanisms, the same ones the CLI uses:

- Native `/api/*` calls carry the `x-9r-cli-token` header from `getCliToken()`: a sha256 over the machine id, a salt, and `~/.9router/auth/cli-secret`. It authorizes providers, combos, keys, models, settings, version, usage, and tunnel status. When no token can be derived, the client falls back to a bearer key, the first key stored in 9router's database (`readFirstApiKey`) or the default `9router`.
- The dashboard does not honor that header; it uses a cookie login. The Dashboard tab embeds `http://127.0.0.1:20128/dashboard` in a `<webview>` with the `persist:9router` partition, so you type your 9router password into 9router's own page and the login cookie survives app restarts. The app never sees the password. The guest-page rules are under [Security posture](#security-posture).

Model traffic from sessions uses the session backend's bearer key on `/v1/*`, exactly as the CLI does.

### Where state is stored

| Path | Contents |
|------|----------|
| `~/.9rh/desktop.json` | Recent working directories (last 10), last model, last backend choice (mode, URLs, preset; never the API key), window bounds, and the preferences `quietByDefault` and `routerPollMs` |
| `~/.9rh/config.json` | CLI defaults edited from Settings: default model and provider, backend, report path, `keepReports` |
| `~/.9rh/runs/` | Flight-recorder logs; every desktop agent turn writes one and the Replays page reads them |
| `~/.9rh/last-run.html`, `~/.9rh/reports/` | Run reports opened by the in-app viewer |

`NINE_RH_HOME` relocates everything, as for the CLI. A missing or corrupt `desktop.json` reads as defaults. Direct-mode API keys live in memory for the life of a session and are never written to disk. Settings > App saves `quietByDefault` and `routerPollMs`; in this build the router panels poll at 15 s and new sessions start with quiet off regardless, so treat those two fields as stored preferences rather than live switches.

### Security posture

- The window runs with `contextIsolation` on and `nodeIntegration` off. `sandbox` is off only because the preload is an ES module; `webviewTag` is on solely for the Dashboard tab.
- The renderer sees one object, `window.ninerh`, built by the preload from the channel table in `src/shared/ipc.ts`. It imports nothing from `9rh` or Node at runtime; every handler checks its arguments in the main process and resolves to `{ ok, value }` or `{ ok, error }`, so nothing throws across the bridge.
- The Dashboard `<webview>` may load only `http://127.0.0.1:20128` or `http://localhost:20128` in the `persist:9router` partition. The main process cancels any other guest page and strips preload and Node integration from the one it allows. The renderer's content security policy is `default-src 'self'` with frames allowed from the local router only.
- Links open in the system browser: a `window.open` or `target="_blank"` for an `http` or `https` URL goes to the default browser and the in-app window is denied. `openExternal` accepts `http`, `https`, and `file` URLs only; `openPath` accepts absolute paths only.
- The run report viewer serves only `.html` files under the 9rh home and renders them in a fully sandboxed `<iframe>` (no scripts, no same-origin access). Replays accept only `.jsonl` files under `~/.9rh/runs`.
- Direct-mode API keys stay in memory for the life of a session; `desktop.json` stores the backend choice without them.

### Smoke test

`NINERH_SMOKE=1` turns a launch into a headless check. The main process points `NINE_RH_HOME` at a fresh temporary directory so the real `~/.9rh` is never touched, opens the window hidden, waits for the renderer to load, verifies that `window.ninerh` is an object (the preload bridge came up), and calls the `sessions:list` handler. It prints `SMOKE OK` and exits 0, or `SMOKE FAIL: <reason>` and exits 1, with a 20 s timeout.

```sh
cd desktop
npm run build
NINERH_SMOKE=1 ./node_modules/.bin/electron out/main/index.js   # prints SMOKE OK
```

### Packaging stub

`desktop/electron-builder.yml` is deliberately small: app id `dev.9rh.desktop`, product name `9rh`, `dir` targets for macOS, Linux, and Windows, output under `desktop/release/`, and an `asarUnpack` rule for the engine's `dist/` (electron-builder follows the `file:` link and bundles it with its runtime dependencies). `npm run package` runs the build and then `electron-builder --dir`. There is no signing, notarization, installer, or auto-update.

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
- `Orchestrator`: the multi-role team pipeline, with its config, event, and result types
- `SessionLedger`, `buildTurnDigest`: the per-session ledger and the receipts digest (`LedgerView`, `LedgerTurn`, `TurnDigest`, `DigestFileEntry`, `DigestCommandEntry`, `StoredToolResult`)
- `planRewind`, `applyRewind`: turn-level workdir undo (`RewindPlan`, `RewindAction`, `RewindSkip`, `RewindResult`)
- `listRunLogs`, `readEventLog`, `renderEventLog`, `mapReplayEvent`: flight-recorder listing and paced playback (`RunLogInfo`, `ReplayEvent`, `ReplayRenderOptions`)
- `readUserConfig`, `updateUserConfig`, `resolveConfiguredModel`, `configPath`, `ninerhHome`, `ninerhDir`: `~/.9rh/config.json` and the app home (`UserConfig`, `SandboxBackend`)
- `getCliToken`, `readFirstApiKey`: 9router native-API auth, the `x-9r-cli-token` header and the stored bearer key
- `PROVIDER_PRESETS`, `getProviderPreset`, `listProviderPresetIds`: direct-mode provider presets (`ProviderPreset`)
- `AskUserRequest`, `AskUserResponse`, `ToolApprovalRequest`, `ToolApprovalDecision`, `ToolRiskLevel`, `resolveAskUserCall`: the human-in-the-loop types behind `onAskUser` and `onToolApproval`
- `compressUserInput`, `shouldSuggestTeam`: input compression and the team-suggestion gate
- `discoverSkills`: skill discovery over the user and workdir skill roots (`SkillManifestEntry`, `SkillSource`)
- `getSandboxStatus`: whether OS-level command sandboxing is available (`SandboxStatus`)
- `applyTeamEvent`: the TUI's pure TEAM-lane reducer (`TeamLane`, `TeamLaneEvent`)

The desktop app in `desktop/` is the reference embedder for these exports; see [Desktop app](#desktop-app).

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
