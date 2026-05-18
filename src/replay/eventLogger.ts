import { writeFile, mkdir, readFile } from "fs/promises";
import { createWriteStream } from "fs";
import { join, dirname } from "path";
import type { ReplayEvent } from "./eventSchema.js";
import { redactEvent } from "../reasoner/redactor.js";
import { validateAndRepair } from "../reasoner/validation.js";

export interface EventLoggerConfig {
  runId: string;
  branchId: string;
  logDir: string;
  flushEvery?: number;
}

export class EventLogger {
  private runId: string;
  private branchId: string;
  private logPath: string;
  private writer: ReturnType<typeof createWriteStream> | null = null;
  private seq = 0;
  private pending: string[] = [];
  private flushEvery: number;
  private finalized = false;

  constructor(config: EventLoggerConfig) {
    this.runId = config.runId;
    this.branchId = config.branchId;
    this.flushEvery = config.flushEvery ?? 10;
    this.logPath = join(config.logDir, `run-${config.runId}.jsonl`);
  }

  async init(): Promise<void> {
    try {
      await mkdir(dirname(this.logPath), { recursive: true });
    } catch {}
    this.writer = createWriteStream(this.logPath, { flags: "a", highWaterMark: 64 * 1024 });
  }

  log(event: Omit<ReplayEvent, "seq" | "ts">): void {
    if (this.finalized) return;
    this.seq++;
    const full = { ...event, seq: this.seq, ts: Date.now() } as ReplayEvent;
    const { event: safe } = validateAndRepair(full);
    const redacted = redactEvent(safe) as ReplayEvent;
    this.pending.push(JSON.stringify(redacted));
    if (this.pending.length >= this.flushEvery) this.flush();
  }

  flush(): void {
    if (!this.writer || this.pending.length === 0) return;
    for (const line of this.pending) {
      this.writer.write(line + "\n");
    }
    this.pending = [];
  }

  async finalize(runId: string, reason: string): Promise<string> {
    this.finalized = true;
    this.flush();
    this.writer?.end();
    this.writer = null;
    const summary = {
      version: 1 as const,
      runId,
      branchId: this.branchId,
      finalizedAt: Date.now(),
      reason,
      eventCount: this.seq,
    };
    const metaPath = this.logPath.replace(/\.jsonl$/, ".meta.json");
    try {
      await writeFile(metaPath, JSON.stringify(summary), "utf-8");
    } catch {}
    return this.logPath;
  }

  getLogPath(): string {
    return this.logPath;
  }
}

export async function readEventLog(path: string): Promise<ReplayEvent[]> {
  try {
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.map((l) => JSON.parse(l) as ReplayEvent);
  } catch {
    return [];
  }
}
