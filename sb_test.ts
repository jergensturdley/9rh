import { Sandbox } from "./src/sandbox/sandboxer.js";
(async () => {
  const sb = new Sandbox({ workDir: "/tmp" });
  console.error("=== PROFILE ===");
  console.error(sb.getProfile());
  console.error("=== END PROFILE ===");
  const r = await sb.exec("echo hello");
  console.error("exit:", r.exitCode);
  console.error("stdout:", JSON.stringify(r.stdout));
  console.error("stderr:", JSON.stringify(r.stderr));
})();
