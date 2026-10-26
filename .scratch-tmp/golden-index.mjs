import { mkdtempSync, symlinkSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureRepoIndex } from "/Volumes/M.2 2TB/code/9rh/dist/indexer.js";

const work = mkdtempSync(join(tmpdir(), "9rh-golden-"));
symlinkSync("/Volumes/M.2 2TB/code/9rh", join(work, "repo-link"));
const res = await ensureRepoIndex(work);
const db = JSON.parse(readFileSync(join(work, ".9rh", "repo-index.db"), "utf-8"));
// Drop time-dependent fields; keep structure, hashes, sizes, roots.
const repos = db.repos.map(({ repoRoot, repoHash, sizeBytes, stale }) => ({ repoRoot, repoHash, sizeBytes, stale }));
console.log(JSON.stringify({ summary: res, repos }, null, 1));
rmSync(work, { recursive: true, force: true });
