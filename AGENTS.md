# 9rh Agent Guide

## Build

```sh
npm run build   # tsc → dist/
```

`npm run dev` uses `ts-node` directly (no build needed for development).

## 9router Dependency

9rh routes all LLM calls through [9router](https://github.com/decolua/9router). 9router must be running before 9rh works.

```sh
9router   # starts server at http://localhost:20128
```

9router's API has two surfaces:
- **OpenAI-compatible** at `/v1/*` — used by the agent for completions and model catalog reads
- **Native REST** at `/api/*` — used by slash commands (`/status`, `/providers`, `/combos`, `/keys`, `/router`)

`baseURL` in config includes `/v1`; the slash command module strips it via `base()` to reach `/api/*`.

Slash-command reads of 9router configuration are cached briefly on `SessionState.routerCache` to make repeated menu/picker interactions cheap. Use `/refresh` after changing providers, keys, combos, or model configuration in the 9router dashboard.

## TypeScript

- `"type": "module"` — use `.js` extensions in imports even when authoring `.ts`
- `moduleResolution: NodeNext` — imports map to `dist/*.js`
- Strict mode enabled; no `as any` suppression

## Project Structure

```
src/
  agent.ts    — streaming ReAct loop (OpenAI client, tool execution, iteration management)
  tools.ts    — sandboxed tools (read_file, write_file, run_bash, list_files, search_files, codegraph_*)
  commands.ts — 9router-native slash commands + SessionState interface
  index.ts    — CLI (commander), REPL, task runner
  main.ts     — programmatic exports for library use
```

## Tool Sandbox

Tools may **not** escape `workDir`. The `sandboxPath()` function resolves relative paths against `workDir` and throws if the normalized result leaves the sandbox. Do not disable or bypass this.

`run_bash` uses `execFile("sh", ["-c", cmd])` (no shell wrapper) — shell operators like `&&`, `|`, `>` are passed to `sh -c`, which is intentional.

## CodeGraph

This repo has CodeGraph initialized at `.codegraph/`. Prefer semantic CodeGraph lookups before broad text scans when answering architecture/discovery questions.

For 9rh, use the native tools:
- `codegraph_context` for task-focused repository context
- `codegraph_search` for symbols by name/kind
- `codegraph_files` for indexed file structure
- `codegraph_affected` to find tests affected by changed source files
- `codegraph_status` to inspect index health

For Jcode or other agents without native 9rh tools, use the CLI equivalents from the repo root:
```sh
codegraph context -p . "task or architecture question"
codegraph query -p . "SymbolName"
codegraph files -p . --format tree --max-depth 3
codegraph affected -p . path/to/changed-file.ts
codegraph status .
```

If results look stale after edits, run `codegraph sync .` before querying. Do not rely solely on CodeGraph before modifying files: re-open the target file section directly before editing.

## Slash Commands

REPL intercepts lines starting with `/` **before** sending to the agent. `executeSlashCommand(line, state)` returns `null` for non-slash input, or a string to print.

`SessionState` is passed by **reference** — mutations from `/switch <model>` and `/dir <path>` persist for all subsequent agent runs and slash commands in the same REPL session. `SessionState.routerCache` is also session-scoped and can be reset with `clearRouterConfigCache(state)` or the `/refresh` command.

## API Response Safety

`fetchJSON()` returns `unknown`. All handlers use `toArray<T>()` helper (guards with `Array.isArray`) before iterating. Malformed API payloads are handled gracefully — they produce empty-state messages, not crashes.

## 9router Setup

9rh is 9router-native: it expects 9router to be installed, running, and configured with at least one provider/API key. Prefer documenting the explicit setup flow (`npm install -g 9router`, then `9router`, then configure the dashboard). `/setup` may attempt a best-effort setup, but docs should not imply fully headless configuration because most first-time users complete provider setup in the browser.

## Key Commands

| Command | Effect |
|---------|--------|
| `/doctor` | Run pre-flight diagnostics (connectivity, keys, providers, models) |
| `/setup` | Install and start 9router if not already running |
| `/sandbox` | Shows command sandbox/isolation backend status and direct fallback warnings |
| `/switch <model>` | Changes active model for subsequent tasks |
| `/dir [path]` | Shows or changes working directory (validated via `fs.stat`) |
| `/providers` | Lists 9router provider connections |
| `/combos` | Lists model combo fallback chains |
| `/keys` | Lists 9router API keys (preview only) |
| `/router` | Shows a cached 9router configuration summary (models, providers, combos, keys, cache state) |
| `/refresh` | Clears and reloads cached 9router configuration for slash commands and pickers |
| `/clear` | Clears terminal screen |
