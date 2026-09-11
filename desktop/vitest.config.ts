import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@renderer": resolve(__dirname, "src/renderer"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    // Renderer reducer tests are pure; anything touching the DOM opts in
    // with a `// @vitest-environment jsdom` header (jsdom not installed by
    // default; keep renderer tests DOM-free).
  },
});
