# 9rh — Coding Agent Harness for 9router

A lightweight, streaming coding agent that routes all LLM calls through [9router](https://github.com/decolua/9router). Run AI coding tasks for free using Kiro AI, OpenCode Free, or any of 40+ providers — with automatic fallback and 20-40% token savings via RTK.

## Zero-Setup Install

```sh
npm install && npm run build
```

9rh auto-detects whether 9router is running. If not found, it automatically installs and starts 9router for you — no manual setup required.

## Prerequisites

1. Install [9router](https://github.com/decolua/9router) (or let 9rh do it for you):
   ```sh
   npm install -g 9router
   9router
   ```
2. Open the dashboard at `http://localhost:20128` and connect at least one provider (e.g. **Kiro AI** for free Claude).

## Usage

### One-shot task

```sh
node dist/index.js "list all TypeScript files in src/"
node dist/index.js "read package.json and summarize the dependencies"
node dist/index.js "write a hello world Express server to src/server.ts"
```

### With options

```sh
node dist/index.js \
  --model kr/claude-sonnet-4.5 \
  --url http://localhost:20128/v1 \
  --dir /path/to/my/project \
  "refactor the auth module to use JWT"
```

### Interactive REPL

```sh
node dist/index.js --repl
```

### Via environment variables

```sh
export NINE_ROUTER_URL=http://localhost:20128/v1
export NINE_ROUTER_KEY=your-key-from-dashboard
export NINE_ROUTER_MODEL=kr/claude-sonnet-4.5

node dist/index.js "fix the failing tests"
```

## Options

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `-m, --model` | `NINE_ROUTER_MODEL` | `kr/claude-sonnet-4.5` | Model identifier |
| `-u, --url` | `NINE_ROUTER_URL` | `http://localhost:20128/v1` | 9router API URL |
| `-k, --key` | `NINE_ROUTER_KEY` | `9router` | API key from dashboard |
| `-d, --dir` | — | `process.cwd()` | Working directory |
| `-i, --max-iter` | — | `30` | Max agent loop iterations |
| `--repl` | — | — | Interactive mode |
| `--no-color` | — | — | Disable colored output |
| `--doctor` | — | — | Run pre-flight diagnostics and exit |

## Pre-Flight Diagnostics

Run `--doctor` to check your setup before running a task:

```sh
node dist/index.js --doctor
```

This verifies:
- 9router server is reachable
- API keys are configured
- At least one provider is connected
- Models are available

## Slash Commands (REPL)

| Command | Description |
|---------|-------------|
| `/doctor` | Diagnose 9router connectivity and configuration |
| `/setup` | Install and start 9router if not already running |
| `/switch <model>` | Switch active model |
| `/dir [path]` | Show or change working directory |
| `/providers` | List configured provider connections |
| `/combos` | List model combo fallback chains |
| `/keys` | List 9router API keys |
| `/status` | 9router health, version, and update info |
| `/clear` | Clear screen |

## Available Tools

The agent has access to these tools:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with optional line range |
| `write_file` | Write/create files |
| `run_bash` | Execute shell commands (build, test, grep…) |
| `list_files` | List directory contents, optionally recursive |
| `search_files` | Grep for patterns across files |

## Model Names (9router format)

| Prefix | Provider |
|--------|----------|
| `kr/` | Kiro AI (free) |
| `oc/` | OpenCode Free (no auth) |
| `cc/` | Claude Code (subscription) |
| `cx/` | Codex (subscription) |
| `glm/` | GLM (cheap) |
| `mm/` | MiniMax (cheap) |

Example models: `kr/claude-sonnet-4.5`, `cc/claude-opus-4-6`, `oc/auto`, `glm/glm-5.1`

## Programmatic API

```ts
import { Agent } from "./src/agent.js";

const agent = new Agent({
  baseURL: "http://localhost:20128/v1",
  apiKey: "9router",
  model: "kr/claude-sonnet-4.5",
  maxIterations: 20,
  workDir: process.cwd(),
  onEvent: (event) => {
    if (event.type === "thinking") process.stdout.write(event.text);
    if (event.type === "tool_call") console.log(`→ ${event.name}`, event.args);
  },
});

const result = await agent.run("Create a fibonacci function in src/math.ts");
```