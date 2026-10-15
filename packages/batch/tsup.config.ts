import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["@agent-sh/harness-core", "tinyglobby"],
  treeshake: true,
  splitting: false,
});
