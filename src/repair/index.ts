export { ErrorClass } from "./errorTaxonomy.js";
export type { TaggedError } from "./errorTaxonomy.js";

export { withErrorInterception } from "./errorInterceptor.js";
export type { RepairResult } from "./errorInterceptor.js";

export { captureSnapshot, restoreSnapshot } from "./snapshotManager.js";
export type { AgentState } from "./snapshotManager.js";

export { runRepairAgent } from "./repairAgent.js";
export type { PlaybookEntry } from "./repairAgent.js";

export { logIncident } from "./postMortemLogger.js";
