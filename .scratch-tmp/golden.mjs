// Golden harness for the indexer rewrite (Task 4).
// Builds a deterministic fixture tree (fixed path, pinned mtimes), runs two
// refresh passes (fresh + after an edit), and prints normalized index JSON.
// Run BEFORE the rewrite and AFTER; the outputs must be identical.
import { rmSync, mkdirSync, writeFileSync, utimesSync, readFileSync, symlinkSync } from "fs";
import { join, dirname } from "path";
import { ensureRepoIndex } from "/Volumes/M.2 2TB/code/9rh/dist/indexer.js";

const WORK = "/Volumes/M.2 2TB/code/9rh/.scratch-tmp/golden-work";
const MTIME = 1700000000000; // pinned mtime so hashes are stable across runs

rmSync(WORK, { recursive: true, force: true });

function file(rel, content) {
  const full = join(WORK, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  utimesSync(full, new Date(MTIME), new Date(MTIME));
}

// proj-a: npm-style repo with ignored junk and a nested sub-repo
file("proj-a/package.json", '{"name":"a"}');
file("proj-a/README.md", "readme ".repeat(10));
file("proj-a/src/index.js", "console.log(1);\n");
file("proj-a/src/util.js", "export {};\n");
file("proj-a/node_modules/leftpad/index.js", "junk");
file("proj-a/node_modules/leftpad/package.json", '{"name":"leftpad"}');
file("proj-a/.git/HEAD", "ref: refs/heads/main\n");
file("proj-a/sub-pkg/package.json", '{"name":"a-sub"}');
file("proj-a/sub-pkg/main.go", "package main\n");
// proj-b: python-style repo with many small files + symlink to sibling repo
file("proj-b/pyproject.toml", "[project]\n");
for (let i = 0; i < 40; i++) file(`proj-b/pkg/mod${i}.py`, `x = ${i}\n`.repeat(i + 1));
file("proj-b/.hidden/secret.package.json", "{}"); // inside repo, dot-dir name only matters at walk level
symlinkSync(join(WORK, "proj-a"), join(WORK, "proj-b", "link-to-a"));
// top-level: dot dir skipped, .config carve-out discovered
file(".hiddendir/package.json", "{}");
file(".config/tool/package.json", '{"name":"tool"}');

const res1 = await ensureRepoIndex(WORK);
const db1 = JSON.parse(readFileSync(join(WORK, ".9rh", "repo-index.db"), "utf-8"));

// Mutate: grow an existing file, add a new file, delete one file.
file("proj-a/src/index.js", "console.log(1);\nconsole.log(2);\n");
file("proj-b/pkg/new.py", "x = 0\n");
rmSync(join(WORK, "proj-b/pkg/mod5.py"));

const res2 = await ensureRepoIndex(WORK);
const db2 = JSON.parse(readFileSync(join(WORK, ".9rh", "repo-index.db"), "utf-8"));

const norm = (db) =>
  db.repos
    .map(({ repoRoot, repoHash, sizeBytes, stale }) => ({
      repoRoot: repoRoot.replace(WORK, "WORK"),
      repoHash,
      sizeBytes,
      stale,
    }))
    .sort((a, b) => a.repoRoot.localeCompare(b.repoRoot));

console.log(
  JSON.stringify(
    {
      pass1: { totalRepos: res1.totalRepos, freshRepos: res1.freshRepos },
      pass2: { totalRepos: res2.totalRepos, freshRepos: res2.freshRepos },
      repos1: norm(db1),
      repos2: norm(db2),
    },
    null,
    1,
  ),
);
rmSync(WORK, { recursive: true, force: true });
