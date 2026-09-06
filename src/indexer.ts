import { readFileSync } from "fs";
import { join, resolve } from "path";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { mapPool } from "./parallel.js";

const DB_FILENAME = ".9rh/repo-index.db";

/** Schema-compatible row type */
export interface RepoRecord {
  repoRoot: string;
  repoHash: string;
  sizeBytes: number;
  lastSeen: number;
  stale: number;
}

const DB_FIELDS = ["repoRoot", "repoHash", "sizeBytes", "lastSeen", "stale"] as const;

function dbPath(workDir: string): string {
  return resolve(workDir, DB_FILENAME);
}

function repoDir(workDir: string): string {
  return resolve(workDir, ".9rh");
}

// ─── Detection heuristics ──────────────────────────────────────────

const VCS_DIRS = new Set([".git", ".hg", ".svn"]);
const PROJECT_FILES = new Set([
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod",
  "Gemfile", "cabal.project", "project.clj", "mix.exs",
]);

async function isVcsRoot(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) {
      if (PROJECT_FILES.has(e.name)) return true;
      continue;
    }
    if (VCS_DIRS.has(e.name)) return true;
  }
  return false;
}

/**
 * Walk `root` looking for git/mercurial/svn repo roots, then return them as
 * realpath-deduped sorted absolute paths.
 *
 * Traversal rules:
 *  - `.git`/`.hg`/`.svn` directories are skipped at every depth (not just
 *    top-level); descending into `.git/objects` would be wasted I/O and
 *    a security smell.
 *  - Dotted directories other than `.config` are skipped at every depth.
 *  - Build / cache directories (`node_modules`, `target`, `dist`, `build`,
 *    `__pycache__`, `.venv`, `vendor`) are skipped.
 *
 * Symlink handling:
 *  - Each directory is resolved via `realpath` before being recorded,
 *    so the `seen` set deduplicates entries reached via different paths
 *    (e.g. a symlink to a sibling repo doesn't cause it to be reported
 *    twice). Returned paths are realpath-canonical.
 *
 * Errors (permission denied, broken symlinks) are skipped silently; the
 * walker tolerates a missing path without aborting the whole traversal.
 */
export async function findRepos(root: string, maxDepth = 6): Promise<string[]> {
  const results = new Set<string>();
  const seen = new Set<string>();

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    try {
      const resolved = await realpath(dir);
      // No await between check and add: the seen dedupe stays race-free.
      if (seen.has(resolved)) return;
      seen.add(resolved);
      if (await isVcsRoot(resolved)) {
        results.add(resolved);
        // Still recurse into children in case of monorepo
      }
      const entries = await readdir(resolved, { withFileTypes: true });
      const childDirs: string[] = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (VCS_DIRS.has(e.name)) continue; // skip .git contents
        if (e.name.startsWith(".") && e.name !== ".config") continue;
        if (SKIP_WALK_DIRS.has(e.name)) continue;
        childDirs.push(join(resolved, e.name));
      }
      await mapPool(childDirs, 8, (d) => walk(d, depth + 1));
    } catch {
      // permission denied etc: skip
    }
  };

  await walk(resolve(root), 0);
  return [...results].sort();
}

// ─── Hashing ───────────────────────────────────────────────────────

const HASH_IGNORE = new Set(["node_modules", ".git", ".hg", ".svn", "target", "dist", "build", "__pycache__", ".venv", "vendor", ".9rh", ".codegraph"]);
/** Directory names never descended into by findRepos (mirrors the old inline checks). */
const SKIP_WALK_DIRS = new Set(["node_modules", "target", "dist", "build", "__pycache__", ".venv", "vendor"]);

/**
 * Single-pass async walker: one traversal collects the file listing (for the
 * deterministic hash) and the total byte size that hashRepo + roughSize used
 * to produce in two separate full walks. Directories in HASH_IGNORE are
 * skipped identically to the legacy implementation. Hashing is CPU-light
 * (no content reads); files are stat'ed with bounded concurrency so large
 * trees stay responsive.
 */
async function hashAndSize(root: string): Promise<{ hash: string; bytes: number }> {
  const entries: string[] = [];
  let bytes = 0;

  const walk = async (dir: string): Promise<void> => {
    let dirEntries;
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files: string[] = [];
    const subdirs: string[] = [];
    for (const e of dirEntries) {
      if (HASH_IGNORE.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) subdirs.push(full);
      else if (e.isFile()) files.push(full);
    }
    await mapPool(files, 16, async (full) => {
      try {
        const st = await stat(full);
        entries.push(`${full}|${st.size}|${st.mtimeMs}`);
        bytes += st.size;
      } catch {
        // skip unreadable files
      }
    });
    await mapPool(subdirs, 8, walk);
  };

  await walk(root);
  const payload = entries.sort().join("\n");
  const hash = createHash("sha256").update(payload).digest("hex");
  return { hash, bytes };
}

/** Deterministic hash of file listing + sizes. Fast: no content reads. */
export async function hashRepo(root: string): Promise<string> {
  return (await hashAndSize(root)).hash;
}

// ─── DB (flat JSON file, compressed via gzip-like minification) ────
// Using JSON for zero deps. SQLite would add native build complexity.

interface Store {
  version: number;
  repos: RepoRecord[];
}

function loadStore(workDir: string): Store {
  const path = dbPath(workDir);
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.repos)) {
      return parsed as Store;
    }
  } catch {
    // corrupt or missing: return empty
  }
  return { version: 1, repos: [] };
}

async function saveStore(workDir: string, store: Store): Promise<void> {
  const dir = repoDir(workDir);
  await mkdir(dir, { recursive: true });
  // Compact JSON: no extra whitespace
  await writeFile(dbPath(workDir), JSON.stringify(store), "utf-8");
}

// ─── Public API ────────────────────────────────────────────────────

export class RepoIndexer {
  private workDir: string;
  private store: Store;

  constructor(workDir: string) {
    this.workDir = resolve(workDir);
    this.store = loadStore(this.workDir);
  }

  /** Full refresh: scan, hash, prune stale, persist. */
  async refresh(): Promise<RefreshResult> {
    const startMs = Date.now();
    const now = Date.now();
    const repos = await findRepos(this.workDir);

    // Build lookup of existing by root
    const existing = new Map<string, RepoRecord>();
    for (const r of this.store.repos) {
      existing.set(r.repoRoot, r);
    }

    const updated: RepoRecord[] = [];
    const seenRoots = new Set<string>();

    // Repo-level concurrency stays modest (2): each repo walk is itself
    // concurrently fanned out internally, so this bounds total FS pressure.
    const freshRecords = await mapPool(repos, 2, async (root) => {
      const { hash, bytes } = await hashAndSize(root);
      const existingRec = existing.get(root);
      if (existingRec && existingRec.repoHash === hash) {
        // Same hash: just bump lastSeen
        return { ...existingRec, lastSeen: now, stale: 0 };
      }
      return { repoRoot: root, repoHash: hash, sizeBytes: bytes, lastSeen: now, stale: 0 };
    });
    for (const root of repos) seenRoots.add(root);
    updated.push(...freshRecords);

    // Mark stale: rows whose root is no longer on disk
    for (const r of this.store.repos) {
      if (!seenRoots.has(r.repoRoot) && now - r.lastSeen < 24 * 60 * 60 * 1000) {
        // Keep but mark stale: this might be a temporary unmount
        updated.push({ ...r, stale: 1 });
      }
    }

    // Prune: delete stale entries older than 24h
    const pruned = updated.filter(r => !(r.stale === 1 && now - r.lastSeen > 24 * 60 * 60 * 1000));

    const next: Store = { version: 1, repos: pruned };
    await saveStore(this.workDir, next);
    this.store = next;

    return {
      elapsedMs: Date.now() - startMs,
      totalRepos: pruned.length,
      freshRepos: repos.length,
      staleRemoved: updated.length - pruned.length,
    };
  }

  /** Quick status: reads from the in-memory store, no re-scan */
  status(): IndexStatus {
    const now = Date.now();
    let totalSize = 0;
    let freshCount = 0;
    let staleCount = 0;
    let oldestMs = now;

    for (const r of this.store.repos) {
      totalSize += r.sizeBytes;
      if (r.stale) staleCount++;
      else freshCount++;
      if (r.lastSeen < oldestMs) oldestMs = r.lastSeen;
    }

    return {
      totalRepos: this.store.repos.length,
      freshRepos: freshCount,
      staleRepos: staleCount,
      totalSizeBytes: totalSize,
      oldestEntryAgeMs: now - oldestMs,
    };
  }

  /** Prune stale entries immediately. Persists before mutating in-memory
   *  state: same contract as refresh() (audit-fix A5). If saveStore throws,
   *  this.store must NOT be mutated and the caller is forced to handle the
   *  error. */
  async prune(): Promise<number> {
    const now = Date.now();
    const before = this.store.repos.length;
    const next = {
      version: 1 as const,
      repos: this.store.repos.filter(
        r => !(r.stale === 1 && now - r.lastSeen > 24 * 60 * 60 * 1000)
      ),
    };
    const removed = before - next.repos.length;
    if (removed === 0) return 0;
    await saveStore(this.workDir, next);
    this.store = next;
    return removed;
  }

  /** Get repo roots (fresh only) */
  listRepos(): string[] {
    return this.store.repos.filter(r => !r.stale).map(r => r.repoRoot);
  }
}

export interface RefreshResult {
  elapsedMs: number;
  totalRepos: number;
  freshRepos: number;
  staleRemoved: number;
}

export interface IndexStatus {
  totalRepos: number;
  freshRepos: number;
  staleRepos: number;
  totalSizeBytes: number;
  oldestEntryAgeMs: number;
}

// ─── Singleton per process ─────────────────────────────────────────

let globalIndexer: RepoIndexer | null = null;

function getIndexer(workDir: string): RepoIndexer {
  if (!globalIndexer) {
    globalIndexer = new RepoIndexer(workDir);
  }
  return globalIndexer;
}

export async function ensureRepoIndex(workDir: string): Promise<RefreshResult> {
  const indexer = getIndexer(workDir);
  return indexer.refresh();
}

export async function getRepoIndexStatus(workDir: string): Promise<IndexStatus> {
  const indexer = getIndexer(workDir);
  return indexer.status();
}

export async function forceReindex(workDir: string): Promise<RefreshResult> {
  const indexer = getIndexer(workDir);
  return indexer.refresh();
}

export async function pruneStaleRepos(workDir: string): Promise<number> {
  const indexer = getIndexer(workDir);
  return indexer.prune();
}
