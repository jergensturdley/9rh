# Security and Sandboxing Roadmap

Status: untracked planning note.

## Goals

- Make it obvious when 9rh is executing commands directly vs inside an isolation backend.
- Prefer fail-closed behavior when a user explicitly requests sandboxing.
- Reduce blast radius for agent-authored shell commands and filesystem changes.
- Build toward container and microVM backends without rewriting the agent/tool stack.

## Guiding Principles

1. Keep `SandboxProvider` as the executor abstraction.
2. Add observability before adding stricter controls.
3. Make security posture visible in `/doctor`, `/sandbox`, and run events.
4. Avoid passing real API keys into isolated environments.
5. Start with platform-native controls, then add portable backends.

## Phase 1: Observability and Correctness

- [ ] Fix sandbox availability detection. Done in `b25b4eb`.
- [ ] Add a `/sandbox` slash command showing:
  - active backend capability: `direct`, `macos-sandbox`, future `container`, `vm`
  - sandbox availability
  - network policy default
  - whether sandbox was explicitly requested
  - last execution counters if available
- [ ] Surface backend in sandbox health events/TUI.
- [ ] Add tests around backend selection and status formatting.

## Phase 2: Strict macOS Sandbox Profile

- [ ] Replace permissive `(allow default)` profile with deny-by-default macOS sandbox profile.
- [ ] Allow process execution required for shells/build tools.
- [ ] Allow read/write only inside `workDir` and approved temp/cache paths.
- [ ] Disable network by default, with opt-in config.
- [ ] Add integration tests proving:
  - command can write inside `workDir`
  - command cannot write outside `workDir`
  - network is denied when disabled
  - clear diagnostic is returned for sandbox policy denial

## Phase 3: Configuration and Fail-Closed Modes

- [ ] Add config/env:
  - `NINE_RH_SANDBOX=auto|direct|macos|container|vm`
  - `NINE_RH_SANDBOX_NETWORK=0|1`
  - `NINE_RH_SANDBOX_FAIL_CLOSED=0|1`
- [ ] When sandbox is explicitly requested and unavailable, fail instead of silently using direct execution.
- [ ] Add `/sandbox direct|auto|strict` or equivalent session controls if useful.

## Phase 4: Container Backend

- [ ] Implement `ContainerExecutor` behind `SandboxProvider`.
- [ ] Support Docker or Podman detection.
- [ ] Bind-mount workDir with safe user mapping.
- [ ] Enforce CPU/memory/time limits.
- [ ] Support `--network none` by default.
- [ ] Add persistent per-session container option to avoid startup overhead.

## Phase 5: Auth Gateway

- [ ] Keep real API keys on host only.
- [ ] Expose a localhost gateway to sandbox/container/VM.
- [ ] Gateway injects credentials into outbound requests to 9router/provider endpoints.
- [ ] Redact credentials from logs and replay events.

## Phase 6: VM/MicroVM Prototype

- [ ] Evaluate macOS Apple Silicon candidates: shuru, Lima, Tart, Apple Virtualization.framework wrappers.
- [ ] Implement `VmExecutor` MVP:
  - boot or attach to workspace VM
  - exec command
  - stream stdout/stderr
  - sync or mount workspace
  - stop/cleanup
- [ ] Decide whether VM is per task, per session, or per project.
- [ ] Add snapshot/rollback story.

## Immediate Next Steps

1. Add `/sandbox` observability command.
2. Add a strict macOS profile prototype with tests.
3. Add fail-closed selection controls.
4. Then evaluate container backend.
