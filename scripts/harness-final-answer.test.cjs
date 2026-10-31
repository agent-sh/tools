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
      const matchers = new Set(["toBe", "toEqual", "toStrictEqual", "toMatch", "toContain", "toMatchObject", "toHaveProperty", "toBeTruthy", "toBeFalsy", "toSatisfy", "toBeGreaterThanOrEqual"]);
      const isCheckedExpect = (call) => {
        let current = call;
        while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current &&
          ["not", "resolves", "rejects"].includes(current.parent.name.text)) current = current.parent;
        const member = current.parent;
        return ts.isPropertyAccessExpression(member) && member.expression === current && matchers.has(member.name.text) &&
          ts.isCallExpression(member.parent) && member.parent.expression === member;
      };
      const enclosingFunction = (node) => {
        while (node && !ts.isFunctionLike(node)) node = node.parent;
        return node;
      };
      const isCheckedRetry = (fn) => {
        const property = fn?.parent;
        if (!property || !ts.isPropertyAssignment(property) || property.name.getText(source) !== "run") return false;
        const call = property.parent?.parent;
        if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "passAtK") return false;
        const value = ts.isAwaitExpression(call.parent) ? call.parent : call;
        const declaration = value.parent;
        if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
        return descendants(body, (child) => ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === "expect" &&
          enclosingFunction(child) === body && isCheckedExpect(child) && child.arguments.some((argument) => descendants(argument,
            (part) => ts.isPropertyAccessExpression(part) && ["successes", "passed"].includes(part.name.text) &&
              ts.isIdentifier(part.expression) && part.expression.text === declaration.name.text)));
      };
      const constants = new Map();
      descendants(body, (child) => {
        if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer &&
          ts.isVariableDeclarationList(child.parent) && (child.parent.flags & ts.NodeFlags.Const)) constants.set(child.name.text, child.initializer);
        return false;
      });
      const finalPredicate = (node, seen = new Set()) => {
        if (ts.isParenthesizedExpression(node)) return finalPredicate(node.expression, seen);
        if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
          return finalPredicate(constants.get(node.text), new Set([...seen, node.text]));
        }
        if (ts.isBinaryExpression(node)) {
          if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return finalPredicate(node.left, seen) || finalPredicate(node.right, seen);
          if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) return finalPredicate(node.left, seen) && finalPredicate(node.right, seen);
        }
        return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "test" &&
          node.expression.expression.kind === ts.SyntaxKind.RegularExpressionLiteral && node.arguments.some(hasUnmixedFinal);
      };
      const asserted = descendants(body, (child) => {
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === "expect") {
          const fn = enclosingFunction(child);
          return (fn === body || isCheckedRetry(fn)) && isCheckedExpect(child) && child.arguments.some(hasUnmixedFinal);
        }
        if (!(ts.isPropertyAssignment(child) || ts.isShorthandPropertyAssignment(child)) || child.name.getText(source) !== "ok") return false;
        if (!finalPredicate(ts.isPropertyAssignment(child) ? child.initializer : child.name)) return false;
        const object = child.parent;
        return ts.isObjectLiteralExpression(object) && ts.isReturnStatement(object.parent) && object.parent.expression === object &&
          isCheckedRetry(enclosingFunction(object));
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
  for (const checks of ["expect(combinedSurface(trace, res.finalContent)).toMatch(/answer/)", "console.log(res.finalContent)", "expect(trace.finalContent).toMatch(/answer/)",
    "console.log(/answer/.test(res.finalContent))", "/answer/.test(res.finalContent)",
    "const matched = /answer/.test(res.finalContent); console.log(matched)",
    "expect(res.finalContent)", "expect(res.finalContent).toString()",
    "const ignored = () => expect(res.finalContent).toMatch(/answer/)",
    "return { ok: /answer/.test(res.finalContent) }",
    "const r = await passAtK({ run: async () => { return { ok: /answer/.test(res.finalContent) }; } }); console.log(r.successes)",
    "const r = await passAtK({ run: async () => { return { ok: true || /answer/.test(res.finalContent) }; } }); expect(r.successes).toBeGreaterThanOrEqual(2)"]) {
    const text = `it('positive', async () => { const res = await runE2E({}); ${checks}; });`;
    assert.equal(lintFinalAnswers(text).failures.length, 1);
  }
});

test("accepts direct fact assertions and checked final-answer predicates", () => {
  assert.deepEqual(lintFinalAnswers("it('positive', async () => { const res = await runE2E({}); expect(res.finalContent).toMatch(/answer/); });").failures, []);
  assert.deepEqual(lintFinalAnswers("it('positive', async () => { const r = await passAtK({ run: async () => { const res = await runE2E({}); const summary = res.finalContent; const matches = /answer/.test(summary); return { ok: matches }; } }); expect(r.successes).toBeGreaterThanOrEqual(2); });").failures, []);
  assert.deepEqual(lintFinalAnswers("it('positive', async () => { const r = await passAtK({ run: async () => { const res = await runE2E({}); const ok = /answer/.test(res.finalContent); return { ok }; } }); expect(r.successes).toBeGreaterThanOrEqual(2); });").failures, []);
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
