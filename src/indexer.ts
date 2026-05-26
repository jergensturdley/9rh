import { existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { mkdir, readFile, writeFile } from "fs/promises";
import { createHash } from "crypto";

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

function isVcsRoot(dir: string): boolean {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) {
      if (PROJECT_FILES.has(e.name)) return true;
      continue;
    }
    if (VCS_DIRS.has(e.name)) return true;
  }
  return false;
}

/** Walk up to `maxDepth` looking for repo roots. Returns sorted deduped paths. */
export function findRepos(root: string, maxDepth = 6): string[] {
  const results = new Set<string>();
  const seen = new Set<string>();

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    const resolved = resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    try {
      if (isVcsRoot(resolved)) {
        results.add(resolved);
        // Still recurse into children in case of monorepo
      }
      const entries = readdirSync(resolved, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (VCS_DIRS.has(e.name)) continue; // skip .git contents
        if (e.name.startsWith(".") && e.name !== ".config") continue;
        if (e.name === "node_modules" || e.name === "target" || e.name === "dist" || e.name === "build" || e.name === "__pycache__" || e.name === ".venv" || e.name === "vendor") continue;
        walk(join(resolved, e.name), depth + 1);
      }
    } catch {
      // permission denied etc — skip
    }
  }

  walk(resolve(root), 0);
  return [...results].sort();
}

// ─── Hashing ───────────────────────────────────────────────────────

const HASH_IGNORE = new Set(["node_modules", ".git", ".hg", ".svn", "target", "dist", "build", "__pycache__", ".venv", "vendor", ".9rh", ".codegraph"]);

/** Deterministic hash of file listing + sizes. Fast — no content reads. */
export function hashRepo(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    let dirEntries;
    try {
      dirEntries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of dirEntries) {
      if (HASH_IGNORE.has(e.name)) continue;
      const full = join(dir, e.name);
      try {
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          const st = statSync(full);
          entries.push(`${full}|${st.size}|${st.mtimeMs}`);
        }
      } catch {
        // skip unreadable files
      }
    }
  };
  walk(root);
  const payload = entries.sort().join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

function roughSize(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (HASH_IGNORE.has(e.name)) continue;
      const full = join(dir, e.name);
      try {
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          total += statSync(full).size;
        }
      } catch {
        // skip
      }
    }
  };
  walk(root);
  return total;
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
    // corrupt or missing — return empty
  }
  return { version: 1, repos: [] };
}

function saveStore(workDir: string, store: Store): void {
  const dir = repoDir(workDir);
  if (!existsSync(dir)) {
    mkdir(dir, { recursive: true }).catch(() => {});
  }
  // Compact JSON — no extra whitespace
  writeFile(dbPath(workDir), JSON.stringify(store), "utf-8").catch(() => {});
}

// Needed for sync loadStore
import { readFileSync } from "fs";

// ─── Public API ────────────────────────────────────────────────────

export class RepoIndexer {
  private workDir: string;
  private store: Store;

  constructor(workDir: string) {
    this.workDir = resolve(workDir);
    this.store = loadStore(this.workDir);
  }

  /** Full refresh: scan, hash, prune stale, persist. */
  refresh(): RefreshResult {
    const startMs = Date.now();
    const now = Date.now();
    const repos = findRepos(this.workDir);

    // Build lookup of existing by root
    const existing = new Map<string, RepoRecord>();
    for (const r of this.store.repos) {
      existing.set(r.repoRoot, r);
    }

    const updated: RepoRecord[] = [];
    const seenRoots = new Set<string>();

    for (const root of repos) {
      seenRoots.add(root);
      const hash = hashRepo(root);
      const size = roughSize(root);
      const existingRec = existing.get(root);
      if (existingRec && existingRec.repoHash === hash) {
        // Same hash — just bump lastSeen
        updated.push({ ...existingRec, lastSeen: now, stale: 0 });
      } else {
        updated.push({ repoRoot: root, repoHash: hash, sizeBytes: size, lastSeen: now, stale: 0 });
      }
    }

    // Mark stale: rows whose root is no longer on disk
    for (const r of this.store.repos) {
      if (!seenRoots.has(r.repoRoot) && now - r.lastSeen < 24 * 60 * 60 * 1000) {
        // Keep but mark stale — might be temporary unmount
        updated.push({ ...r, stale: 1 });
      }
    }

    // Prune: delete stale entries older than 24h
    const pruned = updated.filter(r => !(r.stale === 1 && now - r.lastSeen > 24 * 60 * 60 * 1000));

    this.store = { version: 1, repos: pruned };
    saveStore(this.workDir, this.store);

    return {
      elapsedMs: Date.now() - startMs,
      totalRepos: pruned.length,
      freshRepos: repos.length,
      staleRemoved: updated.length - pruned.length,
    };
  }

  /** Quick status — reads from in-memory store, no re-scan */
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

  /** Prune stale entries immediately */
  prune(): number {
    const now = Date.now();
    const before = this.store.repos.length;
    this.store.repos = this.store.repos.filter(
      r => !(r.stale === 1 && now - r.lastSeen > 24 * 60 * 60 * 1000)
    );
    const removed = before - this.store.repos.length;
    saveStore(this.workDir, this.store);
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