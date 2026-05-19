#!/usr/bin/env node
const { existsSync } = require("fs");
const { join } = require("path");
const { spawnSync } = require("child_process");

const root = process.cwd();

if (process.env.NINE_RH_SKIP_POSTINSTALL === "1") {
  process.exit(0);
}

// Source checkouts do not have a complete dist/ before `npm run build`.
// Do not make local development installs fail before TypeScript has compiled.
if (existsSync(join(root, ".git"))) {
  process.exit(0);
}

const entry = join(root, "dist", "index.js");
if (!existsSync(entry)) {
  process.exit(0);
}

const result = spawnSync(process.execPath, [entry, "init", "--quiet"], {
  stdio: "inherit",
});

// postinstall should be best-effort. A router setup problem should be surfaced
// by `9rh --doctor`, not make npm install unusable.
if (result.error || (typeof result.status === "number" && result.status !== 0)) {
  const detail = result.error ? result.error.message : `exit ${result.status}`;
  process.stderr.write(`9rh postinstall setup skipped: ${detail}\n`);
}
