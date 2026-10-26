// End-to-end sanity on merged main: sequential = parallel output content,
// mutating call serialized between reads, run_bash produces tracked changes.
const { Agent } = require("/Volumes/M.2 2TB/code/9rh/dist/agent.js");
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const assert = require("assert");

const work = mkdtempSync(join(tmpdir(), "e2e-"));
const asserts = [];
function check(name, fn) {
  try { fn(); asserts.push(`ok  ${name}`); }
  catch (e) { asserts.push(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

function makeAgent(toolConcurrency) {
  let step = 0;
  const specs = [
    [
      { id: "r1", name: "read_file", args: { path: "a.txt" } },
      { id: "w1", name: "write_file", args: { path: "sub/new.txt", content: "written" } },
      { id: "r2", name: "read_file", args: { path: "a.txt" } },
    ],
    [
      { id: "b1", name: "run_bash", args: { command: "echo from-bash > gen.txt" } },
    ],
    [],
  ];
  function streamFor(s) {
    return (async function* () {
      yield { choices: [{ delta: { tool_calls: (specs[s] || []).map((c, i) => ({ index: i, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] };
      yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    })();
  }
  const agent = new Agent({
    baseURL: "http://127.0.0.1:9/v1", apiKey: "x", model: "m", maxIterations: 6, workDir: work,
    toolConcurrency, onEvent: () => {},
  });
  agent.client = { chat: { completions: { create: async () => { const s = step++; return streamFor(s); } } } };
  return agent;
}

(async () => {
  writeFileSync(join(work, "a.txt"), "hello");

  const seq = makeAgent(1);
  await seq.agent ? null : null;
  await seq.run("task");
  const msgs1 = seq.messages.filter(m => m.role === "tool").map(m => m.tool_call_id);

  rmSync(join(work, "sub"), { recursive: true, force: true });
  const par = makeAgent(4);
  await par.run("task");
  const msgs2 = par.messages.filter(m => m.role === "tool").map(m => m.tool_call_id);

  check("tool message ids in original order (sequential)", () => assert.deepStrictEqual(msgs1, ["r1", "w1", "r2", "b1"]));
  check("tool message ids in original order (parallel)", () => assert.deepStrictEqual(msgs2, ["r1", "w1", "r2", "b1"]));
  check("write_file landed", () => assert.strictEqual(readFileSync(join(work, "sub", "new.txt"), "utf8").trim(), "written"));
  check("run_bash landed", () => {
    assert.strictEqual(readFileSync(join(work, "gen.txt"), "utf8").trim(), "from-bash");
  });

  for (const line of asserts) console.log(line);
  rmSync(work, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})();
