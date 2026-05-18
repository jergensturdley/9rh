import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
const INCIDENT_DIR = "./logs/incidents";
const PLAYBOOK_PATH = "./src/repair/repairPlaybook.json";
async function ensureDir(dir) {
    try {
        await mkdir(dir, { recursive: true });
    }
    catch { }
}
export async function logIncident(errorContext, repairAttempts, outcome, durationMs, userMessage) {
    const report = {
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
    }
    catch (err) {
        console.warn("[postMortemLogger] logIncident failed:", err);
    }
}
export async function generatePlaybookEntry(incident) {
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
export async function appendPlaybookEntry(entry) {
    try {
        const raw = await readFile(PLAYBOOK_PATH, "utf-8");
        const existing = JSON.parse(raw);
        existing.push(entry);
        await writeFile(PLAYBOOK_PATH, JSON.stringify(existing, null, 2), "utf-8");
    }
    catch (err) {
        console.warn("[postMortemLogger] appendPlaybookEntry failed:", err);
    }
}
//# sourceMappingURL=postMortemLogger.js.map