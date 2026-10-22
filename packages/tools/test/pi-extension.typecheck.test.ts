/** Runtime-only tests cannot catch a mismatch between pi's pinned TypeBox
 * Static<T> and the extension's independently versioned TypeBox Static<T>. */
import { expect, it } from "vitest";
import ts from "typescript";
import { fileURLToPath } from "node:url";

it("typechecks the pi bridge against the installed host's parameter types", () => {
  const configPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    fileURLToPath(new URL("..", import.meta.url)),
    { noEmit: true },
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  expect(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => "\n",
  })).toBe("");
}, 30_000);
