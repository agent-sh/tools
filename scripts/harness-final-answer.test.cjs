const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function descendants(node, predicate) {
  if (predicate(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => { if (descendants(child, predicate)) found = true; });
  return found;
}

// Guard a recurring review failure: tool output is evidence of execution,
// but does not establish that a positive question was answered by the model.
function lintFinalAnswers(text, filename = "fixture.ts") {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const failures = [];
  let checked = 0;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "it") {
      const body = node.arguments[1];
      if (!body || !descendants(body, (child) => ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === "runE2E")) return;
      if (descendants(body, (child) => ts.isPropertyAssignment(child) && child.name.getText(source) === "expectedOutcome" && ts.isStringLiteral(child.initializer) && child.initializer.text === "refusal")) return;
      checked++;
      const results = new Set();
      descendants(body, (child) => {
        if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer && ts.isAwaitExpression(child.initializer)) {
          const call = child.initializer.expression;
          if (ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "runE2E") results.add(child.name.text);
        }
        return false;
      });
      const isFinal = (child) => ts.isPropertyAccessExpression(child) && child.name.text === "finalContent" && ts.isIdentifier(child.expression) && results.has(child.expression.text);
      const aliases = new Set();
      descendants(body, (child) => {
        if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer && isFinal(child.initializer)) aliases.add(child.name.text);
        return false;
      });
      const hasFinal = (argument) => descendants(argument, (child) => isFinal(child) || (ts.isIdentifier(child) && aliases.has(child.text)));
      const isCombinedSurface = (child) => ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === "combinedSurface";
      const hasUnmixedFinal = (argument) => hasFinal(argument) && !descendants(argument, isCombinedSurface);
      const asserted = descendants(body, (child) => {
        if (!ts.isCallExpression(child)) return false;
        if (ts.isIdentifier(child.expression) && child.expression.text === "expect") return child.arguments.some(hasUnmixedFinal);
        return ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === "test" &&
          child.expression.expression.kind === ts.SyntaxKind.RegularExpressionLiteral && child.arguments.some(hasUnmixedFinal);
      });
      if (!asserted) failures.push(`${filename}: ${node.arguments[0].getText(source)} must assert requested facts on the returned finalContent; tool output or logging alone does not qualify`);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { failures, checked };
}

test("rejects tool-only and logging-only qualification", () => {
  for (const checks of ["expect(combinedSurface(trace, res.finalContent)).toMatch(/answer/)", "console.log(res.finalContent)", "expect(trace.finalContent).toMatch(/answer/)"]) {
    const text = `it('positive', async () => { const res = await runE2E({}); ${checks}; });`;
    assert.equal(lintFinalAnswers(text).failures.length, 1);
  }
});

test("accepts direct fact assertions and checked final-answer predicates", () => {
  assert.deepEqual(lintFinalAnswers("it('positive', async () => { const res = await runE2E({}); expect(res.finalContent).toMatch(/answer/); });").failures, []);
  assert.deepEqual(lintFinalAnswers("it('positive', async () => { const res = await runE2E({}); const summary = res.finalContent; return { ok: /answer/.test(summary) }; });").failures, []);
});

test("keeps explicitly expected refusal tests separate", () => {
  const result = lintFinalAnswers("it('negative', async () => { const res = await runE2E({ expectedOutcome: 'refusal' }); expect(res.toolCalls).toEqual([]); });");
  assert.equal(result.checked, 0);
  assert.deepEqual(result.failures, []);
});

test("web model suites assert requested facts in final answers", () => {
  const failures = [];
  let checked = 0;
  for (const name of ["webfetch.e2e.hard.test.ts", "websearch.e2e.hard.test.ts"]) {
    const file = path.join(__dirname, "../packages/harness-e2e/test", name);
    const result = lintFinalAnswers(fs.readFileSync(file, "utf8"), name);
    failures.push(...result.failures);
    checked += result.checked;
  }
  assert(checked > 0, "No positive model cases were inspected");
  assert.deepEqual(failures, []);
});
