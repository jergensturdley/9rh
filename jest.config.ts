export default {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { useESM: true, isolatedModules: true }],
  },
  testMatch: ["**/__tests__/**/*.test.ts"],
  // Redirect the app home (~/.9rh) to a tmpdir for every worker — see file.
  setupFiles: ["<rootDir>/jest.setup.ts"],
  // Exclude stale worktree clones and other non-source dirs from test
  // discovery. Worktrees (e.g. .claude/worktrees/*, .worktrees/*) contain
  // copies of the same test suites; when Jest runs them in parallel with
  // the real suites they race on shared filesystem paths and cause
  // intermittent false failures. Anchored to <rootDir> so the patterns
  // don't match the worktree's own absolute path when Jest runs from
  // inside a worktree under .claude/worktrees/<name>/.
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/",
    "<rootDir>/\\.claude/",
    "<rootDir>/\\.worktrees/",
    "/test-bed/",
  ],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  // Count every source file (not just those a test imports) so a new
  // untested module drags the number down. Thresholds only enforce under
  // `--coverage`; a plain `npm test` run is unaffected.
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/__tests__/**",
    "!src/**/*.test.ts",
  ],
  // Regression floor set a few points below current whole-project coverage
  // (stmts 69 / branch 59 / funcs 75 / lines 70). Ratchet up as coverage grows.
  coverageThreshold: {
    global: {
      statements: 66,
      branches: 55,
      functions: 71,
      lines: 67,
    },
  },
};
