import { readdir, readFile, lstat } from "fs/promises";
import type { Dirent } from "fs";
import { execFile } from "child_process";
import { join, relative, sep } from "path";
import { mapPool } from "../parallel.js";
import type { FileChangeRecord, FileChangeOperation } from "./runReportData.js";

export interface WorkdirFileEntry {
  mtimeMs: number;
  size: number;
  /**
   * Legacy `snapshotWorkDir` walks read content eagerly ("" when unreadable
   * or the file is large). Metadata-only walkers store null until hydrated.
   */
  content: string | null;
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

// ─────────────────────────────────────────────────────────────────────
// Bash-command change detection (git fast path + parallel lazy walk)
// ─────────────────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 5_000;

function toRel(root: string, abs: string): string {
  const r = relative(root, abs);
  return r.split(sep).join("/");
}

async function execFileText(cmd: string, args: string[], cwd: string, maxBuffer = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer, timeout: GIT_TIMEOUT_MS, encoding: "utf-8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** One porcelain status entry, parsed from `git status --porcelain -z`. */
export interface GitStatusEntry {
  /** Two-char XY status code, e.g. "??", "M ", " M", "MM". */
  code: string;
  /** Slash-normalized repo-relative path. */
  path: string;
  /** Present for rename/copy entries (R/C). */
  origPath?: string;
}

/**
 * Parse `git status --porcelain -z` output. With `-z`, entries are
 * NUL-terminated; rename/copy entries are `<to>\0<from>\0`.
 */
export function parsePorcelainZ(stdout: string): GitStatusEntry[] {
  const out: GitStatusEntry[] = [];
  if (!stdout) return out;
  const parts = stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    if (!raw) continue;
    // Format: XY<space><path>
    const code = raw.slice(0, 2);
    const path = raw.slice(3);
    if (!path) continue;
    const entry: GitStatusEntry = { code, path: path.split(sep).join("/") };
    if ((code.includes("R") || code.includes("C")) && i + 1 < parts.length) {
      entry.origPath = parts[++i];
    }
    out.push(entry);
  }
  return out;
}

async function gitStatus(root: string): Promise<GitStatusEntry[]> {
  const stdout = await execFileText("git", ["status", "--porcelain", "-z"], root);
  return parsePorcelainZ(stdout);
}

/**
 * Read the pre-command content of a dirty tracked file: the content staged
 * in git's index (`:path`) is exactly the state before the bash command ran.
 */
async function gitIndexContent(root: string, relPath: string): Promise<string | null> {
  try {
    return await execFileText("git", ["show", `:${relPath}`], root, 8 * 1024 * 1024);
  } catch {
    return null;
  }
}

function toWorkdirFileEntry(path: string, stat: { mtimeMs: number; size: number }): [string, WorkdirFileEntry] {
  return [path.split(sep).join("/"), { mtimeMs: stat.mtimeMs, size: stat.size, content: null }];
}

/**
 * Snapshot taken before and after a `run_bash` command so its file changes
 * can be diffed for the run report.
 *
 * Unlike the legacy `snapshotWorkDir`, this is metadata-only: content is
 * never read during the snapshot and is hydrated lazily by
 * `diffBashSnapshots` for changed paths only.
 */
export interface GitDirtyEntry {
  code: string;
  /** lstat of the dirty file at snapshot time; 0 when stat failed. */
  mtimeMs: number;
  size: number;
}

export interface BashSnapshot {
  /** "git": from `git status --porcelain` (repo fast path). "walk": full walk fallback. */
  kind: "git" | "walk";
  /** Git mode: dirty path -> status code + stat captured at snapshot time. */
  status: Map<string, GitDirtyEntry>;
  /** Walk mode only: path -> mtime/size metadata (content always null). */
  files: Map<string, WorkdirFileEntry> | null;
}

/**
 * Fast per-bash snapshot.
 *
 * - Inside a git work tree: a single `git status --porcelain -z` call plus
 *   one lstat per dirty path (the dirty set is small).
 * - Otherwise: a parallel walk that records mtime+size only (no content reads).
 */
export async function snapshotWorkDirForBash(root: string, excludes: string[] = DEFAULT_EXCLUDES): Promise<BashSnapshot> {
  try {
    const entries = await gitStatus(root);
    const status = new Map<string, GitDirtyEntry>();
    const record = async (path: string, code: string) => {
      let mtimeMs = 0;
      let size = 0;
      try {
        const st = await lstat(join(root, path));
        mtimeMs = st.mtimeMs;
        size = st.size;
      } catch {
        // File vanished between status and stat; zeros still diff sanely.
      }
      status.set(path, { code, mtimeMs, size });
    };
    await mapPool(entries, 16, async (e) => {
      await record(e.path, e.code);
      if (e.origPath !== undefined) await record(e.origPath, e.code);
    });
    return { kind: "git", status, files: null };
  } catch {
    // Not a git repo (or git unavailable): fall back to a parallel walk.
  }
  const excludeSet = new Set(excludes);
  const files = new Map<string, WorkdirFileEntry>();
  await walkMeta(root, root, excludeSet, files);
  return { kind: "walk", status: new Map(), files };
}

/** Parallel metadata-only walk: same include/exclude rules as `walk`, no content reads. */
async function walkMeta(
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
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (excludeSet.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name !== ".gitignore" && entry.name !== ".env.example") continue;
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      subdirs.push(abs);
      continue;
    }
    if (!entry.isFile()) continue;
    let stat;
    try {
      stat = await lstat(abs);
    } catch {
      continue;
    }
    out.set(...toWorkdirFileEntry(toRel(root, abs), stat));
  }
  if (subdirs.length > 0) {
    await mapPool(subdirs, 8, (d) => walkMeta(root, d, excludeSet, out));
  }
}

/** Hydrate `content` for the given workdir paths (lazily, bounded pool). */
export async function hydrateSnapshotContents(
  root: string,
  paths: Iterable<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await mapPool([...paths], 16, async (relPath) => {
    try {
      out.set(relPath, await readFile(join(root, relPath), "utf-8"));
    } catch {
      // Deleted or unreadable between walk and read: leave absent.
    }
  });
  return out;
}

/** Convert a porcelain status code into the report's FileChangeOperation. */
function statusToOperation(code: string): FileChangeOperation {
  return code === "??" || code.startsWith("A") ? "create" : "edit";
}

/**
 * Diff two per-bash snapshots. O(changed paths): git mode diffs the status
 * maps directly; walk mode compares mtime+size and reads content only for
 * paths that changed.
 */
export async function diffBashSnapshots(
  root: string,
  before: BashSnapshot,
  after: BashSnapshot,
  step: number,
): Promise<FileChangeRecord[]> {
  if (before.kind === "git" && after.kind === "git") {
    return diffGitSnapshots(root, before.status, after.status, step);
  }
  if (before.files && after.files) {
    return diffWalkSnapshots(root, before.files, after.files, step);
  }
  // Mixed kinds (e.g. a repo appeared or vanished mid-command): nothing
  // comparable — report no changes rather than guessing.
  return [];
}

async function diffGitSnapshots(
  root: string,
  before: Map<string, GitDirtyEntry>,
  after: Map<string, GitDirtyEntry>,
  step: number,
): Promise<FileChangeRecord[]> {
  const changed: string[] = [];
  for (const [p, a] of after) {
    const b = before.get(p);
    if (!b) {
      // Newly dirty (or appeared mid-command).
      changed.push(p);
      continue;
    }
    if (b.code !== a.code) {
      // Status transition (e.g. " M" -> "MM", "??" added to index).
      changed.push(p);
      continue;
    }
    // Same status: a command may still have modified the file again.
    // The mtime+size captured at each snapshot detects this cheaply.
    if (b.mtimeMs !== a.mtimeMs || b.size !== a.size) {
      changed.push(p);
    }
  }
  for (const p of before.keys()) {
    if (!after.has(p)) changed.push(p); // deleted or resolved (commit/checkout)
  }
  if (changed.length === 0) return [];

  const hydrated = await hydrateSnapshotContents(root, changed);
  const out: FileChangeRecord[] = [];
  for (const p of changed) {
    const a = after.get(p);
    if (!a) {
      // Present before, absent now: deleted by the command (tracked as an
      // edit with empty after, matching the legacy diff semantics). The
      // pre-command content is the state in git's index.
      const b = before.get(p);
      const beforeContent = b && b.code === "??" ? undefined : await gitIndexContent(root, p);
      out.push(mkRecord(step, p, "edit", beforeContent ?? undefined, ""));
      continue;
    }
    const operation = statusToOperation(a.code);
    const beforeContent = operation === "edit" ? await gitIndexContent(root, p) : undefined;
    out.push(mkRecord(step, p, operation, beforeContent ?? undefined, hydrated.get(p) ?? ""));
  }
  out.sort((x, y) => x.path.localeCompare(y.path));
  return out;
}

async function diffWalkSnapshots(
  root: string,
  before: Map<string, WorkdirFileEntry>,
  after: Map<string, WorkdirFileEntry>,
  step: number,
): Promise<FileChangeRecord[]> {
  const changed: string[] = [];
  const deletions: string[] = [];
  for (const [p, a] of after) {
    const b = before.get(p);
    if (!b) {
      changed.push(p);
      continue;
    }
    if (b.mtimeMs === a.mtimeMs && b.size === a.size) continue;
    changed.push(p);
  }
  for (const p of before.keys()) {
    if (!after.has(p)) deletions.push(p);
  }
  if (changed.length === 0 && deletions.length === 0) return [];

  const hydrated = await hydrateSnapshotContents(root, changed);
  const out: FileChangeRecord[] = [];
  for (const p of changed) {
    const isNew = !before.has(p);
    out.push(mkRecord(step, p, isNew ? "create" : "edit", undefined, hydrated.get(p) ?? ""));
  }
  for (const p of deletions) {
    out.push(mkRecord(step, p, "edit", undefined, ""));
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
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
