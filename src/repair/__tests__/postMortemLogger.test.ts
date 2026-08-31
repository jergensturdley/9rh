import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { logIncident, generatePlaybookEntry, type IncidentReport } from "../postMortemLogger.js";
import { readFile, readdir, rm, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ErrorClass, type TaggedError } from "../errorTaxonomy.js";

// Incident reports live under NINE_RH_HOME (default ~/.9rh); point the app
// home at a tmpdir so the test never touches the real one (nor the cwd).
let home: string;
let prevHome: string | undefined;

beforeAll(async () => {
  prevHome = process.env.NINE_RH_HOME;
  home = await mkdtemp(join(tmpdir(), "ninerh-home-"));
  process.env.NINE_RH_HOME = home;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.NINE_RH_HOME;
  else process.env.NINE_RH_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe("postMortemLogger", () => {
  it("logIncident writes a json file per incident under the app home", async () => {
    const errorContext = {
      cause: new Error("test error"),
      message: "test error",
      sourceLayer: "tool" as const,
      errorClass: ErrorClass.AGENT_ERROR,
      timestamp: Date.now(),
    };
    await logIncident(errorContext as TaggedError, 2, "ESCALATED", 500, "Something went wrong");
    const incidentDir = join(home, "logs", "incidents");
    const files = (await readdir(incidentDir)).filter((f) => f.startsWith("incident-"));
    expect(files.length).toBe(1);
    const raw = await readFile(join(incidentDir, files[0]), "utf-8");
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
    const entry = await generatePlaybookEntry(incident as IncidentReport);
    expect(entry.id).toMatch(/^pb-auto-/);
    expect(entry.errorClass).toBe("RECOVERABLE");
    expect(entry.autoApply).toBe(false);
  });
});
