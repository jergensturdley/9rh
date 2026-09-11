import { describe, expect, it } from "vitest";
import { formatCost, formatTokens, maskKey, relativeTime } from "./format";

describe("formatTokens", () => {
  it("keeps small counts whole", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });
  it("uses k and M with one decimal", () => {
    expect(formatTokens(12400)).toBe("12.4k");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(482_942)).toBe("482.9k");
  });
  it("rolls over near a unit boundary", () => {
    expect(formatTokens(999_960)).toBe("1M");
  });
  it("handles junk", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("formatCost", () => {
  it("formats two decimals", () => {
    expect(formatCost(0.1565938)).toBe("$0.16");
    expect(formatCost(12)).toBe("$12.00");
  });
  it("marks tiny amounts", () => {
    expect(formatCost(0.001)).toBe("<$0.01");
    expect(formatCost(0)).toBe("$0.00");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-09-11T12:00:00Z");
  it("buckets by unit", () => {
    expect(relativeTime("2026-09-11T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-09-11T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-09-11T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-09-01T12:00:00Z", now)).toBe("10d ago");
  });
  it("falls back to a date past 30 days", () => {
    expect(relativeTime("2026-07-09T17:29:32.304Z", now)).toBe("2026-07-09");
  });
  it("handles missing or invalid input", () => {
    expect(relativeTime(undefined, now)).toBe("never");
    expect(relativeTime("nope", now)).toBe("never");
  });
});

describe("maskKey", () => {
  it("keeps the sk- prefix and last six", () => {
    expect(maskKey("sk-70260078b0fbb2bd-zlpgyd-b1ea1abd")).toBe("sk-…ea1abd");
  });
  it("masks keys without a prefix", () => {
    expect(maskKey("abcdefghijkl")).toBe("…ghijkl");
  });
  it("leaves short keys alone", () => {
    expect(maskKey("sk-abc")).toBe("sk-abc");
  });
});
