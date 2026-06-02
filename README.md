# 9rh

9rh is a lightweight local coding-agent harness. It runs one-shot tasks, opens an interactive REPL, and provides sandbox-aware local repository tools. It talks to **9router** when you want combo chains and a dashboard, or **directly** to any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, LM Studio) when you want zero moving parts.

## Highlights

- **Local repo agent** — run coding tasks against a selected working directory.
- **Pluggable backends** — use 9router for combo chains, or talk straight to OpenAI / OpenRouter / Ollama / LM Studio. Auto-detected from your environment, overridable per-invocation.
- **Interactive REPL** — slash commands for models, providers, router status, sandbox status, working directory, setup, and diagnostics.
- **Sandbox-aware tools** — file operations are path-checked, symlinks are blocked for file reads/writes, and shell commands use macOS `sandbox-exec` when available with visible `/sandbox` status.
- **Spec, replay, and repair systems** — optional spec-driven task framing, live run visualization, replay logs, checkpoints, error taxonomy, and repair hooks.
- **Programmatic API** — import the core agent, tools, visualization, spec, replay, and sandbox primitives from the package.

## Quick start

### Option A: with 9router (default)

```sh
git clone https://github.com/jergensturdley/9rh.git
cd 9rh
npm install
npm run build

# In another terminal: install and start 9router
npm install -g 9router
9router
```

Then open the dashboard and connect at least one provider/API key:

```text
http://127.0.0.1:20128/dashboard
```

```sh
node dist/index.js --doctor
node dist/index.js "summarize this repository"
node dist/index.js --repl
```

### Option B: direct mode (no 9router)

Talk straight to any OpenAI-compatible service. No local proxy needed.

```sh
# OpenAI
export OPENAI_API_KEY=sk-…
node dist/index.js "summarize this repository"

# OpenRouter (uses the `--provider=openrouter` preset)
export OPENROUTER_API_KEY=sk-or-v1-…
node dist/index.js --provider=openrouter \
  --model anthropic/claude-3.5-sonnet \
  "summarize this repository"

# Local Ollama
node dist/index.js --provider=ollama --model llama3.1:70b "summarize this repository"
```

See [Backends](#backends) below for the full list and the auto-detection rules.

## Requirements

- Node.js 18+
- One of:
  - **[9router](https://github.com/decolua/9router)** running at `http://127.0.0.1:20128` (default), **or**
  - An **OpenAI-compatible endpoint** with an API key (OpenAI, OpenRouter, Ollama, LM Studio, etc.) when using `--provider` or `--backend=direct`

## Backends

9rh picks a backend at startup using a six-layer precedence:

1. `--backend=router|direct` flag (explicit override)
2. `NINE_ROUTER_BACKEND` env var
3. `~/.9rh/config.json` → `backend` setting
4. Env-var heuristic: `NINE_ROUTER_URL` set → router; `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` set without a router URL → direct
5. Reachability probe on `:20128`
6. Last-resort: try to auto-start 9router

For direct mode, `--provider=<name>` is a shortcut for the common cases:

| Provider | Base URL | API key from env |
|----------|----------|------------------|
| `--provider=openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `--provider=openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `--provider=ollama` | `http://127.0.0.1:11434/v1` | _(none)_ |
| `--provider=lmstudio` | `http://127.0.0.1:1234/v1` | _(none)_ |

For custom endpoints, pass `--direct-url` and `--direct-key` directly. The provider flag never overrides an explicit `--direct-url`.

Slash commands that depend on 9router's native `/api/*` endpoints (`/providers`, `/combos`, `/keys`, `/router`) are automatically disabled in direct mode with a friendly "requires 9router mode" message. `/models`, `/switch`, `/status`, `/doctor`, `/sandbox`, `/dir`, and `/help` all work in both modes.

## Common slash commands

| Command | Mode | Description |
|---------|------|-------------|
| `/models [filter]` | both | List available models |
| `/switch <model>` | both | Change the active model |
| `/status` | both | Show backend, health, active model, working directory |
| `/doctor` | both | Diagnose connectivity and configuration |
| `/sandbox` | both | Show command isolation backend status |
| `/dir [path]` | both | Show or change working directory |
| `/help` | both | List all slash commands |
| `/router` | router | Show cached 9router configuration summary |
| `/refresh` | router | Reload cached 9router configuration |
| `/providers` | router | List 9router provider connections |
| `/combos` | router | List 9router fallback chains |
| `/keys` | router | List 9router API keys |
| `/setup` | router | Install and start 9router if not already running |

## Documentation

Full setup, CLI options, REPL commands, sandbox notes, replay, repair, programmatic API, and the backend abstraction live in:

- [Full documentation](docs/full-documentation.md)

If GitHub Pages is enabled for this repository, publish `docs/full-documentation.md` as the main documentation page.

## Development

```sh
npm install
npm run build
npm test
```

## License

See the repository license.
