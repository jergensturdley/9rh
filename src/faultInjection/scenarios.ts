import { ErrorClass } from "../repair/errorTaxonomy.js";
import type { FaultScenario } from "./types.js";

export const BUILT_IN_SCENARIOS: readonly FaultScenario[] = [
  {
    id: "api_timeout_on_retry",
    name: "API Timeout — Succeeds on Third Attempt",
    description:
      "LLM stream endpoint times out on the first two calls; the retry mechanism recovers on call 3.",
    category: "network",
    severity: "high",
    fault: {
      target: "openai.stream",
      type: "timeout",
      trigger: { kind: "first_n_calls", n: 2 },
    },
    expected: {
      detectedFault: true,
      recoveryPath: "retried",
      errorClass: ErrorClass.RECOVERABLE,
      maxRetries: 3,
    },
    tags: ["retry", "timeout", "llm"],
  },
  {
    id: "disk_full_write",
    name: "Disk Full on File Write",
    description: "write_file fails with ENOSPC; the repair system escalates to the user.",
    category: "filesystem",
    severity: "high",
    fault: {
      target: "fs.write",
      type: "enospc",
      trigger: { kind: "always" },
    },
    expected: {
      detectedFault: true,
      recoveryPath: "escalated",
      errorClass: ErrorClass.ENVIRONMENT_ERROR,
    },
    tags: ["disk", "enospc", "filesystem"],
  },
  {
    id: "permission_denied_read",
    name: "Permission Denied on File Read",
    description: "read_file throws EACCES; the repair system escalates after one retry.",
    category: "filesystem",
    severity: "medium",
    fault: {
      target: "fs.read",
      type: "eacces",
      trigger: { kind: "always" },
    },
    expected: {
      detectedFault: true,
      recoveryPath: "escalated",
      errorClass: ErrorClass.ENVIRONMENT_ERROR,
    },
    tags: ["permissions", "eacces", "filesystem"],
  },
  {
    id: "sandbox_timeout",
    name: "Sandbox Execution Timeout",
    description:
      "run_bash command times out in the sandbox; the repair playbook restarts the subprocess.",
    category: "system",
    severity: "medium",
    fault: {
      target: "sandbox.exec",
      type: "timeout",
      trigger: { kind: "on_call_n", n: 1 },
    },
    expected: {
      detectedFault: true,
      recoveryPath: "repaired",
      errorClass: ErrorClass.RECOVERABLE,
    },
    tags: ["sandbox", "timeout", "bash"],
  },
  {
    id: "malformed_json_response",
    name: "Malformed JSON from LLM",
    description:
      "LLM stream returns an unparseable JSON payload; the repair playbook strips fences and retries.",
    category: "agent",
    severity: "high",
    fault: {
      target: "openai.stream",
      type: "malformed_json",
      trigger: { kind: "on_call_n", n: 1 },
    },
    expected: {
      detectedFault: true,
      recoveryPath: "repaired",
      errorClass: ErrorClass.AGENT_ERROR,
    },
    tags: ["json", "llm", "parse"],
  },
  {
    id: "repair_llm_unavailable",
    name: "Repair LLM Network Reset",
    description:
      "The repair sub-agent's LLM call is reset mid-stream; the system degrades gracefully by using playbook-only repair.",
    category: "network",
    severity: "critical",
    fault: {
      target: "repair.llm",
      type: "network_reset",
      trigger: { kind: "always" },
    },
    expected: {
      detectedFault: true,
      recoveryPath: "degraded_gracefully",
      errorClass: ErrorClass.RECOVERABLE,
    },
    tags: ["repair", "network", "degraded"],
  },
  {
    id: "circuit_breaker_trip",
    name: "Circuit Breaker Opens After Three Environment Failures",
    description:
      "Three consecutive ENOSPC errors trigger the circuit breaker; subsequent calls are rejected without attempting repair.",
    category: "circuit_breaker",
    severity: "critical",
    fault: {
      target: "fs.write",
      type: "enospc",
      trigger: { kind: "always" },
    },
    expected: {
      detectedFault: true,
      recoveryPath: "escalated",
      errorClass: ErrorClass.ENVIRONMENT_ERROR,
    },
    tags: ["circuit-breaker", "enospc", "filesystem"],
  },
  {
    id: "invalid_tool_args",
    name: "Invalid Tool Arguments from Agent",
    description:
      "The agent emits a tool call with a missing required field; the repair system corrects the schema and retries.",
    category: "agent",
    severity: "medium",
    fault: {
      target: "tool.bash",
      type: "invalid_tool_args",
      trigger: { kind: "on_call_n", n: 1 },
    },
    expected: {
      detectedFault: true,
      recoveryPath: "repaired",
      errorClass: ErrorClass.AGENT_ERROR,
    },
    tags: ["tool-args", "schema", "agent"],
  },
  {
    id: "rate_limit_with_backoff",
    name: "Rate Limit — Recovers After Two Attempts",
    description:
      "OpenAI single completion is rate-limited on calls 1 and 2; the third call succeeds after exponential backoff.",
    category: "network",
    severity: "low",
    fault: {
      target: "openai.single",
      type: "rate_limit",
      trigger: { kind: "first_n_calls", n: 2 },
    },
    expected: {
      detectedFault: true,
      recoveryPath: "retried",
      errorClass: ErrorClass.RECOVERABLE,
      maxRetries: 3,
    },
    tags: ["rate-limit", "backoff", "llm"],
  },
  {
    id: "fatal_invariant_violation",
    name: "Fatal Invariant Violation — No Repair Attempted",
    description:
      "An invariant violation causes a FATAL error; the system halts immediately and escalates without trying repair.",
    category: "system",
    severity: "critical",
    fault: {
      target: "sandbox.exec",
      type: "invariant_violation",
      trigger: { kind: "on_call_n", n: 1 },
    },
    expected: {
      detectedFault: true,
      recoveryPath: "escalated",
      errorClass: ErrorClass.FATAL,
    },
    tags: ["fatal", "invariant", "halt"],
  },
] as const;
