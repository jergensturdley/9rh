// Point the app home (snapshots, incident logs, run event logs, reports) at
// a per-worker tmpdir so tests never write into the developer's real ~/.9rh.
// `??=` lets individual suites override with their own tmp home.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.NINE_RH_HOME ??= mkdtempSync(join(tmpdir(), "ninerh-test-home-"));
