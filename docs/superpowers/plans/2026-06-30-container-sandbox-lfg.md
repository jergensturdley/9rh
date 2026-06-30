# Container Sandbox and LFG Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in session containers for `run_bash`, honest sandbox status, and session-only `lfg` / `omglfg` autonomous tool modes.

**Architecture:** Keep the existing `SandboxProvider` interface and introduce a focused `ContainerSessionExecutor` plus provider adapters for Apple `container`, Docker, and Podman. `createExecutor()` resolves an effective backend from config/auto-detection and returns either a container executor, the existing macOS sandbox executor, or direct fallback. Approval autonomy lives in session/agent config, not persisted config.

**Tech Stack:** TypeScript ESM, Node `child_process`, existing Jest test suite, existing `src/sandbox/`, `src/config.ts`, `src/agent.ts`, `src/index.ts`, and `src/commands.ts`.

---

## File Structure

- Create `src/sandbox/container.ts`: provider-agnostic container session executor and provider command builders.
- Modify `src/sandbox/executor.ts`: backend selection, executor factory options, effective status.
- Modify `src/sandbox/index.ts`: export container types.
- Modify `src/config.ts`: persisted sandbox backend/image fields.
- Modify `src/agent.ts`: accept executor options and approval mode.
- Modify `src/index.ts`: CLI flags, REPL session state, warnings, `makeAgent()` wiring.
- Modify `src/commands.ts`: `/sandbox`, `/lfg`, `/omglfg`, setup/status helpers.
- Add/modify tests in `src/sandbox/__tests__/sandbox.test.ts`, `src/__tests__/commands.test.ts`, and `src/__tests__/agent.test.ts`.

## Shared Types

Use these names consistently:

```ts
export type SandboxBackendName =
  | "auto"
  | "apple-container"
  | "docker"
  | "podman"
  | "macos-sandbox"
  | "direct";

export type ApprovalMode = "ask" | "lfg" | "omglfg";
```

`lfg` and `omglfg` are runtime-only. Persist `sandboxBackend` and `sandboxImage`, not `approvalMode`.

---

### Task 1: Persist Sandbox Backend and Image Config

**Files:**
- Modify: `src/config.ts`
- Test: `src/__tests__/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Add tests that read/write sandbox settings:

```ts
it("round-trips sandbox backend and image", async () => {
  await withConfigDir(async () => {
    await writeUserConfig({
      sandboxBackend: "docker",
      sandboxImage: "node:22-bookworm-slim",
    });
    await expect(readUserConfig()).resolves.toMatchObject({
      sandboxBackend: "docker",
      sandboxImage: "node:22-bookworm-slim",
    });
  });
});

it("drops invalid sandbox backend values", async () => {
  await withConfigDir(async (dir) => {
    await writeFile(join(dir, "config.json"), JSON.stringify({ sandboxBackend: "bad", sandboxImage: "ubuntu:24.04" }));
    await expect(readUserConfig()).resolves.toMatchObject({ sandboxImage: "ubuntu:24.04" });
    expect((await readUserConfig()).sandboxBackend).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run red test**

Run: `npm test -- --runTestsByPath src/__tests__/config.test.ts --runInBand`

Expected: FAIL because `UserConfig` has no `sandboxBackend` / `sandboxImage`.

- [ ] **Step 3: Add config fields and validation**

In `src/config.ts`, add:

```ts
const SANDBOX_BACKENDS = new Set(["auto", "apple-container", "docker", "podman", "macos-sandbox", "direct"]);

function cleanSandboxBackend(value: unknown): UserConfig["sandboxBackend"] {
  const cleaned = cleanString(value);
  return cleaned && SANDBOX_BACKENDS.has(cleaned) ? cleaned as UserConfig["sandboxBackend"] : undefined;
}
```

Extend `UserConfig`:

```ts
sandboxBackend?: "auto" | "apple-container" | "docker" | "podman" | "macos-sandbox" | "direct";
sandboxImage?: string;
```

Read/write both fields.

- [ ] **Step 4: Run green test**

Run: `npm test -- --runTestsByPath src/__tests__/config.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "feat: persist sandbox backend config"
```

---

### Task 2: Add Container Session Executor

**Files:**
- Create: `src/sandbox/container.ts`
- Modify: `src/sandbox/index.ts`
- Test: `src/sandbox/__tests__/container.test.ts`

- [ ] **Step 1: Write failing container command-builder tests**

Create tests for command construction without requiring installed providers:

```ts
import { buildDockerArgs, buildPodmanArgs, buildAppleContainerArgs } from "../container.js";

it("builds docker session start args with workdir bind mount", () => {
  expect(buildDockerArgs({
    action: "start",
    name: "9rh-test",
    image: "node:22-bookworm-slim",
    hostWorkDir: "/repo",
    containerWorkDir: "/workspace",
    networkEnabled: false,
  })).toEqual([
    "run", "-d", "--name", "9rh-test", "--network", "none",
    "-v", "/repo:/workspace", "-w", "/workspace",
    "node:22-bookworm-slim", "tail", "-f", "/dev/null",
  ]);
});

it("builds exec args as sh -lc", () => {
  expect(buildDockerArgs({ action: "exec", name: "9rh-test", command: "npm test" }))
    .toEqual(["exec", "9rh-test", "sh", "-lc", "npm test"]);
});
```

- [ ] **Step 2: Run red test**

Run: `npm test -- --runTestsByPath src/sandbox/__tests__/container.test.ts --runInBand`

Expected: FAIL because `container.ts` does not exist.

- [ ] **Step 3: Implement `src/sandbox/container.ts`**

Add:

```ts
export interface ContainerSessionConfig {
  provider: "apple-container" | "docker" | "podman";
  image: string;
  hostWorkDir: string;
  containerWorkDir?: string;
  networkEnabled?: boolean;
  timeoutMs?: number;
}

export interface ContainerStatus {
  backend: "apple-container" | "docker" | "podman";
  image: string;
  containerName: string;
  hostWorkDir: string;
  containerWorkDir: string;
  networkEnabled: boolean;
  running: boolean;
}
```

Implement pure builders:

```ts
export type ContainerAction =
  | { action: "start"; name: string; image: string; hostWorkDir: string; containerWorkDir: string; networkEnabled: boolean }
  | { action: "exec"; name: string; command: string }
  | { action: "stop"; name: string };

export function buildDockerArgs(input: ContainerAction): string[] {
  if (input.action === "start") {
    return [
      "run", "-d", "--name", input.name,
      "--network", input.networkEnabled ? "bridge" : "none",
      "-v", `${input.hostWorkDir}:${input.containerWorkDir}`,
      "-w", input.containerWorkDir,
      input.image, "tail", "-f", "/dev/null",
    ];
  }
  if (input.action === "exec") return ["exec", input.name, "sh", "-lc", input.command];
  return ["rm", "-f", input.name];
}

export function buildPodmanArgs(input: ContainerAction): string[] {
  return buildDockerArgs(input);
}

export function buildAppleContainerArgs(input: ContainerAction): string[] {
  if (input.action === "start") {
    return [
      "run", "--detach", "--name", input.name,
      "--volume", `${input.hostWorkDir}:${input.containerWorkDir}`,
      "--workdir", input.containerWorkDir,
      input.networkEnabled ? "--network" : "--no-network",
      input.image, "tail", "-f", "/dev/null",
    ];
  }
  if (input.action === "exec") return ["exec", input.name, "sh", "-lc", input.command];
  return ["rm", "-f", input.name];
}
```

Implement `ContainerSessionExecutor implements SandboxProvider` using `execFile("docker" | "podman" | "container", args)`. It must:

- lazy-start the session on first `exec`
- run commands via provider exec as `sh -lc`
- return `{ output, exitCode, timedOut, durationMs, sandboxUsed: true }`
- expose `stopSession()` and `describeStatus()`
- keep `validatePath()` behavior equivalent to `DirectExecutor` for tool path validation

- [ ] **Step 4: Export container types**

In `src/sandbox/index.ts` export:

```ts
export { ContainerSessionExecutor, buildDockerArgs, buildPodmanArgs, buildAppleContainerArgs } from "./container.js";
export type { ContainerSessionConfig, ContainerStatus } from "./container.js";
```

- [ ] **Step 5: Run green test**

Run: `npm test -- --runTestsByPath src/sandbox/__tests__/container.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sandbox/container.ts src/sandbox/index.ts src/sandbox/__tests__/container.test.ts
git commit -m "feat: add container session executor"
```

---

### Task 3: Wire Backend Detection Into `createExecutor()`

**Files:**
- Modify: `src/sandbox/executor.ts`
- Modify: `src/sandbox/sandboxer.ts`
- Test: `src/sandbox/__tests__/sandbox.test.ts`

- [ ] **Step 1: Write failing backend-selection tests**

Add tests that mock provider availability through an injectable probe:

```ts
it("prefers docker over direct when docker is available", () => {
  const exec = createExecutor("/tmp", {
    useSandbox: true,
    sandboxConfig: { sandboxBackend: "auto", sandboxImage: "node:22-bookworm-slim" },
    providerProbe: (name) => name === "docker",
  });
  expect(exec.constructor.name).toBe("ContainerSessionExecutor");
});

it("honors explicit direct backend", () => {
  const exec = createExecutor("/tmp", {
    useSandbox: true,
    sandboxConfig: { sandboxBackend: "direct" },
    providerProbe: () => true,
  });
  expect(exec).toBeInstanceOf(DirectExecutor);
});
```

- [ ] **Step 2: Run red test**

Run: `npm test -- --runTestsByPath src/sandbox/__tests__/sandbox.test.ts --runInBand`

Expected: FAIL because `sandboxBackend`, `sandboxImage`, and `providerProbe` are unsupported.

- [ ] **Step 3: Extend sandbox config and factory options**

Add to `SandboxConfig`:

```ts
sandboxBackend?: SandboxBackendName;
sandboxImage?: string;
```

Add to `createExecutor()` options:

```ts
providerProbe?: (provider: "apple-container" | "docker" | "podman") => boolean;
```

Use provider binary checks by default:

```ts
function commandExists(cmd: string): boolean {
  try { execFileSync("/usr/bin/env", ["which", cmd], { stdio: "ignore" }); return true; }
  catch { return false; }
}
```

Detection order:

```ts
const backend = opts.sandboxConfig?.sandboxBackend ?? "auto";
const image = opts.sandboxConfig?.sandboxImage ?? "node:22-bookworm-slim";
```

Return `ContainerSessionExecutor` for explicit or auto-detected container providers. Keep existing restrictive macOS sandbox fallback after container probes.

- [ ] **Step 4: Run green test**

Run: `npm test -- --runTestsByPath src/sandbox/__tests__/sandbox.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/executor.ts src/sandbox/sandboxer.ts src/sandbox/__tests__/sandbox.test.ts
git commit -m "feat: select configured sandbox backend"
```

---

### Task 4: Add Sandbox Status and Setup UX

**Files:**
- Modify: `src/commands.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/commands.test.ts`

- [ ] **Step 1: Write failing `/sandbox` tests**

Add tests for configured backend/image and LFG status:

```ts
it("/sandbox reports container backend details", async () => {
  const current = state("model-key");
  current.sandboxBackend = "docker";
  current.sandboxImage = "node:22-bookworm-slim";
  const output = await executeSlashCommand("/sandbox", current);
  expect(output).toContain("configured backend: docker");
  expect(output).toContain("image: node:22-bookworm-slim");
});
```

- [ ] **Step 2: Run red test**

Run: `npm test -- --runTestsByPath src/__tests__/commands.test.ts --runInBand -t sandbox`

Expected: FAIL because `SessionState` has no sandbox fields and `/sandbox` omits image/config.

- [ ] **Step 3: Extend `SessionState`**

In `src/commands.ts` add:

```ts
sandboxBackend?: SandboxBackendName;
sandboxImage?: string;
approvalMode?: ApprovalMode;
```

Update `state()` test helper and REPL initialization in `src/index.ts` to carry values from `readUserConfig()`.

- [ ] **Step 4: Update `/sandbox` output**

Include:

```text
configured backend: <value>
active backend: <value>
image: <image or —>
approval mode: ask|lfg|omglfg
workDir: <path>
mount: <workDir> -> /workspace
```

Keep existing warning when active backend is direct.

- [ ] **Step 5: Add `/sandbox setup` minimal path**

Support:

```text
/sandbox setup docker node:22-bookworm-slim
/sandbox setup podman ubuntu:24.04
/sandbox setup apple-container ubuntu:24.04
/sandbox setup direct
```

Persist backend/image via `updateUserConfig()` and mutate `SessionState`.

- [ ] **Step 6: Run green test**

Run: `npm test -- --runTestsByPath src/__tests__/commands.test.ts --runInBand -t sandbox`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands.ts src/index.ts src/__tests__/commands.test.ts
git commit -m "feat: add sandbox setup status"
```

---

### Task 5: Add LFG and OMGLFG Approval Modes

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/index.ts`
- Modify: `src/commands.ts`
- Test: `src/__tests__/agent.test.ts`
- Test: `src/__tests__/commands.test.ts`

- [ ] **Step 1: Write failing agent approval tests**

Add tests proving approval callback is skipped in autonomy mode:

```ts
it("skips built-in tool approval in omglfg mode", async () => {
  const approvals: ToolApprovalRequest[] = [];
  const agent = new Agent(makeConfig({
    approvalMode: "omglfg",
    onToolApproval: async (req) => {
      approvals.push(req);
      return { approved: false, reason: "should not be called" };
    },
  }));
  await (agent as unknown as AgentPrivate).executeToolWithRepair("run_bash", { command: "sudo whoami" }, "c1");
  expect(approvals).toEqual([]);
});
```

Use existing `agent.test.ts` stream mocks; do not hit real APIs.

- [ ] **Step 2: Run red test**

Run: `npm test -- --runTestsByPath src/__tests__/agent.test.ts --runInBand -t omglfg`

Expected: FAIL because `approvalMode` is unsupported.

- [ ] **Step 3: Add `ApprovalMode` to `AgentConfig`**

In `src/agent.ts`:

```ts
export type ApprovalMode = "ask" | "lfg" | "omglfg";

export interface AgentConfig {
  approvalMode?: ApprovalMode;
  requireContainerForLfg?: boolean;
}
```

In tool execution, skip `onToolApproval` when:

```ts
const autonomous = this.config.approvalMode === "lfg" || this.config.approvalMode === "omglfg";
if (!autonomous && riskAtOrAbove(risk, threshold)) {
  const approver = this.config.onToolApproval;
  if (!approver) {
    const reason = `tool call ${name} classified as ${risk} (>= ${threshold}) but no onToolApproval callback is configured; refusing to execute`;
    this.emit({ type: "error", message: reason });
    return { output: "", error: reason };
  }
  const decision = await approver({ name, args, risk, threshold });
  if (!decision.approved) {
    return { output: "", error: `tool call rejected by user: ${decision.reason ?? "no reason given"}` };
  }
}
```

- [ ] **Step 4: Gate LFG before agent starts**

In `src/index.ts`, parse flags:

```ts
.option("--lfg", "Run this session without built-in tool approval prompts; requires container sandbox")
.option("--omglfg", "Run this session without built-in tool approval prompts, even without container isolation")
```

For `--lfg`, inspect effective executor before constructing the agent. If not container-backed, print setup hint and `process.exit(1)`.

For `--omglfg`, print warning and continue.

- [ ] **Step 5: Add REPL commands**

In `src/commands.ts`, add:

```text
/lfg on|off|status
/omglfg on|off|status
```

`/lfg on` requires active container backend. `/omglfg on` requires exact confirmation text `omglfg` when stdin is TTY. In tests, expose a helper path that injects confirmation or test status/off paths without raw stdin.

- [ ] **Step 6: Wire `makeAgent()`**

Pass `approvalMode: state.approvalMode ?? "ask"` into `Agent`.

- [ ] **Step 7: Run green tests**

Run:

```bash
npm test -- --runTestsByPath src/__tests__/agent.test.ts src/__tests__/commands.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/agent.ts src/index.ts src/commands.ts src/__tests__/agent.test.ts src/__tests__/commands.test.ts
git commit -m "feat: add lfg autonomy modes"
```

---

### Task 6: Session Cleanup, Integration Status, and Full Verification

**Files:**
- Modify: `src/sandbox/container.ts`
- Modify: `src/agent.ts`
- Modify: `src/commands.ts`
- Test: `src/sandbox/__tests__/container.test.ts`

- [ ] **Step 1: Write failing cleanup tests**

Add tests that use a fake provider runner to verify:

```ts
it("stops the session container once", async () => {
  const calls: string[][] = [];
  const exec = new ContainerSessionExecutor(config, async (_bin, args) => {
    calls.push(args);
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  await exec.exec("echo hi");
  await exec.stopSession();
  await exec.stopSession();
  expect(calls.filter(args => args.includes("rm") || args.includes("stop")).length).toBe(1);
});
```

- [ ] **Step 2: Run red test**

Run: `npm test -- --runTestsByPath src/sandbox/__tests__/container.test.ts --runInBand`

Expected: FAIL if cleanup is missing or not idempotent.

- [ ] **Step 3: Make cleanup idempotent**

Ensure `ContainerSessionExecutor.stopSession()`:

- returns immediately when not running
- runs provider cleanup once
- sets status to stopped
- does not throw on missing container

- [ ] **Step 4: Attach cleanup to agent lifecycle**

Add optional `dispose()` to `SandboxProvider` or type-check `stopSession`:

```ts
if ("stopSession" in this.executor && typeof this.executor.stopSession === "function") {
  await this.executor.stopSession();
}
```

Call in `Agent.run()` `finally` path after report/error handling.

- [ ] **Step 5: Update `/doctor` if present**

Add sandbox summary line using the same helper as `/sandbox`, without interactive setup.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm run build
npm test -- --runInBand
```

Expected: build succeeds; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/sandbox/container.ts src/agent.ts src/commands.ts src/sandbox/__tests__/container.test.ts
git commit -m "feat: clean up container sandbox sessions"
```

---

## Final Review Checklist

- [ ] `--lfg` cannot run without a container backend.
- [ ] `--omglfg` is session-only and prints a warning.
- [ ] `/lfg` and `/omglfg` do not persist config.
- [ ] `sandboxBackend` and `sandboxImage` persist.
- [ ] `/sandbox` reports configured and active backend honestly.
- [ ] `run_bash` uses container executor when configured.
- [ ] Host file tools remain `sandboxPath()` restricted.
- [ ] Full build and test suite pass.
