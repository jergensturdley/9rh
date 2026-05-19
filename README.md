# 9rh

9rh is a lightweight local coding-agent harness that routes model traffic through [9router](https://github.com/decolua/9router). It can run one-shot tasks, open an interactive REPL, call sandbox-aware tools, and auto-start 9router when needed.

## Highlights

- **Local repo agent** — run coding tasks against a selected working directory.
- **9router-native** — uses OpenAI-compatible `/v1` calls for completions and native `/api` calls for diagnostics, provider config, combos, and keys.
- **Interactive REPL** — slash commands for models, providers, router status, sandbox status, working directory, setup, and diagnostics.
- **Sandbox-aware tools** — file operations are path-checked, symlinks are blocked for file reads/writes, and shell commands use macOS `sandbox-exec` when available with visible `/sandbox` status.
- **Spec, replay, and repair systems** — optional spec-driven task framing, live run visualization, replay logs, checkpoints, error taxonomy, and repair hooks.
- **Programmatic API** — import the core agent, tools, visualization, spec, replay, and sandbox primitives from the package.

## Quick start

```sh
git clone https://github.com/jergensturdley/9rh.git
cd 9rh
npm install
npm run build
node dist/index.js --doctor
```

If 9router is not already configured, open the dashboard and connect at least one provider/API key:

```text
http://localhost:20128/dashboard
```

Then run a task:

```sh
node dist/index.js "summarize this repository"
```

Start the interactive REPL:

```sh
node dist/index.js --repl
```

Run against a specific directory and model:

```sh
node dist/index.js --dir /path/to/project --model kr/claude-sonnet-4.5 "fix the failing tests"
```

## Requirements

- Node.js 18+
- [9router](https://github.com/decolua/9router), automatically installed/started when possible
- At least one provider configured in the 9router dashboard: `http://localhost:20128/dashboard`

## Common slash commands

| Command | Description |
|---------|-------------|
| `/models [filter]` | List available models |
| `/switch <model>` | Change the active model |
| `/router` | Show cached 9router configuration summary |
| `/refresh` | Reload cached router configuration |
| `/providers` | List provider connections |
| `/combos` | List fallback chains |
| `/keys` | List 9router API keys |
| `/sandbox` | Show command isolation backend status |
| `/doctor` | Diagnose connectivity and configuration |
| `/dir [path]` | Show or change working directory |

## Documentation

Full setup, CLI options, REPL commands, sandbox notes, replay, repair, and programmatic API documentation live in:

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
