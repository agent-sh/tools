import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  define: { __PACKAGE_VERSION__: JSON.stringify(version) },
  test: {
    // Run in a fresh TMPDIR that is removed afterwards (see the script).
    globalSetup: ["../../scripts/vitest-temp-dir.ts"],
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
