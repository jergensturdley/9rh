#!/usr/bin/env node
// Benchmark harness for the perf/parallelism branch (plan Task 7).
//
// Measures, on this repo (real-world shape), median of 5 iterations:
//   1. Workdir snapshot (new git fast path): snapshot + diff cold/warm
//   2. Trivial bash round trip via snapshot before/after (the per-bash cost)
//   3. Multi-read turn: 6 read-only "tool calls" through a real Agent with
//      toolConcurrency 1 vs 4, against a stubbed model stream
//   4. Indexer: ensureRepoIndex full refresh
//
// For a before/after comparison, run this same script on main (it only
// exercises APIs present on both branches for 1/2/4; item 3 requires the
// parallel-tools branch).
const { performance } = require("node:perf_hooks");
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const { execFileSync } = require("child_process");

const REPO = process.cwd();
const ITERS = 5;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
const fmt = (ms) => `${ms.toFixed(1)}ms`;

async function benchSnapshot() {
  const { snapshotWorkDirForBash, diffBashSnapshots } = require(join(__dirname, "..", "dist", "reports", "workdirSnapshot.js"));
  const work = mkdtempSync(join(tmpdir(), "perf-snap-"));
  try {
    execFileSync("git", ["init", "-q", work], { stdio: "pipe" });
    for (let i = 0; i < 300; i++) writeFileSync(join(work, `f${i}.ts`), `export const x${i} = ${i};\n`);
    execFileSync("git", ["-C", work, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", work, "-c", "user.email=p@x", "-c", "user.name=p", "commit", "-qm", "init"], { stdio: "pipe" });

    const cold = [];
    const warm = [];
    for (let i = 0; i < ITERS; i++) {
      let t0 = performance.now();
      const before = await snapshotWorkDirForBash(work);
      cold.push(performance.now() - t0);
      // dirty one tracked file
      writeFileSync(join(work, "f7.ts"), "export const x7 = 42;\n");
      t0 = performance.now();
      const after = await snapshotWorkDirForBash(work);
      const ops = await diffBashSnapshots(work, before, after, 1);
      warm.push(performance.now() - t0);
      if (ops.length !== 1) throw new Error(`expected 1 op, got ${ops.length}`);
    }
    return { cold: median(cold), warmWithDiff: median(warm) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function benchIndexer() {
  const { ensureRepoIndex } = require(join(__dirname, "..", "dist", "indexer.js"));
  const work = mkdtempSync(join(tmpdir(), "perf-idx-"));
  try {
    // 3 pseudo-repos with a few hundred small files each
    for (let r = 0; r < 3; r++) {
      const repo = join(work, `repo${r}`);
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), "{}");
      const sub = join(repo, "src", `m${r}`);
      mkdirSync(sub, { recursive: true });
      for (let i = 0; i < 250; i++) writeFileSync(join(sub, `m${i}.ts`), `export const v = ${i};\n`);
    }
    const times = [];
    for (let i = 0; i < ITERS; i++) {
      // force a full refresh each time by changing one file (hash churn)
      writeFileSync(join(work, "repo0", "src", "m0", "m0.ts"), `export const v = ${i};\n`);
      const t0 = performance.now();
      await ensureRepoIndex(work);
      times.push(performance.now() - t0);
    }
    return { refresh: median(times) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ── Multi-read turn through a real Agent ──────────────────────────
async function benchMultiRead() {
  const { Agent } = require(join(__dirname, "..", "dist", "agent.js"));
  const work = mkdtempSync(join(tmpdir(), "perf-read-"));
  try {
    for (let i = 0; i < 6; i++) {
      const d = join(work, `d${i}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "a.ts"), ("const needle" + i + " = 1;\n").repeat(20000));
      writeFileSync(join(d, "b.ts"), ("const other = 2;\n").repeat(20000));
    }

    async function runWithConcurrency(n) {
      const events = [];
      const calls = Array.from({ length: 6 }, (_, i) => ({
        id: `call-${i}`,
        name: "search_files",
        // each call spawns a grep subprocess: I/O + process bound, the
        // real-world case bounded concurrency is designed for
        args: { pattern: "x{5,}", path: `d${i}` },
      }));
      let step = 0;
      const config = {
        baseURL: "http://127.0.0.1:9/v1",
        apiKey: "bench",
        model: "bench-model",
        maxIterations: 4,
        workDir: work,
        toolConcurrency: n,
        onEvent: (e) => events.push(e),
      };
      const agent = new Agent(config);
      // Stub the OpenAI client: step 0 returns all 6 tool calls,
      // step 1 returns a final message.
      // Streaming stub: yields delta chunks like the OpenAI SDK stream.
      function chunk(delta, usage) {
        return { choices: [{ delta }], usage };
      }
      function streamFor(step) {
        async function* gen() {
          if (step === 1) {
            for (const c of calls) {
              yield chunk({
                tool_calls: [
                  { index: Number(c.id.split("-")[1]), id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } },
                ],
              });
            }
            yield chunk({}, { prompt_tokens: 100, completion_tokens: 10 });
          } else {
            yield chunk({ content: "done" });
            yield chunk({}, { prompt_tokens: 100, completion_tokens: 5 });
          }
        }
        return gen();
      }
      agent.client = {
        chat: {
          completions: {
            create: async () => {
              step++;
              return streamFor(step);
            },
          },
        },
      };
      let firstCall = 0;
      let lastResult = 0;
      const t0 = performance.now();
      agent.config.onEvent = (e) => {
        if (e.type === "tool_call") {
          if (!firstCall) firstCall = performance.now();
        } else if (e.type === "tool_result") {
          lastResult = performance.now();
        }
      };
      await agent.run("read all files");
      // Window from first tool dispatch to last tool result isolates the
      // tool-execution stage from stream/setup overhead.
      return firstCall && lastResult ? lastResult - firstCall : performance.now() - t0;
    }

    const seq = [];
    const par = [];
    for (let i = 0; i < ITERS; i++) {
      // Alternate the order each pass so warm-cache bias hits both arms.
      seq.push(await runWithConcurrency(1));
      par.push(await runWithConcurrency(4));
      par.push(await runWithConcurrency(4));
      seq.push(await runWithConcurrency(1));
    }
    return { sequential: median(seq), parallel4: median(par), speedup: median(seq) / median(par) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const rows = [];
  rows.push(["snapshot cold", fmt((await benchSnapshot()).cold)]);
  const snap = await benchSnapshot();
  rows.push(["snapshot warm+diff (1 dirty file)", fmt(snap.warmWithDiff)]);
  const idx = await benchIndexer();
  rows.push(["indexer refresh (3 repos x 250 files)", fmt(idx.refresh)]);

  const reads = await benchMultiRead();
  rows.push(["6 reads, toolConcurrency=1", fmt(reads.sequential)]);
  rows.push(["6 reads, toolConcurrency=4", fmt(reads.parallel4)]);
  rows.push(["parallel-read speedup", `${reads.speedup.toFixed(2)}x`]);

  console.log("| benchmark | median of 5 |");
  console.log("| --- | --- |");
  for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
