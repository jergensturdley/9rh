import { describe, it, expect } from "@jest/globals";
import { logIncident, generatePlaybookEntry } from "../postMortemLogger.js";
import { readFile, readdir, rm } from "fs/promises";
import { join } from "path";
import { ErrorClass } from "../errorTaxonomy.js";

const INCIDENT_DIR = "./logs/incidents";

describe("postMortemLogger", () => {
  afterEach(async () => {
    try {
      const files = await readdir(INCIDENT_DIR);
      for (const f of files) {
        if (f !== ".gitkeep") await rm(join(INCIDENT_DIR, f));
      }
    } catch {}
  });

  it("logIncident writes a json file per incident", async () => {
    const errorContext = {
      cause: new Error("test error"),
      message: "test error",
      sourceLayer: "tool" as const,
      errorClass: ErrorClass.AGENT_ERROR,
      timestamp: Date.now(),
    };
    await logIncident(errorContext as any, 2, "ESCALATED", 500, "Something went wrong");
    const files = (await readdir(INCIDENT_DIR)).filter((f) => f.startsWith("incident-"));
    expect(files.length).toBe(1);
    const raw = await readFile(join(INCIDENT_DIR, files[0]), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.outcome).toBe("ESCALATED");
    expect(parsed.attemptsCount).toBe(2);
    expect(parsed.userMessage).toBe("Something went wrong");
  });

  it("generatePlaybookEntry builds a valid entry from incident", async () => {
    const incident = {
      timestamp: Date.now(),
      errorType: "timeout",
      rootCause: "Request timeout after 30s",
      attemptsCount: 3,
      fixApplied: "Applied backoff delay",
      outcome: "REPAIRED" as const,
      durationMs: 1200,
      userMessage: "Retried with backoff",
      sourceLayer: "llm",
      errorClass: "RECOVERABLE",
    };
    const entry = await generatePlaybookEntry(incident as any);
    expect(entry.id).toMatch(/^pb-auto-/);
    expect(entry.errorClass).toBe("RECOVERABLE");
    expect(entry.autoApply).toBe(false);
  });
});
