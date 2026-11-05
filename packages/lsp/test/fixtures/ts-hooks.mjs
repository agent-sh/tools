// Lets a plain `node --import` process load this package's TypeScript
// source, for tests that need a separate host process: `.js` imports
// resolve to the `.ts` files, which are transpiled on load.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw e;
    }
  },
  load(url, context, next) {
    if (!url.endsWith(".ts")) return next(url, context);
    const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: fileURLToPath(url),
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});
