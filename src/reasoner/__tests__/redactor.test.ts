import { describe, it, expect } from "@jest/globals";
import { redact, redactEvent } from "../redactor.js";

describe("redact", () => {
  it("returns primitive values unchanged", () => {
    expect(redact(42)).toBe(42);
    expect(redact("hello")).toBe("hello");
    expect(redact(null)).toBe(null);
  });

  it("redacts Bearer tokens from strings", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ";
    const result = redact(input);
    expect(result).toContain("Bearer [REDACTED_TOKEN]");
  });

  it("redacts API key environment variables", () => {
    const input = { API_KEY: "sk-abcdefghijklmnopqrstuvwxyz1234567890" };
    const result = redact(input) as typeof input;
    expect(result.API_KEY).toBe("[REDACTED]");
  });

  it("redacts nested secret objects", () => {
    const input = {
      user: "admin",
      data: { password: "secret123", token: "tok1234567890abcdefghijklmnop" },
    };
    const result = redact(input) as typeof input;
    expect(result.user).toBe("admin");
    expect(result.data.password).toBe("[REDACTED]");
    expect(result.data.token).toBe("[REDACTED]");
  });

  it("redacts GitHub tokens", () => {
    const input = "ghp_abcdefghijklmnopqrstuvwxyz1234567890uvwxyz";
    const result = redact(input);
    expect(result).toBe("[REDACTED_GITHUB_TOKEN]");
  });

  it("redacts Git basic auth URLs", () => {
    const input = "https://user:password123@github.com/org/repo.git";
    const result = redact(input);
    expect(result).toBe("https://[REDACTED_CREDENTIALS]@");
    expect(result).not.toContain("password123");
  });

  it("redacts AWS-style keys", () => {
    const input = { aws_key: "AKIAIOSFODNN7EXAMPLE" };
    const result = redact(input) as typeof input;
    expect(result.aws_key).toBe("[REDACTED_AWS_KEY]");
  });

  it("redacts arrays recursively", () => {
    const input: Array<Record<string, unknown>> = [
      { name: "file.txt", token: "secret_token_abc123def456ghi789" },
      { body: "Bearer auth_token_xyz123456789abcdefghijklmnop" },
    ];
    const result = redact(input) as Array<Record<string, unknown>>;
    expect(result[0].token).toBe("[REDACTED]");
    expect(result[1].body).toBe("Bearer [REDACTED_TOKEN]");
  });

  it("does not affect plain text strings without secret patterns", () => {
    const input = "This is a normal log message with no secrets in it.";
    const result = redact(input);
    expect(result).toBe(input);
  });
});

describe("redactEvent", () => {
  it("preserves type and step, redacts payload", () => {
    const event = {
      type: "tool_call",
      seq: 1,
      ts: 1234567890,
      step: { stepIndex: 1, iteration: 1, compactCount: 0 },
      payload: { toolName: "read_file", path: "/home/user/.ssh/id_rsa", args: {} },
    };
    const result = redactEvent(event);
    expect(result.type).toBe("tool_call");
    expect(result.payload).toEqual({ toolName: "read_file", path: "/home/user/.ssh/id_rsa", args: {} });
  });

  it("redacts secret values in payload", () => {
    const event = {
      type: "llm_response",
      payload: {
        text: "Here is the secret API key: sk-abcdefghijklmnopqrstuvwxyz",
        model: "claude",
      },
    };
    const result = redactEvent(event) as typeof event;
    expect(result.payload.text).toContain("[REDACTED_ENV_VAR]");
  });

  it("returns event unchanged if no payload", () => {
    const event = { type: "step_start" };
    const result = redactEvent(event);
    expect(result).toEqual(event);
  });
});