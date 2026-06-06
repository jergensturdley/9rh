import { readdir, readFile, lstat } from "fs/promises";
import type { Dirent } from "fs";
import { join, relative, sep } from "path";
import type { FileChangeRecord, FileChangeOperation } from "./runReportData.js";

export interface WorkdirFileEntry {
  mtimeMs: number;
  size: number;
  content: string;
}

const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".DS_Store",
  ".tmp",
  ".swp",
  ".bak",
  "logs",
];

export async function snapshotWorkDir(
  workDir: string,
  excludes: string[] = DEFAULT_EXCLUDES,
): Promise<Map<string, WorkdirFileEntry>> {
  const out = new Map<string, WorkdirFileEntry>();
  const excludeSet = new Set(excludes);
  await walk(workDir, workDir, excludeSet, out);
  return out;
}

async function walk(
  root: string,
  dir: string,
  excludeSet: Set<string>,
  out: Map<string, WorkdirFileEntry>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") {
      if (entry.name !== ".gitignore" && entry.name !== ".env.example") continue;
    }
    if (excludeSet.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    let stat;
    try {
      stat = await lstat(abs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    const rel = toRel(root, abs);
    if (stat.isDirectory()) {
      await walk(root, abs, excludeSet, out);
      continue;
    }
    if (!stat.isFile()) continue;
    let content = "";
    if (stat.size <= 32_000) {
      try {
        content = await readFile(abs, "utf-8");
      } catch {
        content = "";
      }
    }
    out.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size, content });
  }
}

function toRel(root: string, abs: string): string {
  const r = relative(root, abs);
  return r.split(sep).join("/");
}

export function diffSnapshots(
  before: Map<string, WorkdirFileEntry>,
  after: Map<string, WorkdirFileEntry>,
  step: number,
): FileChangeRecord[] {
  const out: FileChangeRecord[] = [];
  for (const [path, a] of after) {
    const b = before.get(path);
    if (!b) {
      out.push(mkRecord(step, path, "create", undefined, a.content));
      continue;
    }
    if (b.mtimeMs === a.mtimeMs && b.size === a.size) continue;
    out.push(mkRecord(step, path, "edit", b.content, a.content));
  }
  for (const [path, b] of before) {
    if (after.has(path)) continue;
    out.push(mkRecord(step, path, "edit", b.content, ""));
  }
  return out;
}

function mkRecord(
  step: number,
  path: string,
  operation: FileChangeOperation,
  before: string | undefined,
  after: string,
): FileChangeRecord {
  const MAX = 32_000;
  let beforeTruncated: boolean | undefined;
  let afterTruncated: boolean | undefined;
  if (before !== undefined && before.length > MAX) {
    before = before.slice(0, MAX);
    beforeTruncated = true;
  }
  if (after.length > MAX) {
    after = after.slice(0, MAX);
    afterTruncated = true;
  }
  return { step, path, operation, before, after, beforeTruncated, afterTruncated };
}
