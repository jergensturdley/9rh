import { describe, expect, it } from "@jest/globals";
import { buildLongHorizonMemory, renderLongHorizonMemory, retrieveRelevantMemory } from "../longHorizonMemory.js";

describe("long-horizon memory", () => {
  it("splits working, episodic, and durable memory with provenance", () => {
    const history = [
      "User requested Long-Horizon Task Memory with Context Compression.",
      "Decision: use src/longHorizonMemory.ts as the stable architecture module and preserve provenance on every MemoryItem.",
      "Implemented buildLongHorizonMemory() and retrieveRelevantMemory().",
      "Current step: update src/agent.ts to include memorySummary during compactContext().",
      "Unresolved blocker: contextCompression.test.ts must still pass after wiring.",
    ].join("\n");

    const memory = buildLongHorizonMemory(history, "test-session", "2026-05-19T00:00:00.000Z");

    expect(memory.durable.some((i) => i.content.includes("stable architecture module"))).toBe(true);
    expect(memory.episodic.some((i) => i.content.includes("Implemented buildLongHorizonMemory()"))).toBe(true);
    expect(memory.working.some((i) => i.content.includes("update src/agent.ts"))).toBe(true);
    expect(memory.unresolvedBlockers.join("\n")).toContain("contextCompression.test.ts");
    for (const item of [...memory.working, ...memory.episodic, ...memory.durable]) {
      expect(item.provenance.source).toContain("test-session#segment-");
      expect(item.provenance.lastVerifiedAt).toBe("2026-05-19T00:00:00.000Z");
      expect(item.provenance.sourceHash).toHaveLength(16);
    }
  });

  it("preserves early architectural constraints and exact identifiers after long-session compression", () => {
    const earlyConstraint = "Architecture constraint: ReplayEvent schema in src/replay/eventSchema.ts must keep CompactEvent.payload.summary exact and source-linked.";
    const noise = Array.from({ length: 150 }, (_, i) => `low-value status chatter ${i}: still working, thinking, continuing`).join("\n");
    const lateStep = "Now add validation in src/__tests__/longHorizonMemory.test.ts and query retrieveRelevantMemory() for ReplayEvent.";
    const history = `${earlyConstraint}\n${noise}\n${lateStep}`;

    const memory = buildLongHorizonMemory(history, "long-session", "2026-05-19T00:00:00.000Z");
    const rendered = renderLongHorizonMemory(memory);

    expect(rendered).toContain("ReplayEvent");
    expect(rendered).toContain("src/replay/eventSchema.ts");
    expect(rendered).toContain("CompactEvent");
    expect(rendered).toContain("payload.summary");
    expect(rendered).toContain("source=long-session#segment-");
    expect(rendered.length).toBeLessThan(history.length / 2);
    expect(memory.compressionWarnings).toHaveLength(0);
  });

  it("retrieves by relevance rather than recency", () => {
    const history = [
      "Decision: durable convention says API route GET /v1/runs/{runId} returns ReplayEvent arrays.",
      "Completed notes.js cleanup in examples/notes/src/notes.js.",
      "Current work is noisy and unrelated to routes.",
    ].join("\n");
    const memory = buildLongHorizonMemory(history, "retrieval", "2026-05-19T00:00:00.000Z");

    const [top] = retrieveRelevantMemory(memory, "How should GET /v1/runs/{runId} expose ReplayEvent?", 3);

    expect(top.item.content).toContain("GET /v1/runs/{runId}");
    expect(top.item.content).toContain("ReplayEvent");
  });

  it("marks uncertain compressed memories for reconfirmation", () => {
    const memory = buildLongHorizonMemory(
      "Maybe src/agent.ts owns durable project memory, uncertain and needs reconfirmation before acting.",
      "uncertain-session",
      "2026-05-19T00:00:00.000Z",
    );

    const items = [...memory.working, ...memory.episodic, ...memory.durable];
    expect(items.some((i) => i.confidence === "uncertain" && i.needsReconfirmation)).toBe(true);
  });
});
