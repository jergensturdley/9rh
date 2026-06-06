import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { join, resolve, normalize, sep } from "path";
import type { TaggedError } from "./errorTaxonomy.js";
import { type ErrorClass } from "./errorTaxonomy.js";

export interface IncidentReport {
  timestamp: number;
  errorType: string;
  rootCause: string;
  attemptsCount: number;
  fixApplied: string;
  outcome: "REPAIRED" | "ESCALATED" | "FAILED";
  durationMs: number;
  userMessage: string;
  sourceLayer: string;
  errorClass: string;
}

export interface PlaybookEntry {
  id: string;
  pattern: string;
  errorClass: string;
  suggestedFix: string;
  autoApply: boolean;
}

const INCIDENT_DIR = "./logs/incidents";
// F-32: the playbook path is now configurable. Default is preserved
// for back-compat. Callers can override per-invocation. We also
// validate that the resolved path lies under the project root (the
// directory that contains src/) so a misconfigured caller can't
// trick appendPlaybookEntry into writing a playbook into a sensitive
// location (e.g. ~/.ssh/).
const DEFAULT_PLAYBOOK_PATH = "./src/repair/repairPlaybook.json";
const DEFAULT_PLAYBOOK_ROOT = process.cwd();

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {}
}

// F-32: validate that `target` is inside `root` after resolve().
// Returns the normalized absolute path on success, throws on escape.
function assertInsideRoot(target: string, root: string): string {
  const absRoot = resolve(root);
  const absTarget = resolve(absRoot, target);
  const withSep = absRoot.endsWith(sep) ? absRoot : absRoot + sep;
  if (absTarget !== absRoot && !absTarget.startsWith(withSep)) {
    throw new Error(
      `path ${target} escapes the allowed root ${absRoot} (resolved to ${absTarget})`,
    );
  }
  return absTarget;
}

// F-32: validate a PlaybookEntry before it's persisted. The entry's
// text fields are written to disk and later loaded by future agent
// runs; the agent's repair logic reads them to decide what fix to
// apply automatically. So a malicious incident message could inject
// fix text that's later followed by a future agent. Keep fields
// bounded and reject control characters that have no business in
// repair instructions.
function validatePlaybookEntry(entry: PlaybookEntry): void {
  if (!entry || typeof entry !== "object") {
    throw new Error("playbook entry must be an object");
  }
  if (typeof entry.id !== "string" || !/^pb-[a-zA-Z0-9_-]{1,40}$/.test(entry.id)) {
    throw new Error("playbook entry id has invalid shape");
  }
  if (typeof entry.pattern !== "string" || entry.pattern.length === 0 || entry.pattern.length > 200) {
    throw new Error("playbook entry pattern must be a 1-200 char string");
  }
  if (typeof entry.errorClass !== "string" || !/^(RECOVERABLE|AGENT_ERROR|ENVIRONMENT_ERROR|FATAL)$/.test(entry.errorClass)) {
    throw new Error("playbook entry errorClass has invalid value");
  }
  if (typeof entry.suggestedFix !== "string" || entry.suggestedFix.length === 0 || entry.suggestedFix.length > 1000) {
    throw new Error("playbook entry suggestedFix must be a 1-1000 char string");
  }
  if (typeof entry.autoApply !== "boolean") {
    throw new Error("playbook entry autoApply must be a boolean");
  }
  // Reject control characters in any text field. These are not
  // legitimate in repair instructions and would be a vector for
  // smuggling terminal escape sequences into future prompts.
  const bad = /[\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e-\x1f\x7f]/;
  if (bad.test(entry.id) || bad.test(entry.pattern) || bad.test(entry.suggestedFix)) {
    throw new Error("playbook entry contains forbidden control characters");
  }
}

export async function logIncident(
  errorContext: TaggedError,
  repairAttempts: number,
  outcome: IncidentReport["outcome"],
  durationMs: number,
  userMessage: string
): Promise<void> {
  const report: IncidentReport = {
    timestamp: Date.now(),
    errorType: errorContext.message.slice(0, 120),
    rootCause: errorContext.message,
    attemptsCount: repairAttempts,
    fixApplied: "",
    outcome,
    durationMs,
    userMessage,
    sourceLayer: errorContext.sourceLayer,
    errorClass: errorContext.errorClass,
  };

  try {
    await ensureDir(INCIDENT_DIR);
    const filename = `incident-${Date.now()}.json`;
    await writeFile(join(INCIDENT_DIR, filename), JSON.stringify(report, null, 2), "utf-8");
  } catch (err) {
    console.warn("[postMortemLogger] logIncident failed:", err);
  }
}

export async function generatePlaybookEntry(
  incident: IncidentReport
): Promise<PlaybookEntry> {
  const patternMatch = /([a-zA-Z][a-zA-Z0-9 _-]{10,80})/.exec(incident.rootCause);
  const pattern = patternMatch ? patternMatch[1].toLowerCase() : incident.rootCause.slice(0, 60);

  return {
    id: `pb-auto-${Date.now()}`,
    pattern,
    errorClass: incident.errorClass,
    suggestedFix: incident.fixApplied || "Fix discovered via post-mortem",
    autoApply: false,
  };
}

export async function appendPlaybookEntry(
  entry: PlaybookEntry,
  opts: { path?: string; root?: string } = {},
): Promise<void> {
  try {
    // F-32: validate the entry first. The entry's `pattern` and
    // `suggestedFix` flow from a runtime error message and are later
    // loaded as repair instructions by future agent runs. Treat
    // them as untrusted.
    validatePlaybookEntry(entry);
    const target = assertInsideRoot(
      opts.path ?? DEFAULT_PLAYBOOK_PATH,
      opts.root ?? DEFAULT_PLAYBOOK_ROOT,
    );
    const raw = await readFile(target, "utf-8");
    const existing: PlaybookEntry[] = JSON.parse(raw);
    existing.push(entry);
    await writeFile(target, JSON.stringify(existing, null, 2), "utf-8");
  } catch (err) {
    console.warn("[postMortemLogger] appendPlaybookEntry failed:", err);
  }
}
