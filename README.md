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
| `-i, --max-iter <n>` | — | `30` | Maximum agent iterations |
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