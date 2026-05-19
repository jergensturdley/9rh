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
  tools.ts    — 5 sandboxed tools (read_file, write_file, run_bash, list_files, search_files)
  commands.ts — 9router-native slash commands + SessionState interface
  index.ts    — CLI (commander), REPL, task runner
  main.ts     — programmatic exports for library use
```

## Tool Sandbox

Tools may **not** escape `workDir`. The `sandboxPath()` function resolves relative paths against `workDir` and throws if the normalized result leaves the sandbox. Do not disable or bypass this.

`run_bash` uses `execFile("sh", ["-c", cmd])` (no shell wrapper) — shell operators like `&&`, `|`, `>` are passed to `sh -c`, which is intentional.

## Slash Commands

REPL intercepts lines starting with `/` **before** sending to the agent. `executeSlashCommand(line, state)` returns `null` for non-slash input, or a string to print.

`SessionState` is passed by **reference** — mutations from `/switch <model>` and `/dir <path>` persist for all subsequent agent runs and slash commands in the same REPL session. `SessionState.routerCache` is also session-scoped and can be reset with `clearRouterConfigCache(state)` or the `/refresh` command.

## API Response Safety

`fetchJSON()` returns `unknown`. All handlers use `toArray<T>()` helper (guards with `Array.isArray`) before iterating. Malformed API payloads are handled gracefully — they produce empty-state messages, not crashes.

## Auto-Start

9rh auto-detects whether 9router is running. If not found on startup, it automatically:
1. Installs 9router globally via `npm install -g 9router` (or uses existing `npx`)
2. Starts 9router as a background daemon (`--no-browser`)
3. Waits up to 30s for the server to become reachable
4. Uses the first available API key from the server

The `/setup` slash command performs the same check/start from within a REPL session.

## Key Commands

| Command | Effect |
|---------|--------|
| `/doctor` | Run pre-flight diagnostics (connectivity, keys, providers, models) |
| `/setup` | Install and start 9router if not already running |
| `/switch <model>` | Changes active model for subsequent tasks |
| `/dir [path]` | Shows or changes working directory (validated via `fs.stat`) |
| `/providers` | Lists 9router provider connections |
| `/combos` | Lists model combo fallback chains |
| `/keys` | Lists 9router API keys (preview only) |
| `/router` | Shows a cached 9router configuration summary (models, providers, combos, keys, cache state) |
| `/refresh` | Clears and reloads cached 9router configuration for slash commands and pickers |
| `/clear` | Clears terminal screen |

