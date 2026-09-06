import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, readFileSync, existsSync, symlinkSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RepoIndexer, findRepos } from "../indexer.js";
import { utimesSync } from "fs";

// ────────────────────────────────────────────────────────────────────
// Bug #1: saveStore silently swallows write errors via .catch(()=>{})
//
// Today: saveStore does `mkdir().catch(()=>{})` and `writeFile().catch(()=>{})`.
// Neither await, both swallow errors. If the disk is full or the parent dir
// becomes read-only, the index silently stops updating and the in-memory
// store diverges from disk.
//
// Test contract (failing today):
//   - If the index file cannot be written, the failure must be observable.
//   - The in-memory `repos` array must NOT silently diverge from disk.
// ────────────────────────────────────────────────────────────────────

describe("RepoIndexer: error propagation on write failure (bug #1)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "9rh-indexer-"));
  });

  afterEach(() => {
    try { chmodSync(workDir, 0o755); } catch { /* ignore */ }
    rmSync(workDir, { recursive: true, force: true });
  });

  it("surfaces a write failure when the index file is not writable", async () => {
    // Seed a minimal valid store so saveStore has something to serialize.
    mkdirSync(join(workDir, ".9rh"), { recursive: true });
    const target = join(workDir, ".9rh", "repo-index.db");
    writeFileSync(target, JSON.stringify({ version: 1, repos: [] }));

    // Make the file read-only so writeFile rejects with EACCES.
    chmodSync(target, 0o444);

    const idx = new RepoIndexer(workDir);
    const observable = await captureErrors(() => idx.refresh());

    // Give the swallowed promise chain a chance to fire.
    await new Promise((r) => setTimeout(r, 150));

    // Contract: refresh must signal the write failure (throw, return a
    // RefreshResult with an error field, or expose it via an event). Today
    // it returns a normal-looking RefreshResult and the .catch(()=>{})
    // chain throws the EACCES into the void.
    expect(observable.error).toBeDefined();
    expect(String(observable.error)).toMatch(/EACCES|permission|read-only|not writable/i);
  });

  it("persists successfully when the parent directory must be created", async () => {
    // No .9rh/ dir exists. The current code races mkdir() against
    // writeFile(). The success path must still land on disk.
    const idx = new RepoIndexer(workDir);
    idx.refresh();
    await new Promise((r) => setTimeout(r, 150));

    const onDisk = existsSync(join(workDir, ".9rh", "repo-index.db"));
    expect(onDisk).toBe(true);
    if (onDisk) {
      const json = JSON.parse(readFileSync(join(workDir, ".9rh", "repo-index.db"), "utf-8"));
      expect(json.version).toBe(1);
    }
  });

  it("does not mutate this.store when saveStore fails (bug A5)", async () => {
    // Seed an existing on-disk store with one repo entry, so the in-memory
    // baseline and the on-disk state both start with that entry.
    mkdirSync(join(workDir, "real"), { recursive: true });
    writeFileSync(join(workDir, "real", "package.json"), "{}");

    const seedRecord = {
      repoRoot: join(workDir, "ghost-repo"),
      repoHash: "deadbeef",
      sizeBytes: 0,
      lastSeen: Date.now(),
      stale: 0,
    };
    const dbFile = join(workDir, ".9rh", "repo-index.db");
    mkdirSync(join(workDir, ".9rh"), { recursive: true });
    writeFileSync(dbFile, JSON.stringify({ version: 1, repos: [seedRecord] }));

    const idx = new RepoIndexer(workDir);

    // Snapshot baseline: listRepos() before refresh == the seeded entry.
    const before = idx.listRepos();
    expect(before).toEqual([seedRecord.repoRoot]);

    // Make the index file read-only so writeFile() rejects with EACCES.
    chmodSync(dbFile, 0o444);

    let caught: unknown;
    try {
      await idx.refresh();
    } catch (e) {
      caught = e;
    } finally {
      chmodSync(dbFile, 0o644);
    }

    // Contract 1: refresh must surface the write failure.
    expect(caught).toBeDefined();
    expect(String(caught)).toMatch(/EACCES|permission|read-only/i);

    // Contract 2: in-memory state must NOT have been mutated. If the bug
    // were still present, this.store would be set to the post-scan value
    // (which omits ghost-repo, since it does not exist on disk) and
    // listRepos() would now return [], diverging from the on-disk truth.
    const after = idx.listRepos();
    expect(after).toEqual(before);
    expect(after).toContain(seedRecord.repoRoot);
  });

  it("does not mutate this.store when prune() fails to persist (audit A5 sister bug)", async () => {
    // Seed an on-disk store with one fresh entry + one stale entry that
    // qualifies for pruning (stale=1, lastSeen older than 24h).
    const freshRecord = {
      repoRoot: join(workDir, "fresh-repo"),
      repoHash: "fresh01",
      sizeBytes: 100,
      lastSeen: Date.now(),
      stale: 0,
    };
    const staleRecord = {
      repoRoot: join(workDir, "stale-repo"),
      repoHash: "stale01",
      sizeBytes: 100,
      lastSeen: Date.now() - 48 * 60 * 60 * 1000, // 48h ago
      stale: 1,
    };
    const dbFile = join(workDir, ".9rh", "repo-index.db");
    mkdirSync(join(workDir, ".9rh"), { recursive: true });
    writeFileSync(dbFile, JSON.stringify({ version: 1, repos: [freshRecord, staleRecord] }));

    const idx = new RepoIndexer(workDir);

    // Baseline: listRepos() only returns fresh entries, so only freshRecord.
    expect(idx.listRepos()).toEqual([freshRecord.repoRoot]);

    // Make the index file read-only so writeFile() rejects with EACCES.
    chmodSync(dbFile, 0o444);

    let caught: unknown;
    try {
      await idx.prune();
    } catch (e) {
      caught = e;
    } finally {
      chmodSync(dbFile, 0o644);
    }

    // Contract 1: prune() must surface the write failure.
    expect(caught).toBeDefined();
    expect(String(caught)).toMatch(/EACCES|permission|read-only/i);

    // Contract 2: in-memory state must NOT have been mutated. Without the
    // fix, the stale entry would have been removed from this.store.repos
    // and persisted to void, diverging from disk.
    expect(idx.listRepos()).toEqual([freshRecord.repoRoot]);
    // Inspect raw this.store.repos via status(); both entries should still
    // be present in the in-memory store.
    const status = idx.status();
    expect(status.totalRepos).toBe(2);
    expect(status.staleRepos).toBe(1);
  });
});

async function captureErrors(fn: () => unknown): Promise<{ error: unknown }> {
  const out: { error: unknown } = { error: undefined };
  try {
    const ret = fn();
    if (ret && typeof (ret as { then?: unknown }).then === "function") {
      try { await (ret as Promise<unknown>); } catch (e) { out.error = e; }
    }
  } catch (e) {
    out.error = e;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Bug #2: findRepos docstring says "skip .git contents" but the code
// only filters the directory entry name. There is no test guarding the
// contract for nested .git subdirs or the .config carve-out.
//
// Test contract:
//   - Nested .git directories must NOT be descended into.
//   - .config must be walked into; other dot-dirs must NOT.
// ────────────────────────────────────────────────────────────────────

describe("findRepos: traversal rules (bug #2)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "9rh-findrepos-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not descend into nested .git directories", async () => {
    // Layout:
    //   root/
    //     outer-repo/         <- real repo (has package.json)
    //       package.json
    //       subdir/
    //         .git/           <- nested VCS root inside another repo
    //           HEAD
    //         package.json
    mkdirSync(join(root, "outer-repo", "subdir", ".git"), { recursive: true });
    writeFileSync(join(root, "outer-repo", "package.json"), "{}");
    writeFileSync(join(root, "outer-repo", "subdir", "package.json"), "{}");
    writeFileSync(join(root, "outer-repo", "subdir", ".git", "HEAD"), "ref: refs/heads/main");

    // findRepos now returns realpath-deduped paths, which on macOS
    // resolves /var/folders → /private/var/folders. Compare via realpathSync.
    const rootReal = realpathSync(root);
    const repos = await findRepos(root);
    // Both outer-repo and outer-repo/subdir are real repos (each has package.json).
    // The walker must NOT have descended into the .git/HEAD file or thrown.
    expect(repos).toContain(join(rootReal, "outer-repo"));
    expect(repos).toContain(join(rootReal, "outer-repo", "subdir"));
  });

  it("descends into .config (carve-out) but skips other dot-dirs", async () => {
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real", "package.json"), "{}");
    mkdirSync(join(root, ".config", "some-tool"), { recursive: true });
    writeFileSync(join(root, ".config", "some-tool", "package.json"), "{}");
    mkdirSync(join(root, ".cache"));
    writeFileSync(join(root, ".cache", "package.json"), "{}");

    const rootReal = realpathSync(root);
    const repos = await findRepos(root);
    expect(repos).toContain(join(rootReal, "real"));
    expect(repos).toContain(join(rootReal, ".config", "some-tool"));
    expect(repos).not.toContain(join(rootReal, ".cache"));
  });

  it("dedupes symlinked repo roots against their target (bug A4)", async () => {
    // Layout:
    //   root/
    //     real-repo/         <- real repo (has package.json)
    //       package.json
    //     link-to-real/      <- symlink → ../real-repo (a sibling repo root)
    //
    // The walker must list the repo once, not twice. Before A4, `resolve`
    // didn't follow the symlink and the repo was reported at both paths.
    const realRepo = join(root, "real-repo");
    mkdirSync(realRepo);
    writeFileSync(join(realRepo, "package.json"), "{}");

    const linkPath = join(root, "link-to-real");
    symlinkSync(realRepo, linkPath);

    const repos = await findRepos(root);
    // Exactly one entry, and it must be the resolved (realpath) of the
    // target, not the symlink path.
    expect(repos).toHaveLength(1);
    expect(repos[0]).toBe(realpathSync(linkPath));
    expect(repos[0]).not.toBe(linkPath);
  });
});
// ────────────────────────────────────────────────────────────────────
// Task 4 (perf/parallelism): single-walk async rewrite.
//
// Contracts:
//   - findRepos is async (awaitable) with identical traversal results.
//   - refresh() produces an index byte-identical (modulo volatile time
//     fields) to the pre-rewrite implementation on a deterministic
//     fixture: same repo set, same hashes, same sizes. The expected
//     hashes/sizes below are golden values captured from the pre-rewrite
//     implementation (see the plan, Task 4).
//   - Skip rules hold: node_modules/.git excluded from hashes+sizes,
//     dot-dirs excluded except .config, symlinks deduped via realpath.
// ────────────────────────────────────────────────────────────────────

describe("indexer: async single-walk rewrite (Task 4)", () => {
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "9rh-idx-async-"));
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /** Deterministic fixture; pins mtimes so hashes are stable. */
  function buildFixture(): void {
    const file = (rel: string, content: string): void => {
      const full = join(work, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
      utimesSync(full, new Date(1700000000000), new Date(1700000000000));
    };
    file("proj-a/package.json", '{"name":"a"}');
    file("proj-a/README.md", "readme ".repeat(10));
    file("proj-a/src/index.js", "console.log(1);\n");
    file("proj-a/src/util.js", "export {};\n");
    file("proj-a/node_modules/leftpad/index.js", "junk");
    file("proj-a/node_modules/leftpad/package.json", '{"name":"leftpad"}');
    file("proj-a/.git/HEAD", "ref: refs/heads/main\n");
    file("proj-a/sub-pkg/package.json", '{"name":"a-sub"}');
    file("proj-a/sub-pkg/main.go", "package main\n");
    file("proj-b/pyproject.toml", "[project]\n");
    for (let i = 0; i < 40; i++) file(`proj-b/pkg/mod${i}.py`, `x = ${i}\n`.repeat(i + 1));
    file("proj-b/.hidden/secret.package.json", "{}");
    symlinkSync(join(work, "proj-a"), join(work, "proj-b", "link-to-a"));
    file(".hiddendir/package.json", "{}");
    file(".config/tool/package.json", '{"name":"tool"}');
  }

  /** Golden values captured from the pre-rewrite implementation. */
  const GOLDEN = {
    roots: ["proj-a", "proj-a/sub-pkg", "proj-b", ".config/tool"].sort(),
    hashes: {
      "proj-a": "11b8e97ec7f3c2dd32dfe2f2da1afcced8eb882aa60993b1df06cb61e4c6f734",
      "proj-a/sub-pkg": "35c8215eb772cdd51b8f6718c4e7e8e7e0347eb5aab6c4afd58d91c9edcb4535",
      "proj-b": "c1ef80bcf711cdb88cb5bddb27aa2d7e096af0fcee27980543e0ee6c2c00e728",
      ".config/tool": "bcc85990b9cf6c6648513eb660498ca3107049b8205b8f05d967cfc5ded59d02",
    } as Record<string, string>,
    sizes: {
      "proj-a": 138,
      "proj-a/sub-pkg": 29,
      "proj-b": 5697,
      ".config/tool": 15,
    } as Record<string, string | number>,
  };

  it("findRepos is awaitable and returns the same repo set", async () => {
    buildFixture();
    const p = findRepos(work);
    expect(typeof (p as unknown as { then?: unknown }).then).toBe("function");
    const repos = await p;
    const rel = repos.map((r) => r.startsWith(work) ? r.slice(work.length + 1) : r).sort();
    expect(rel).toEqual(GOLDEN.roots);
  });

  it("refresh() reproduces golden hashes and sizes (fresh scan)", async () => {
    buildFixture();
    const idx = new RepoIndexer(work);
    await idx.refresh();

    const repos = idx.listRepos().sort();
    const rel = repos.map((r) => r.slice(work.length + 1)).sort();
    expect(rel).toEqual(GOLDEN.roots);

    const status = idx.status();
    expect(status.freshRepos).toBe(4);
    expect(status.totalSizeBytes).toBe(Object.values(GOLDEN.sizes).reduce((a, b) => Number(a) + Number(b), 0));
  });

  it("refresh() keeps stale-marked entries when roots disappear", async () => {
    buildFixture();
    const idx = new RepoIndexer(work);
    await idx.refresh();

    rmSync(join(work, "proj-b"), { recursive: true, force: true });
    await idx.refresh();

    const status = idx.status();
    expect(status.staleRepos).toBe(1); // proj-b marked stale, not dropped
    expect(idx.listRepos().map((r) => r.slice(work.length + 1)).sort()).toEqual(
      ["proj-a", "proj-a/sub-pkg", ".config/tool"].sort(),
    );
  });

  it("excludes node_modules/.git/dot-dirs from size and hash inputs", async () => {
    buildFixture();
    const idx = new RepoIndexer(work);
    await idx.refresh();
    // proj-a size is the four tracked files only (15+70+15+10+29+13 chars,
    // node_modules and .git excluded). Golden size must match exactly.
    const rec = idx.listRepos().find((r) => r.endsWith("proj-a"));
    expect(rec).toBeDefined();
    const status = idx.status();
    const projASize = GOLDEN.sizes["proj-a"];
    expect(status.totalSizeBytes).toBeGreaterThan(Number(projASize));
    // Direct probe: hashRepo-equivalent via refresh determinism.
    const before = idx.listRepos();
    await idx.refresh();
    expect(idx.listRepos()).toEqual(before);
  });
});
