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

<!-- CODEGRAPH_START -->
## CodeGraph

This project has a CodeGraph MCP server (`codegraph_*` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### Tool selection by intent

| Question | Tool |
|---|---|
| "Where is X defined?" / "Find symbol named X" | `codegraph_search` |
| "What's the deal with this task / area?" | `codegraph_context` (PRIMARY — composes search + node + callers + callees in one call) |
| "What calls function Y?" | `codegraph_callers` |
| "What does Y call?" | `codegraph_callees` |
| "What would break if I changed Z?" | `codegraph_impact` |
| "Show me Y's signature / source / docstring" | `codegraph_node` |
| "See several related symbols' source at once" | `codegraph_explore` |
| "What files exist under path/" | `codegraph_files` |
| "Is the index healthy?" | `codegraph_status` |

### Rules of thumb

- **Answer directly — don't delegate exploration.** For "how does X work" / architecture / trace questions, answer with 2-3 codegraph calls: `codegraph_context` first, then ONE `codegraph_explore` for the source of the symbols it surfaces. Codegraph IS the pre-built index, so spawning a separate file-reading sub-task/agent — or running a grep + read loop — repeats work codegraph already did and costs more for the same answer.
- **Trust codegraph results.** They come from a full AST parse. Do NOT re-verify them with grep — that's slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name. `codegraph_search` is faster and returns kind + location + signature in one call.
- **Don't chain `codegraph_search` + `codegraph_node`** when you just want context — `codegraph_context` is one call.
- **Don't loop `codegraph_node` over many symbols** — one `codegraph_explore` call returns several symbols' source grouped in a single capped call, while each separate node/Read call re-reads the whole context and costs far more.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.
- Do not rely solely on CodeGraph before modifying files: re-open the target file section directly before editing.

### Common chains

- **Onboarding**: `codegraph_context` first. If still unclear, `codegraph_explore` for breadth, then `codegraph_node` on specific symbols.
- **Refactor planning**: `codegraph_search` → `codegraph_callers` → `codegraph_impact`. The blast-radius answer comes from impact, not from walking callers manually.
- **Debugging a regression**: `codegraph_callers` of the suspected symbol; widen with `codegraph_impact` if an unexpected call appears.

### 9rh CLI equivalents

For Jcode or other agents without native 9rh tools, use the CLI equivalents from the repo root:
```sh
codegraph context -p . "task or architecture question"
codegraph query -p . "SymbolName"
codegraph files -p . --format tree --max-depth 3
codegraph affected -p . path/to/changed-file.ts
codegraph status .
```

### If `.codegraph/` doesn't exist

The MCP server returns "not initialized." Ask the user: *"I notice this project doesn't have CodeGraph initialized. Want me to run `codegraph init -i` to build the index?"*
<!-- CODEGRAPH_END -->

<!-- SUPERPOWERS_START -->
## Superpowers

This project has [Superpowers](https://github.com/obra/superpowers) installed — a skills-based software development methodology. Skills live in `skills/<name>/SKILL.md` and are loaded by reading the file.

### Rule: check skills before acting

Before any task (even a "simple question"), check if a skill applies. If there's even a 1% chance, read the skill file and follow it. Skills are mandatory workflows, not suggestions.

### Skill loading

This harness has no `Skill` tool. Load skills by reading the file:

```
skills/<skill-name>/SKILL.md
```

### Available skills

| Skill | When to invoke | Path |
|-------|----------------|------|
| **using-superpowers** | Session start / before any task | `skills/using-superpowers/SKILL.md` |
| **brainstorming** | Before writing code or making design decisions | `skills/brainstorming/SKILL.md` |
| **writing-plans** | After design approval, before implementation | `skills/writing-plans/SKILL.md` |
| **subagent-driven-development** | When executing a plan with multiple tasks | `skills/subagent-driven-development/SKILL.md` |
| **executing-plans** | When executing a plan solo or with checkpoints | `skills/executing-plans/SKILL.md` |
| **test-driven-development** | During implementation — RED-GREEN-REFACTOR | `skills/test-driven-development/SKILL.md` |
| **systematic-debugging** | When debugging a bug or regression | `skills/systematic-debugging/SKILL.md` |
| **requesting-code-review** | Before requesting code review | `skills/requesting-code-review/SKILL.md` |
| **receiving-code-review** | When responding to code review feedback | `skills/receiving-code-review/SKILL.md` |
| **using-git-worktrees** | After design approval, before starting work | `skills/using-git-worktrees/SKILL.md` |
| **finishing-a-development-branch** | When tasks are complete | `skills/finishing-a-development-branch/SKILL.md` |
| **dispatching-parallel-agents** | When tasks can run concurrently | `skills/dispatching-parallel-agents/SKILL.md` |
| **verification-before-completion** | Before declaring any task done | `skills/verification-before-completion/SKILL.md` |
| **writing-skills** | When creating or modifying skills | `skills/writing-skills/SKILL.md` |

### Workflow

1. **Brainstorm** → clarify what the user actually wants before writing code
2. **Plan** → break work into bite-sized tasks with exact file paths and verification steps
3. **Execute** → subagent-driven or batch execution with human checkpoints
4. **TDD** → write failing test first, then minimal code to pass
5. **Review** → spec compliance check, then code quality review
6. **Finish** → verify tests pass, present merge/PR/keep/discard options

### Priority

1. User's explicit instructions — highest priority
2. Superpowers skills — override default system behavior where they conflict
3. Default system prompt — lowest priority

If this AGENTS.md says "don't use TDD" and a skill says "always use TDD," follow the user's instructions. The user is in control.
<!-- SUPERPOWERS_END -->

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
| `/help` | Show all slash commands |
| `/run` | Send queued messages to the agent |
| `/queue` | Show queued messages (`/queue clear` to discard) |
| `/done` | Interrupt hint |
| `/doctor` | Run pre-flight diagnostics (connectivity, keys, providers, models) |
| `/setup` | Install and start 9router if not already running |
| `/sandbox` | Shows command sandbox/isolation backend status and direct fallback warnings |
| `/status` | 9router health, version, and update info |
| `/models [filter]` | List available models (with optional filter) |
| `/switch <model>` | Changes active model for subsequent tasks (interactive picker if no exact match) |
| `/default-model <model>` | Persist startup model for future 9rh runs |
| `/dir [path]` | Shows or changes working directory (validated via `fs.stat`) |
| `/providers` | Lists 9router provider connections |
| `/combos` | Lists model combo fallback chains |
| `/keys` | Lists 9router API keys (preview only) |
| `/router` | Shows a cached 9router configuration summary (models, providers, combos, keys, cache state) |
| `/refresh` | Clears and reloads cached 9router configuration for slash commands and pickers |
| `/clear` | Clears terminal screen |
