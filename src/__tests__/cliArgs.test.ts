import { describe, expect, it } from "@jest/globals";
import {
  parsePositiveInt,
  hasOption,
  resolveMaxIter,
  buildContinuationPolicy,
  classifyInitCommand,
} from "../cliArgs.js";

describe("parsePositiveInt", () => {
  it("treats undefined/empty as a valid absent value", () => {
    expect(parsePositiveInt(undefined, "--x")).toEqual({ ok: true, value: undefined });
    expect(parsePositiveInt("", "--x")).toEqual({ ok: true, value: undefined });
  });
  it("accepts positive integers", () => {
    expect(parsePositiveInt("5", "--x")).toEqual({ ok: true, value: 5 });
  });
  it("rejects zero, negatives, and non-numbers", () => {
    expect(parsePositiveInt("0", "--x").ok).toBe(false);
    expect(parsePositiveInt("-3", "--x").ok).toBe(false);
    const bad = parsePositiveInt("abc", "--max-iter");
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("--max-iter") });
  });
});

describe("hasOption", () => {
  const argv = ["--model=gpt", "-b", "router"];
  it("matches an exact flag", () => {
    expect(hasOption(argv, ["-b"])).toBe(true);
  });
  it("matches a --flag=value form", () => {
    expect(hasOption(argv, ["-m", "--model"])).toBe(true);
  });
  it("returns false for an absent flag", () => {
    expect(hasOption(argv, ["--repl"])).toBe(false);
  });
});

describe("resolveMaxIter", () => {
  it("falls back to the default when omitted", () => {
    expect(resolveMaxIter(undefined, 100)).toEqual({ ok: true, value: 100 });
  });
  it("uses a supplied positive integer", () => {
    expect(resolveMaxIter("50", 100)).toEqual({ ok: true, value: 50 });
  });
  it("propagates a parse error", () => {
    expect(resolveMaxIter("nope", 100).ok).toBe(false);
  });
});

describe("buildContinuationPolicy", () => {
  it("is disabled by --no-continue", () => {
    expect(buildContinuationPolicy({ continue: false, continueMax: "5" })).toEqual({
      ok: true,
      policy: undefined,
    });
  });
  it("is undefined when no continuation flags are set", () => {
    expect(buildContinuationPolicy({})).toEqual({ ok: true, policy: undefined });
  });
  it("defaults maxContinuations to 1 when only a model is given", () => {
    expect(buildContinuationPolicy({ continueModel: "kr/opus" })).toEqual({
      ok: true,
      policy: { maxContinuations: 1, modelSwitch: { toModel: "kr/opus", afterContinuations: 1 } },
    });
  });
  it("honors continueMax, continueIter, and switchAfter", () => {
    const r = buildContinuationPolicy({
      continueMax: "3",
      continueIter: "4",
      continueModel: "kr/opus",
      continueSwitchAfter: "2",
    });
    expect(r).toEqual({
      ok: true,
      policy: {
        maxContinuations: 3,
        iterationsPerContinuation: 4,
        modelSwitch: { toModel: "kr/opus", afterContinuations: 2 },
      },
    });
  });
  it("omits modelSwitch when no continueModel is given", () => {
    const r = buildContinuationPolicy({ continueMax: "2" });
    expect(r).toEqual({ ok: true, policy: { maxContinuations: 2 } });
  });
  it("propagates a bad continueMax as an error", () => {
    expect(buildContinuationPolicy({ continueMax: "-1" }).ok).toBe(false);
  });
});

describe("classifyInitCommand", () => {
  it.each([
    [["init", "--update"], "update"],
    [["init", "-U"], "update"],
    [["init", "--update-router"], "update-router"],
    [["init", "--install"], "install"],
    [["init"], "ready"],
    [["init", "--quiet"], "ready"],
    [["init", "somearg"], "unknown"],
  ] as const)("classifies %j as %s", (argv, action) => {
    expect(classifyInitCommand([...argv]).action).toBe(action);
  });

  it("detects --quiet / -q", () => {
    expect(classifyInitCommand(["init", "--install", "-q"])).toEqual({ action: "install", quiet: true });
    expect(classifyInitCommand(["init"]).quiet).toBe(false);
  });

  it("prioritizes update over install when both present", () => {
    expect(classifyInitCommand(["init", "--install", "--update"]).action).toBe("update");
  });
});
