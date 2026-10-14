import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  dts: { entry: "src/index.ts" },
  sourcemap: true,
  clean: true,
  target: "node18",
  splitting: false,
  treeshake: true,
  define: { __PACKAGE_VERSION__: JSON.stringify(version) },
  // Needed by the `harness-web-mcp` bin (dist/cli.js); a no-op for the library entry.
  banner: { js: "#!/usr/bin/env node" },
});
