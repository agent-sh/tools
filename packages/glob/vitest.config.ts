import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run in a fresh TMPDIR that is removed afterwards (see the script).
    globalSetup: ["../../scripts/vitest-temp-dir.ts"],
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
