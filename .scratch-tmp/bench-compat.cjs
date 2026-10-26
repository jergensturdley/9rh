#!/usr/bin/env node
// Before/after snapshot + indexer benchmark. Works on BOTH main (legacy
// snapshotWorkDir/diffSnapshots) and perf/parallelism (fast path).
// Usage: node bench-compat.cjs <repo-root-with-dist>
const { performance } = require("node:perf_hooks");
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const { execFileSync } = require("child_process");

const ROOT = process.argv[2];
if (!ROOT) {
  console.error("usage: node bench-compat.cjs <repo-root-with-dist>");
  process.exit(1);
}
const ITERS = 5;
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
const fmt = (ms) => `${ms.toFixed(1)}ms`;

async function main() {
  let snap, diff, m;
  try {
    m = require(join(ROOT, "dist", "reports", "workdirSnapshot.js"));
    snap = m.snapshotWorkDirForBash ?? m.snapshotWorkDir;
    diff = m.diffBashSnapshots ?? m.diffSnapshots;
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
  const { ensureRepoIndex } = require(join(ROOT, "dist", "indexer.js"));

  // ── snapshot fixture: git repo with 300 files, one dirty ──
  const work = mkdtempSync(join(tmpdir(), "compat-snap-"));
  execFileSync("git", ["init", "-q", work], { stdio: "pipe" });
  for (let i = 0; i < 300; i++) writeFileSync(join(work, `f${i}.ts`), `export const x${i} = ${i};\n`);
  execFileSync("git", ["-C", work, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", work, "-c", "user.email=p@x", "-c", "user.name=p", "commit", "-qm", "init"], { stdio: "pipe" });

  const cold = [];
  const warmDiff = [];
  for (let i = 0; i < ITERS; i++) {
    let t0 = performance.now();
    const before = await snap(work);
    cold.push(performance.now() - t0);
    writeFileSync(join(work, "f7.ts"), "export const x7 = 42;\n");
    t0 = performance.now();
    const after = await snap(work);
    const ops = m.diffBashSnapshots
      ? await diff(work, before, after, 1)
      : diff(before, after, 1);
    warmDiff.push(performance.now() - t0);
    if (!ops.length) throw new Error("expected at least one op");
  }
  rmSync(work, { recursive: true, force: true });

  // ── indexer fixture: 3 pseudo-repos x 250 files ──
  const iwork = mkdtempSync(join(tmpdir(), "compat-idx-"));
  for (let r = 0; r < 3; r++) {
    const repo = join(iwork, `repo${r}`);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), "{}");
    const sub = join(repo, "src", `m${r}`);
    mkdirSync(sub, { recursive: true });
    for (let i = 0; i < 250; i++) writeFileSync(join(sub, `m${i}.ts`), `export const v = ${i};\n`);
  }
  const idxTimes = [];
  for (let i = 0; i < ITERS; i++) {
    writeFileSync(join(iwork, "repo0", "src", "m0", "m0.ts"), `export const v = ${i};\n`);
    const t0 = performance.now();
    await ensureRepoIndex(iwork);
    idxTimes.push(performance.now() - t0);
  }
  rmSync(iwork, { recursive: true, force: true });

  console.log(`| snapshot cold (300 files, git) | ${fmt(median(cold))} |`);
  console.log(`| snapshot warm + diff (1 dirty) | ${fmt(median(warmDiff))} |`);
  console.log(`| indexer refresh (3x250 files) | ${fmt(median(idxTimes))} |`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
