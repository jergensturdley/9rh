import { describe, expect, it } from "vitest";
import { filterActions, fuzzyScore, type PaletteAction } from "./palette";

const noop = (): void => {};
const act = (id: string, label: string, group: string): PaletteAction => ({ id, label, group, run: noop });

describe("fuzzyScore", () => {
  it("returns 1 for an empty pattern", () => {
    expect(fuzzyScore("", "anything")).toBe(1);
  });

  it("returns 0 when the pattern is not a subsequence", () => {
    expect(fuzzyScore("xyz", "rewind")).toBe(0);
    expect(fuzzyScore("rewindd", "rewind")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("RW", "rewind")).toBe(4);
  });

  it("scores a consecutive word-start match: 1 per char, +2 start, +1 consecutive", () => {
    expect(fuzzyScore("rew", "rewind")).toBe(7);
  });

  it("rewards word starts over scattered characters", () => {
    expect(fuzzyScore("ns", "new session")).toBe(6);
    expect(fuzzyScore("ns", "unsure")).toBe(3);
  });

  it("rewards consecutive matches", () => {
    expect(fuzzyScore("in", "rewind")).toBe(3);
    expect(fuzzyScore("id", "rewind")).toBe(2);
  });
});

describe("filterActions", () => {
  const actions = [
    act("a", "New session", "sessions"),
    act("b", "Switch session", "sessions"),
    act("c", "Start router", "router"),
    act("d", "Stop router", "router"),
    act("e", "Show brief", "views"),
  ];

  it("returns the input untouched for a blank query", () => {
    expect(filterActions(actions, "")).toBe(actions);
    expect(filterActions(actions, "   ")).toBe(actions);
  });

  it("drops non-matching actions", () => {
    expect(filterActions(actions, "zzz")).toEqual([]);
    expect(filterActions(actions, "brief").map((a) => a.id)).toEqual(["e"]);
  });

  it("keeps groups in first-appearance order among the matches", () => {
    const out = filterActions(actions, "st");
    expect(out.map((a) => a.id)).toEqual(["b", "c", "d"]);
    expect([...new Set(out.map((a) => a.group))]).toEqual(["sessions", "router"]);
  });

  it("sorts by score inside a group and keeps ties in input order", () => {
    const list = [act("x", "rewind turn", "g"), act("y", "run rewind", "g"), act("z", "rewind", "g")];
    // x and z score 13 (start bonus on the first char); y scores 12 because its
    // "e" is not consecutive with the leading "r" of "run".
    expect(filterActions(list, "rewind").map((a) => a.id)).toEqual(["x", "z", "y"]);
    expect(filterActions(list, "rt").map((a) => a.id)).toEqual(["x"]);
  });
});
