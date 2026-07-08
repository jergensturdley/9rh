export default {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { useESM: true, isolatedModules: true }],
  },
  testMatch: ["**/__tests__/**/*.test.ts"],
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
