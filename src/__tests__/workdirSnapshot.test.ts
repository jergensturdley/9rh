import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  snapshotWorkDirForBash,
  diffBashSnapshots,
} from "../reports/workdirSnapshot.js";

let root: string;

function git(args: string[], opts: { allowFailure?: boolean } = {}): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf-8" });
  } catch (e) {
    if (opts.allowFailure) return "";
    throw e;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "9rh-workdirsnap-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function snap() {
  return snapshotWorkDirForBash(root);
}

describe("snapshotWorkDirForBash (non-git walk fallback)", () => {
  it("returns kind 'walk' with metadata for nested files and null content", async () => {
    mkdirSync(join(root, "a/b"), { recursive: true });
    writeFileSync(join(root, "a/b/f.txt"), "hello");
    writeFileSync(join(root, "top.txt"), "world");

    const s = await snap();
    expect(s.kind).toBe("walk");
    expect(s.files).not.toBeNull();
    const keys = [...s.files!.keys()].sort();
    expect(keys).toEqual(["a/b/f.txt", "top.txt"]);
    expect(s.files!.get("top.txt")).toMatchObject({ size: 5, content: null });
  });

  it("walk diff detects create, edit, and deletion with after-content hydrated", async () => {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub/edited.txt"), "v1");
    writeFileSync(join(root, "gone.txt"), "bye");

    const before = await snap();

    writeFileSync(join(root, "sub/edited.txt"), "v2");
    writeFileSync(join(root, "new.txt"), "fresh");
    rmSync(join(root, "gone.txt"));

    const after = await snap();
    const diffs = await diffBashSnapshots(root, before, after, 3);

    const byRel = new Map(diffs.map((d) => [d.path, d]));
    expect(byRel.get("new.txt")).toMatchObject({ step: 3, operation: "create" });
    expect(byRel.get("new.txt")?.after).toBe("fresh");
    expect(byRel.get("sub/edited.txt")).toMatchObject({ step: 3, operation: "edit" });
    expect(byRel.get("sub/edited.txt")?.after).toBe("v2");
    // Walk mode cannot know pre-command content without reading everything;
    // before content is omitted by design.
    expect(byRel.get("sub/edited.txt")?.before).toBeUndefined();
    // Deletion is recorded as an edit with empty after content (existing semantics).
    expect(byRel.get("gone.txt")).toMatchObject({ step: 3, operation: "edit" });
    expect(byRel.get("gone.txt")?.after).toBe("");
    expect(diffs).toHaveLength(3);
  });

  it("returns no changes when nothing changed", async () => {
    writeFileSync(join(root, "stable.txt"), "same");
    const before = await snap();
    const after = await snap();
    const diffs = await diffBashSnapshots(root, before, after, 1);
    expect(diffs).toEqual([]);
  });

  it("excludes default directories and dotfiles like the old walker", async () => {
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules/pkg/index.js"), "x");
    writeFileSync(join(root, ".secret"), "s");
    writeFileSync(join(root, ".gitignore"), "ok");

    const s = await snap();
    expect([...s.files!.keys()]).toEqual([".gitignore"]);
  });
});

describe("snapshotWorkDirForBash (git fast path)", () => {
  beforeEach(() => {
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
  });

  it("returns kind 'git' with empty status on a clean tree", async () => {
    const s = await snap();
    expect(s.kind).toBe("git");
    expect(s.status.size).toBe(0);
  });

  it("detects an untracked file as a create record", async () => {
    const before = await snap();
    writeFileSync(join(root, "made-by-bash.txt"), "output");
    const after = await snap();

    const diffs = await diffBashSnapshots(root, before, after, 7);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ step: 7, path: "made-by-bash.txt", operation: "create" });
    expect(diffs[0].after).toBe("output");
    expect(diffs[0].before).toBeUndefined();
  });

  it("detects a modified tracked file as an edit with before content from the index", async () => {
    const before = await snap();
    writeFileSync(join(root, "tracked.txt"), "changed\n");
    const after = await snap();

    const diffs = await diffBashSnapshots(root, before, after, 2);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ path: "tracked.txt", operation: "edit" });
    expect(diffs[0].before).toBe("base\n");
    expect(diffs[0].after).toBe("changed\n");
  });

  it("catches a second modification of an already-dirty tracked file (mtime gate)", async () => {
    // Step A: first modification.
    const s0 = await snap();
    writeFileSync(join(root, "tracked.txt"), "step-a\n");
    const s1 = await snap();
    const diffsA = await diffBashSnapshots(root, s0, s1, 1);
    expect(diffsA.map((d) => d.operation)).toEqual(["edit"]);

    // Step B: file is still dirty ('M' in both snapshots) but changed again.
    writeFileSync(join(root, "tracked.txt"), "step-b-longer\n");
    const s2 = await snap();
    const diffsB = await diffBashSnapshots(root, s1, s2, 2);
    expect(diffsB).toHaveLength(1);
    expect(diffsB[0]).toMatchObject({ path: "tracked.txt", operation: "edit" });
    expect(diffsB[0].after).toBe("step-b-longer\n");
  });

  it("catches a second modification of an already-untracked file", async () => {
    writeFileSync(join(root, "log.txt"), "one\n");
    const s0 = await snap();
    writeFileSync(join(root, "log.txt"), "one\ntwo\n");
    const s1 = await snap();
    const diffs = await diffBashSnapshots(root, s0, s1, 4);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ path: "log.txt", operation: "create" });
    expect(diffs[0].after).toBe("one\ntwo\n");
  });

  it("records a deleted tracked file as an edit with empty after", async () => {
    const before = await snap();
    rmSync(join(root, "tracked.txt"));
    const after = await snap();

    const diffs = await diffBashSnapshots(root, before, after, 5);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ path: "tracked.txt", operation: "edit" });
    expect(diffs[0].after).toBe("");
  });

  it("returns no changes when the command did nothing", async () => {
    const before = await snap();
    const after = await snap();
    const diffs = await diffBashSnapshots(root, before, after, 1);
    expect(diffs).toEqual([]);
  });

  it("does not include ignored or clean files in the diff", async () => {
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    const s0 = await snap(); // .gitignore itself now dirty
    writeFileSync(join(root, "ignored.txt"), "noise");
    const s1 = await snap();
    const diffs = await diffBashSnapshots(root, s0, s1, 1);
    // ignored.txt never appears; only the initial .gitignore dirt exists in both
    // snapshots unchanged.
    expect(diffs).toEqual([]);
  });
});

describe("snapshotWorkDirForBash: workDir inside a repo subdirectory (relative-path correctness)", () => {
  let repoRoot: string;
  let subDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "9rh-workdirsnap-root-"));
    subDir = join(repoRoot, "packages/app");
    mkdirSync(subDir, { recursive: true });
    // Shell out in the repo root so the fixture is a real repo.
    const g = (args: string[], cwd: string) =>
      execFileSync("git", args, { cwd, encoding: "utf-8" });
    g(["init", "-q"], repoRoot);
    g(["config", "user.email", "test@example.com"], repoRoot);
    g(["config", "user.name", "Test"], repoRoot);
    writeFileSync(join(subDir, "tracked.txt"), "base\n");
    g(["add", "."], repoRoot);
    g(["commit", "-q", "-m", "init"], repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("snapshots taken from a subdir attribute changes to workDir-relative paths", async () => {
    const before = await snapshotWorkDirForBash(subDir);
    writeFileSync(join(subDir, "tracked.txt"), "changed\n");
    const after = await snapshotWorkDirForBash(subDir);

    expect(before.kind).toBe("git");
    const diffs = await diffBashSnapshots(subDir, before, after, 1);
    expect(diffs).toHaveLength(1);
    // Must be workDir-relative ("tracked.txt"), never repo-root-relative
    // ("packages/app/tracked.txt") — the report joins these onto workDir.
    expect(diffs[0].path).toBe("tracked.txt");
    expect(diffs[0].before).toBe("base\n");
    expect(diffs[0].after).toBe("changed\n");
  });

  it("detects a new untracked file in a nested subdir of the workDir", async () => {
    const before = await snapshotWorkDirForBash(subDir);
    mkdirSync(join(subDir, "nested"));
    writeFileSync(join(subDir, "nested/out.txt"), "log\n");
    const after = await snapshotWorkDirForBash(subDir);

    const diffs = await diffBashSnapshots(subDir, before, after, 2);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ path: "nested/out.txt", operation: "create" });
  });
});

describe("snapshotWorkDirForBash: mixed snapshot kinds", () => {
  it("diffing a git snapshot against a walk snapshot returns [] (documented, no guessing)", async () => {
    // Git repo fixture.
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    const gitSnap = await snapshotWorkDirForBash(root);
    expect(gitSnap.kind).toBe("git");

    // A non-git directory produces a walk snapshot.
    const plain = mkdtempSync(join(tmpdir(), "9rh-workdirsnap-plain-"));
    try {
      writeFileSync(join(plain, "f.txt"), "x");
      const walkSnap = await snapshotWorkDirForBash(plain);
      expect(walkSnap.kind).toBe("walk");

      const diffsGitWalk = await diffBashSnapshots(root, gitSnap, walkSnap, 1);
      const diffsWalkGit = await diffBashSnapshots(root, walkSnap, gitSnap, 1);
      expect(diffsGitWalk).toEqual([]);
      expect(diffsWalkGit).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
