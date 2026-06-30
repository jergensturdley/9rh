# Container Sandbox and LFG Mode Design

## Context

9rh currently routes command execution through the `SandboxProvider` interface in `src/sandbox/`. On macOS, the restrictive `sandbox-exec` profile can be rejected while the platform probe still reports `sandbox-exec` as available. Users need a stronger and more portable isolation option for autonomous agent sessions.

This design adds opt-in container-backed command execution and session-only autonomous modes.

## Goals

- Add a generic OCI-style sandbox backend interface that can support Apple `container`, Docker, and Podman.
- Keep Apple containers as the preferred macOS Apple silicon path when available.
- Start one container per agent session, not one container per command.
- Keep generated files easy to retrieve through a bind-mounted work directory.
- Add explicit autonomous session modes: `lfg` and `omglfg`.
- Keep existing host file tools constrained by `sandboxPath()`.

## Non-Goals

- Do not make containers mandatory.
- Do not containerize slash commands, router setup, config writes, or local CLI startup.
- Do not mount the user home directory by default.
- Do not persist `lfg` or `omglfg` mode in config.

## Backend Architecture

Extend the current executor model with container-capable providers:

- `AppleContainerExecutor`
- `DockerExecutor`
- `PodmanExecutor`
- existing `SandboxExecutor`
- existing `DirectExecutor`

All providers expose the same operational surface:

- `validateAvailable()`
- `startSession()`
- `exec(command, options)`
- `stopSession()`
- `describeStatus()`

`createExecutor()` gains auto-detection:

1. Apple `container` on supported macOS Apple silicon hosts
2. Docker
3. Podman
4. restrictive macOS `sandbox-exec`, only if restrictive probe passes
5. direct fallback with a loud warning

Config supports:

```json
{
  "sandboxBackend": "auto",
  "sandboxImage": "node:22-bookworm-slim"
}
```

Supported backend values: `auto`, `apple-container`, `docker`, `podman`, `macos-sandbox`, `direct`.

## Container Session Lifecycle

For agent tool execution, 9rh starts one ephemeral container at session start. Each `run_bash` call runs inside that live container as `sh -lc <command>`. The container is stopped and removed when the session ends or the process exits.

Stale cleanup removes old `9rh-*` containers from previous crashed sessions when they are more than 24 hours old.

Container status includes provider, image, container id/name, mount path, network mode, and lifecycle state.

## File I/O and Mounts

9rh bind-mounts the host `workDir` read-write into the container, normally at `/workspace`, and sets the command working directory to `/workspace`.

Files created under `/workspace` appear in the host repository immediately. Files created outside mounted paths, such as `/tmp`, are ephemeral and removed with the container.

Host-side file tools such as `read_file` and `write_file` continue to run outside the container and remain restricted by `sandboxPath()`. Only shell execution is containerized in this design.

## First-Run Setup

Interactive REPL sessions may prompt when no safe sandbox is configured. Non-interactive task mode, piped stdin, and CI never prompt; they use config and detection, then warn or fail according to mode.

REPL setup presents detected backends and asks the user to choose a backend and image. Suggested images:

- `node:22-bookworm-slim` for JS/TS repos
- `python:3.12-slim`
- `ubuntu:24.04`
- custom image

The chosen backend and image are persisted to `~/.9rh/config.json`.

## LFG and OMGLFG Modes

`lfg` and `omglfg` are session-only approval modes.

`--lfg` and `/lfg on` enable autonomous built-in tool use only when the effective sandbox backend is container-backed. If no container backend is active, 9rh fails closed with setup instructions.

`--omglfg` and `/omglfg on` enable autonomous built-in tool use on any backend, including direct host execution. REPL activation requires typing an exact confirmation. Non-interactive `--omglfg` prints a prominent warning and proceeds because the explicit flag is the confirmation.

Both modes skip 9rh's normal approval prompts for built-in tools for the rest of the session. External plugins may still prompt, block, or enforce their own policy gates.

The warnings must clearly state:

- built-in tool approvals are disabled for the session
- commands may modify or delete files under the work directory
- `lfg` commands run inside the active container sandbox
- `omglfg` may run commands with host user permissions
- plugin gates may still apply

## Status and Doctor UX

`/sandbox` reports effective state, not only platform support:

- configured backend
- active backend
- container provider and image, when active
- mount path
- network mode
- whether approvals are normal, `lfg`, or `omglfg`
- fallback reason and setup hint when direct execution is active

`/doctor` includes sandbox readiness and setup recommendations.

## Error Handling

If container startup fails in normal mode, 9rh falls back according to config and warns. If `--lfg` is active, startup failure aborts the agent because LFG requires container isolation.

If a container dies mid-session, 9rh reports the failure, marks sandbox status unhealthy, and stops autonomous execution. In REPL mode, 9rh offers a one-time restart prompt; in non-interactive mode, it exits with a non-zero status.

## Testing Plan

Unit tests cover backend detection ordering, status formatting, config parsing, and approval-mode gating.

Executor tests use mocked provider binaries for Apple `container`, Docker, and Podman command construction. Integration tests run only when a provider is available and are skipped otherwise.

Regression tests verify:

- `--lfg` fails without a container backend
- `/lfg on` is session-only
- `/omglfg on` requires confirmation in REPL
- files written under `/workspace` are visible on host
- slash commands and setup still run on host
