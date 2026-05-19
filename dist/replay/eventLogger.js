import { writeFile, mkdir, readFile } from "fs/promises";
import { createWriteStream } from "fs";
import { join, dirname } from "path";
import { redactEvent } from "../reasoner/redactor.js";
import { validateAndRepair } from "../reasoner/validation.js";
export class EventLogger {
    runId;
    branchId;
    logPath;
    writer = null;
    seq = 0;
    pending = [];
    flushEvery;
    finalized = false;
    drainScheduled = false;
    drainPromise = null;
    drainResolve = null;
    constructor(config) {
        this.runId = config.runId;
        this.branchId = config.branchId;
        this.flushEvery = config.flushEvery ?? 10;
        this.logPath = join(config.logDir, `run-${config.runId}.jsonl`);
    }
    async init() {
        try {
            await mkdir(dirname(this.logPath), { recursive: true });
        }
        catch { }
        this.writer = createWriteStream(this.logPath, { flags: "a", highWaterMark: 64 * 1024 });
    }
    log(event) {
        if (this.finalized)
            return;
        this.seq++;
        const full = { ...event, seq: this.seq, ts: Date.now() };
        const { event: safe } = validateAndRepair(full);
        const redacted = redactEvent(safe);
        this.pending.push(redacted);
        if (this.pending.length >= this.flushEvery)
            this.scheduleDrain();
    }
    flush() {
        if (!this.writer || this.pending.length === 0)
            return;
        this.scheduleDrain();
    }
    scheduleDrain() {
        if (this.drainScheduled)
            return;
        this.drainScheduled = true;
        this.drainPromise ??= new Promise((resolve) => {
            this.drainResolve = resolve;
        });
        setImmediate(() => this.drainPending());
    }
    drainPending() {
        this.drainScheduled = false;
        const writer = this.writer;
        const batch = this.pending.splice(0);
        if (writer && batch.length > 0) {
            const payload = batch.map((event) => JSON.stringify(event)).join("\n") + "\n";
            writer.write(payload);
        }
        const resolve = this.drainResolve;
        this.drainPromise = null;
        this.drainResolve = null;
        resolve?.();
        if (this.pending.length >= this.flushEvery)
            this.scheduleDrain();
    }
    async waitForDrain() {
        if (this.pending.length > 0)
            this.scheduleDrain();
        await this.drainPromise;
    }
    async finalize(runId, reason) {
        this.finalized = true;
        await this.waitForDrain();
        const writer = this.writer;
        if (writer)
            await new Promise((resolve) => writer.end(resolve));
        this.writer = null;
        const summary = {
            version: 1,
            runId,
            branchId: this.branchId,
            finalizedAt: Date.now(),
            reason,
            eventCount: this.seq,
        };
        const metaPath = this.logPath.replace(/\.jsonl$/, ".meta.json");
        try {
            await writeFile(metaPath, JSON.stringify(summary), "utf-8");
        }
        catch { }
        return this.logPath;
    }
    getLogPath() {
        return this.logPath;
    }
}
export async function readEventLog(path) {
    try {
        const raw = await readFile(path, "utf-8");
        const lines = raw.split("\n").filter(Boolean);
        return lines.map((l) => JSON.parse(l));
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=eventLogger.js.map