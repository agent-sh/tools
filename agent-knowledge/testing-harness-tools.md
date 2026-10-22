# Testing Harness Tools — Testing LLM-Facing Agent Tools

**Generated**: 2026-04-20
**Sources**: 20 analyzed (14 external + 6 in-repo anchors)
**Depth**: medium
**Scope**: Specific to `@agent-sh/harness-*` — a TypeScript library shipping
LLM-facing tools (Read, Write, Edit, MultiEdit, soon Grep/Glob) that are
consumed by probabilistic models (Claude, GPT, Qwen, Llama), not deterministic
callers. If you came here looking for generic unit-testing advice, leave.

---

## Prerequisites

- You accept the prime directive: the tool's contract is *"a real model
  picks this tool, calls it correctly, interprets the result, and makes a
  good next move — across model families"*. Not *"given inputs X produce
  outputs Y"*. See `/mnt/c/Users/avife/tools/CLAUDE.md`.
- You've internalized that **unit tests never validate the LLM contract**.
  They validate the code. Necessary, not sufficient.
- You're working in the `packages/harness-*` monorepo (Turbo + pnpm + tsup
  + vitest + valibot) and the canonical e2e package is
  `packages/harness-e2e`.
- Qwen3/3.5 stays in thinking mode. Temperature is never 0. See
  `feedback_qwen_thinking.md` and `feedback_qwen_temperature.md`.

---

## TL;DR

- There are **five testing layers** and each catches a different failure
  mode. Do not skip layers because the one above it was green.
- The repo already has layers 1-4 well-exercised for `read` and `write`.
  What's missing is layer 5 (multi-model regression / eval harness) and
  a few high-signal adversarial scenarios (CRLF/encoding traps, partial
  failures, rate-limit injection, schema drift).
- For Qwen-class open models the decisive instrument is the **trace**:
  `turns`, `toolsByName`, `toolSeq`, `finalContent`. Assertions against
  the trace catch non-invocation, bash-routing, and hallucination
  failures that no output assertion can.
- Bedrock Converse and Ollama are treated behind one `runE2E` facade so
  the same test body runs on both backends. That makes the multi-model
  matrix a per-invocation config flip (`E2E_BACKEND=bedrock` vs default),
  not a suite rewrite.
- Cost/flake management is real: Bedrock runs are gated by
  `AWS_BEARER_TOKEN_BEDROCK`, Ollama runs are gated by
  `ollamaModelAvailable`, both use `it.runIf`. Local GPU pressure is
  managed by running one model per process.

---

## 1. The Five-Layer Testing Pyramid

Each layer catches a specific failure mode. Skip one, and the failure it
catches will ship.

| Layer | Scope | Catches | Cost | Where in repo |
|-------|-------|---------|------|---------------|
| 1. Pure logic | `applyEdit`, `applyPipeline`, path normalizers, CRLF handlers | Algorithmic bugs | ms, free | `packages/write/test/engine.test.ts`, `matching.test.ts`, `diff.test.ts` |
| 2. Schema / contract | valibot schemas (`ReadParamsSchema`, `WriteParamsSchema`) | Invalid-input regressions | ms, free | `packages/read/test/schema.test.ts` |
| 3. Tool integration | `read()`, `write()`, `edit()` exercised against the real FS, ledger, permissions | End-to-end tool behavior, error codes, ledger mutations, validate hooks, atomicity | ~10s per suite | `packages/write/test/write.test.ts`, `edit.test.ts`, `multiedit.test.ts`, `packages/read/test/read.*.test.ts` |
| 4. Real-model e2e | Ollama Qwen3.5 calling the tools through JSON-schema surface | Tool-description ambiguity, error-recovery depth, bash-decoy routing, pagination, attachment refusal | 2-5 min/test, free but GPU-heavy | `packages/harness-e2e/test/read.e2e*.test.ts`, `write.e2e.hard.test.ts` |
| 5. Multi-model regression eval | Same scenarios × (Qwen, Claude Opus 4.7 via Bedrock, ideally GPT, Gemini, Llama) aggregated into a dashboard | Cross-model drift, description-regression ("we changed the description, Qwen still works but Claude now loops"), release gates | minutes + $, release-time only | **Partly wired** via `runE2E` + `resolveBackend()`; no aggregation yet |

**Why the pyramid is not optional.** Each layer catches a failure mode that
is invisible to the layer below. `applyEdit` returning the right error
code (layer 1) does not mean the model self-corrects from that error
(layer 4). Qwen recovering from `OLD_STRING_NOT_UNIQUE` (layer 4) does not
mean Claude does — and Claude is what production ships. Only layer 5
catches the "we tuned the description for Qwen, Claude now bashes around
it" regression that Anthropic's multi-agent post explicitly warns about.

### What each layer must assert

**Layer 1 (pure logic).** Exhaustive branch coverage of every error enum
the tool exposes. Every `code:` the LLM might see must be reachable from
a test. Example from `engine.test.ts`: `OLD_STRING_NOT_FOUND` with fuzzy
candidates, `OLD_STRING_NOT_UNIQUE` with `match_count`, `NO_OP_EDIT`,
`EMPTY_FILE`, `CRLF` normalization on both needle and haystack.

**Layer 2 (schema).** Every refinement in the valibot schema. Path empty,
offset < 1, non-integer offset, limit < 1, missing required field. The
test file `packages/read/test/schema.test.ts` is the template — one
`it(...)` per rejection path, plus a positive minimal case.

**Layer 3 (tool integration).** The fail-open-to-hook-vs-hard-deny
semantics (D11 in the Read spec) live here. `packages/read/test/read.permissions.test.ts`
is the reference: for each sensitive path and each out-of-workspace case,
assert both the no-hook hard-deny code (`SENSITIVE`, `OUTSIDE_WORKSPACE`)
and the hook paths (`allow` → success, `deny` → `PERMISSION_DENIED`). The
ledger (`InMemoryLedger`) and the read-before-mutate gate are exercised
by `write.test.ts` (`NOT_READ_THIS_SESSION`, `STALE_READ`).

**Layer 4 (real-model e2e).** This is where the tool-description
contract gets validated. The harness is `packages/harness-e2e/src/runner.ts`
which dispatches to either `runAgent` (Ollama) or `runBedrockAgent` (AWS)
based on `E2E_BACKEND`. Every real-model test must assert on the
**trace**, not only the final answer. See §3 for what to measure.

**Layer 5 (multi-model regression).** Same scenarios, different
backends, aggregated. The primitive is already there — `runE2E` and
`modelLabel`. The missing piece is an aggregator: run each hard test on
every configured backend, record per-(backend, test) pass/fail + trace
summary, and flag regressions between runs.

---

## 2. What's Already Shipped in this Repo (Anchor)

Before reading the "what's missing" sections, know what is working:

### Layer 1 — pure logic (write package)

`packages/write/test/engine.test.ts` covers `applyEdit` and `applyPipeline`
exhaustively:

```ts
// Every error enum the LLM can see is exercised
it("returns OLD_STRING_NOT_FOUND with fuzzy candidates", () => { ... });
it("returns OLD_STRING_NOT_UNIQUE when multiple matches without replace_all", () => { ... });
it("rejects no-op edits", () => { ... });                 // NO_OP_EDIT
it("rejects edits against empty files", () => { ... });    // EMPTY_FILE
it("normalizes CRLF on both needle and haystack", () => { ... });
```

Plus `applyPipeline` fail-fast semantics (`edit[N]:` prefix on error) and
per-edit warning prefixing (`edit[0]:` prefix on substring-boundary
warning). These tests drive the specific error-message shape the model
sees, which is the actual API surface.

### Layer 2 — schema (read package)

`packages/read/test/schema.test.ts` has one test per rejection path of
the valibot schema. Template for every new tool:

```ts
it("rejects empty path", () => {
  const r = safeParseReadParams({ path: "" });
  expect(r.ok).toBe(false);
});
```

### Layer 3 — tool integration

`packages/write/test/write.test.ts` is the canonical shape:

- `makeSession(dir, overrides?)` from `test/helpers.ts` builds a real
  `WriteSessionConfig` with an `InMemoryLedger` and
  `DEFAULT_SENSITIVE_PATTERNS`.
- `recordRead(session, path)` simulates a prior read so the read-before-mutate
  gate passes; mutating the file on disk between `recordRead` and `write`
  drives the `STALE_READ` path.
- Every error code in the discriminated union is reached from at least
  one test: `NOT_READ_THIS_SESSION`, `STALE_READ`, `SENSITIVE`,
  `OUTSIDE_WORKSPACE`, `NOTEBOOK_UNSUPPORTED`, `INVALID_PARAM`,
  `VALIDATE_FAILED`.
- Atomic-write is verified indirectly: `stat` after write, check
  `isFile()`, check no temp files in the dir.

### Layer 4 — real-model e2e

Two suites, both gated by `it.runIf(() => available)`:

- **`packages/harness-e2e/test/read.e2e.test.ts`** — three baseline
  scenarios: file read + Q&A, pagination (2500-line file, needle at
  L2401), NOT_FOUND with fuzzy candidates. Uses a single `read` tool and
  Qwen3.5.
- **`packages/harness-e2e/test/read.e2e.hard.test.ts`** — seven stress
  scenarios H1-H7: one-hop pagination at 3000 lines, empty file, binary
  refusal + sibling recovery, sensitive-path refusal (must not
  hallucinate `.env` contents!), attachment image (must not hallucinate
  pixels), directory listing, bash-decoy (both `read` and `shell`
  available — observe whether the model picks `read`).
- **`packages/harness-e2e/test/write.e2e.hard.test.ts`** — W1-W8 across
  read-before-edit gate, NOT_UNIQUE recovery, NOT_FOUND fuzzy, MultiEdit
  atomicity, write-create, write-overwrite, bash-decoy for file
  mutation. Runs on **either** Ollama or Bedrock based on `E2E_BACKEND`.
- **`packages/harness-e2e/test/bedrock.smoke.test.ts`** — trivial
  Converse reachability check, gated by `AWS_BEARER_TOKEN_BEDROCK`.

### Harness plumbing worth pointing at

- `packages/harness-e2e/src/agent.ts` — Ollama agentic loop, captures
  `AgentTraceEvent` kinds `assistant | tool_call | tool_result | final`.
  Defaults `temperature=0.6`, `think=true` (never override those on
  Qwen3/3.5).
- `packages/harness-e2e/src/bedrockAgent.ts` — Converse-API version of
  the same loop; converts `ToolExecutor.tool.function` into Bedrock's
  `toolSpec.inputSchema.json`, returns the same `AgentRunResult` so tests
  are backend-agnostic.
- `packages/harness-e2e/src/runner.ts` — `runE2E(opts)` is the facade:
  switches on `resolveBackend()` (`ollama` | `bedrock`) and
  `resolveModel(defaultOllama)`. Keep this as the canonical entry point
  for any new multi-backend test.
- `packages/harness-e2e/src/env.ts` — a dependency-free `.env` loader
  that walks up from cwd for settings such as `BEDROCK_MODEL_ID`, then fills
  `AWS_BEARER_TOKEN_BEDROCK` from the keyring (`cred-get bedrock-bearer`)
  when it is unset, without adding dotenv.
- `packages/harness-e2e/vitest.config.ts` — `testTimeout: 120_000`,
  `hookTimeout: 60_000`. Individual hard tests override to 180_000 or
  300_000 as the third arg to `it.runIf(...)`.

---

## 3. What to Measure Per Real-Model Test Run

A real-model e2e test that only asserts `expect(finalContent).toMatch(...)`
is under-instrumented. Every production-grade LLM-tool test should capture
**at least** these six quantities from the trace. The repo's
`collectTrace()` helper already does five of them; add the rest.

### 3.1 Non-invocation rate

Did the tool get called at all? This is the most under-appreciated
failure mode. If the model reads the tool description, decides it doesn't
fit, and shells out to `cat` / `grep` / `ls`, no output assertion catches
it — the final answer might even be correct. See the H7 bash-decoy test
for the pattern:

```ts
const readCalls = trace.toolsByName["read"] ?? 0;
const shellCalls = trace.toolsByName["shell"] ?? 0;
if (readCalls === 0 && shellCalls > 0) {
  console.warn(
    `[H7 ${MODEL}] WARNING: model bypassed \`read\` and used \`shell\` — tool-description problem.`,
  );
}
```

**Policy.** For every tool that has a shell decoy available, ship a
bash-decoy test. The warning output goes into CI logs so drift shows up
without failing the build.

### 3.2 Turn count

Claude Code's own best-practices doc flags context exhaustion as the
dominant failure driver: *"Claude's context window fills up fast, and
performance degrades as it fills."* Turn count is the proxy. A task that
used to take 3 turns now taking 7 means either:

- The tool description got ambiguous (layer 4 regression)
- An error message stopped being self-correcting (layer 1 regression
  that surfaces at layer 4)
- The model is retrying valid calls (harness bug — see §5)

The harness already captures `res.turns`. Assert an **upper bound** when
the scenario is well-understood:

```ts
expect(res.turns).toBeLessThanOrEqual(4);  // read + edit + answer
```

### 3.3 Tool-call argument correctness

Did the model pass what a human would pass? Path correct, offset within
the expected range, old_string not hallucinated. The trace has `toolCalls[i].args`
— assert on the actual args, not just that a call happened:

```ts
expect(res.toolCalls[0]!.name).toBe("read");
expect(res.toolCalls[0]!.args.path).toBe(p);  // not "READ_ME" or a typo
```

### 3.4 Error-recovery depth

Given a tool-error result, did the model self-correct and succeed? The
canonical test is W2 (read-before-edit gate fires, model reads, retries,
succeeds) and W3 (`OLD_STRING_NOT_UNIQUE`, model widens old_string with
context). Assert the **sequence**:

```ts
const readIdx = trace.toolSeq.indexOf("read");
const editIdx = trace.toolSeq.indexOf("edit");
expect(readIdx).toBeGreaterThanOrEqual(0);
expect(editIdx).toBeGreaterThan(readIdx);  // must recover in this order
```

This is how you verify the error-message design. If the message changes
and models stop recovering, this test fails — and that's the point.

### 3.5 Output faithfulness / hallucination guard

Did the final answer stay inside the tool's result? H4 is the canonical
test: the tool returns `SENSITIVE` on `.env`, the model **must not** emit
the password (even though it could invent a plausible one). This is a
negative assertion:

```ts
expect(res.finalContent).not.toContain("hunter2-zembla-prod");
expect(res.finalContent.toLowerCase()).toMatch(
  /sensitive|refus|denied|cannot|blocked|permission/,
);
```

Every refusal path needs this shape. For `BINARY`, `NOTEBOOK_UNSUPPORTED`,
`PERMISSION_DENIED`, assert the final answer acknowledges the refusal
and does not invent content.

### 3.6 State-mutation verification

For write-class tools, verify the filesystem state after, not only the
final string. Sha256 before/after, file existence, content contains. Do
not trust the model's self-report that it wrote the change:

```ts
const before = sha(target);
// ... run agent ...
expect(sha(target)).not.toBe(before);
expect(readUtf8(target)).toContain("NEW CONTENT");
```

For multi-file edits (when MultiEdit across files lands), assert
atomicity: either all files changed or none, never a partial. The
Write spec explicitly scopes multi-file atomicity to the harness layer
(`feedback_write_atomicity.md`), so this is a harness-integration test,
not a tool-unit test.

### What to log for every run

```ts
console.log(`[${testId} ${LABEL}]`, JSON.stringify({
  turns: trace.turns,
  tools: trace.toolsByName,
  seq: trace.toolSeq,
  final: res.finalContent.slice(0, 200),
}));
```

This is the minimum. When a test regresses, the log line is what you
read first. `LABEL` (from `modelLabel()`) tells you whether it was
`ollama:qwen3.5:27b-q4_K_M` or `bedrock:anthropic.claude-opus-4-7`.

---

## 4. Cross-Model Matrix Without Combinatorial Blow-Up

The naive approach — `for model in MODELS: for test in TESTS: run(model, test)`
— wastes money and time. The working pattern in this repo:

### 4.1 Backend abstraction (already shipped)

`runE2E` takes a `backend` discriminator and dispatches. One test body
works on both Ollama and Bedrock. See `runOpts()` in
`write.e2e.hard.test.ts`:

```ts
function runOpts(systemPrompt, userPrompt, tools, maxTurns, onTrace) {
  const opts = { backend: BACKEND, model: MODEL, tools, systemPrompt,
                 userPrompt, maxTurns, onTrace };
  if (BACKEND === "ollama") {
    (opts as { baseUrl: string }).baseUrl = OLLAMA_BASE_URL;
  }
  return opts;
}
```

### 4.2 Tiered gating (what to add)

Not every model tier runs on every CI event. Tier the matrix:

| Tier | Trigger | Backends | Cost | Purpose |
|------|---------|----------|------|---------|
| Smoke | every PR | Ollama Qwen3.5 (if GPU available) | free | catch catastrophic breaks |
| Cross-family | nightly | Ollama Qwen3.5 + Bedrock Claude Opus 4.7 + (future: Llama, Gemini) | ~$/night | catch cross-family drift |
| Full | release | all of above + GPT-5, DeepSeek via OpenRouter | ~$$ | release gate |

Implementation: `it.runIf(() => tierEnabled("cross-family"))` reading an
env var. The existing `it.runIf(() => available)` pattern extends
cleanly.

### 4.3 Per-model timeout and retry budget

Bedrock Claude answers in 3-8s per turn, Qwen3.5 local takes 15-60s per
turn depending on prompt size. One flat `testTimeout: 300_000` covers
both but budget retries per backend:

```ts
const RETRY_BUDGET = BACKEND === "bedrock" ? 2 : 0;
// Retry flaky real-API calls up to N times. Local Ollama shouldn't
// retry — a failure there is a real signal, not a transient.
```

### 4.4 Don't test models, test your tool

The BFCL / TAU-bench pattern is *"score the model."* That is **not**
what this repo does. Here, the model is the fixture and **the tool is
the unit under test**. If Qwen fails a scenario and Claude passes, the
question is "what's in the description that Qwen reads differently?" not
"Qwen is bad at tools." See Anthropic's multi-agent research post —
they built a *"tool-testing agent [that] attempts to use the tool and
then rewrites the tool description to avoid failures"* and got a 40%
task-time reduction. Same pattern applies here.

---

## 5. Adversarial / Chaos Scenarios

The Read and Write design specs
(`agent-knowledge/design/read.md`, `agent-knowledge/design/write.md`)
codify the adversarial matrix. What's covered vs what's not:

### 5.1 Shipped

| Scenario | Where | Test id |
|----------|-------|---------|
| Ambiguous prompt ("take a look at X") | read.e2e.test.ts | single-tool scenarios |
| Pagination exhaustion | read.e2e.test.ts, read.e2e.hard.test.ts | H1 |
| Empty file | read.e2e.hard.test.ts | H2 |
| Binary refusal + recovery | read.e2e.hard.test.ts | H3 |
| Sensitive-path trap (refuse, don't hallucinate) | read.e2e.hard.test.ts | H4 |
| Attachment image (don't hallucinate pixels) | read.e2e.hard.test.ts | H5 |
| Directory listing (don't reach for `ls`) | read.e2e.hard.test.ts | H6 |
| Bash-decoy (prefer dedicated tool over shell) | read.e2e.hard.test.ts, write.e2e.hard.test.ts | H7, W8 |
| Read-before-edit gate recovery | write.e2e.hard.test.ts | W2 |
| Non-unique recovery (widen context) | write.e2e.hard.test.ts | W3 |
| NOT_FOUND fuzzy recovery | write.e2e.hard.test.ts | W4 |
| MultiEdit atomicity | write.e2e.hard.test.ts | W5 |

### 5.2 Missing — add these

| Scenario | Why it matters | Shape |
|----------|---------------|-------|
| **CRLF fixture** at the e2e layer | Unit tests cover CRLF in `applyEdit`; real-model hasn't been stressed on Windows line endings | Fixture with `\r\n`, prompt the model to edit. Assert disk is `\n` after, or unchanged if the spec is "preserve", whichever the design says. |
| **BOM-prefixed file** | Some agents strip BOM, some don't; byte-count assertions get off by 1-3 | Fixture with U+FEFF prefix, check `bytes_written` meta still matches content length minus BOM handling. |
| **Partial-write / crash injection** | Verify atomic-write semantics (rename-not-copy, no temp file left behind if process dies mid-write) | Use a mock fs that throws on rename. Assert temp file cleaned up, original untouched. |
| **Schema drift** — model calls tool with an extra field | valibot's default is to tolerate; spec should clarify. Extra fields should either hard-reject (strict) or be stripped (tolerant). Test the chosen behavior. | `applyEdit({ old_string, new_string, extra_field: "x" })` — assert code behavior matches spec. |
| **Rate-limit / timeout injection (Bedrock)** | Production will see these; harness currently retries 0 times | Mock `bedrockConverse` to throw `ThrottlingException` first call, succeed second; verify `runBedrockAgent` either propagates or retries per policy (decide, then test). |
| **Distractor tool (multiple similar tools)** | "We added `read_file` and `slurp` — does the model still pick `read`?" | Wire a second tool with an overlapping description. Observe `toolsByName`. Tool-description quality test. |
| **Stale ledger across sessions** | Ledger persists in InMemoryLedger for a session; if a test reuses a session across turn-batches, ensure `STALE_READ` still fires on disk mutation | Deliberate: session.record(shaA) → external mutation → session.write(...) → expect `STALE_READ`. |
| **Mid-turn fs mutation during MultiEdit** | Edit i modifies content, edit i+1's old_string no longer matches because edit i removed it (this is by design with `applyPipeline`, but verify) | Covered by `applyPipeline` unit test; add a real-model variant where the sequence is ambiguous. |
| **Symlink / hardlink trickery** | Read follows symlinks? Write follows symlinks? Matters for security and atomicity | Create `a.txt` → symlink `b.txt → a.txt`, write to `b.txt`, assert spec-conformant behavior (rewrite target vs break symlink). |
| **Encoding trap** — UTF-16 file | If the tool decodes as UTF-8, read of UTF-16 BE should fail cleanly, not silently produce mojibake | Fixture with UTF-16 BE encoding, assert error code (e.g., `INVALID_ENCODING`) or clean handling. |

Each of these is a `describe(...)` with a small fixture + one-line
assertion. They're cheap to add because the fixture helpers
(`makeTempDir`, `writeFixture`, `recordRead`) are already in
`packages/write/test/helpers.ts`.

---

## 6. Mocking vs Real — A Decision Tree

Model calls are expensive, slow, and non-deterministic. The question is
never "should we mock?" — it's "at which layer?"

| Layer | What you mock | What you don't | Why |
|-------|---------------|-----------------|------|
| 1 (pure logic) | Nothing — no mocks | The FS, the clock | These are pure functions; mocking hides bugs |
| 2 (schema) | Nothing | — | Schemas are pure predicates |
| 3 (tool integration) | Validate hooks (to drive `VALIDATE_FAILED`) and permission hooks (to drive both allow/deny paths). Sometimes the FS via tmp dirs (which aren't mocks, they're real FS in a sandbox). | The tool code, the ledger, the permission check, the atomic-write step. | The tool's job is to integrate real FS + real ledger + real permission; mocking those defeats the test. |
| 4 (real-model e2e) | The FS is a tmp dir. The model is real. | The model. | Mocking the model is layer 4.5, see below. |
| 4.5 (contract / replay) | The model via VCR-style cassettes of tool_use + tool_result sequences | The tool | Fast, deterministic, catches *code* regressions (not description regressions) after a real-model trace has been recorded. |
| 5 (regression eval) | Nothing | The model | Point is to catch cross-model drift, mocks defeat it. |

### 6.1 When record-replay is worth it

VCR-style cassettes (see `vcrpy`) are standard for HTTP APIs. For LLMs
the same pattern works but is worth less:

- **Good for**: catching *harness* regressions (did we change the
  message serialization in `runBedrockAgent`? replay catches it). Fast
  CI signal without hitting real APIs.
- **Bad for**: catching *tool-description* regressions. If you changed
  the description, the replay still passes because the recorded model
  responses are frozen. You must re-record, and re-recording is
  indistinguishable from re-running live.

**Recommendation.** Consider adding a thin VCR layer around
`ollamaChat` and `bedrockConverse` for CI-speed tool-unit-level tests
(does the loop wire arguments through correctly), but keep the `*.hard.test.ts`
suites always live on at least the default tier. Record-replay does not
substitute for live eval on release gates.

### 6.2 What never to mock

- The filesystem, via `jest.mock('fs')` or similar. Tmp dirs via
  `mkdtempSync` are not mocks — they're real FS in a scratch space.
- The tool function itself. If you mock the tool you're testing the
  wrong thing.
- The error path. Drive errors by constructing inputs that actually
  trigger them (mutate the file externally to drive `STALE_READ`, pass
  a directory path to drive `INVALID_PARAM`), not by mocking a rejection.

---

## 7. Evaluator / Judge Patterns

For deterministic checks (did the file contain "NEW CONTENT"?), regex
and `toContain` are sufficient. For harder checks (did the model explain
the file's purpose accurately?), you need a judge.

### 7.1 Code-based judge (preferred, already in use)

The repo uses code-based judges throughout. Examples from
`read.e2e.hard.test.ts`:

```ts
expect(res.finalContent.toLowerCase()).toMatch(/empty|blank|no content|nothing/);  // H2
expect(res.finalContent.toLowerCase()).toMatch(/png|image/);  // H5
expect(res.finalContent).toMatch(/2734/);  // H1 — exact line number
```

This is Anthropic's explicit recommendation (eval-dev guide): *"Code-based
grading: Fastest and most reliable, extremely scalable"*. Use it whenever
the answer has a structural form.

### 7.2 LLM-as-judge (use sparingly)

For subjective checks — "did the model explain the error cleanly?" —
spin up a second Bedrock call with a strict rubric. Anthropic's template:

```
Rate this answer based on the rubric:
<rubric>{rubric}</rubric>
<answer>{answer}</answer>
Think through your reasoning in <thinking> tags,
then output 'correct' or 'incorrect' in <result> tags.
```

**Rules:**
- Use a **different** model for the judge than the model under test
  (avoid self-grading bias). Running judge on Claude Opus 4.7 while
  testing Qwen3.5 is fine and already consistent with the repo's two-
  backend setup.
- Always encourage reasoning in `<thinking>` then discard it; empirically
  improves grader reliability.
- Score on a small discrete scale (`correct | incorrect`, or 1-5
  Likert). Free-form scores are unstable.
- Treat the judge as a layer-5 tool, not layer 3. Don't LLM-judge in
  unit tests.

### 7.3 Trajectory evaluation

The real layer for testing multi-turn agents. What sequence of
(tool_call, args, tool_result) was produced? DeepEval's `Tool Correctness`
metric and LangSmith's pairwise evaluators are both trajectory-based.
In this repo, the trajectory *is* `trace.toolSeq`:

```ts
// Canonical "read-then-edit" trajectory assertion
expect(trace.toolSeq).toEqual(["read", "edit"]);
// Canonical "read-edit-recover-edit" trajectory
expect(trace.toolSeq).toEqual(["edit", "read", "edit"]);
```

For more flexible matching (tool sequence with allowed variants), write
a small matcher. Don't overfit — the goal is "did the model do
something sensible" not "did the model match this exact script."

### 7.4 Pass@k

TAU-bench's headline metric: same scenario, run k times, count passes.
Combats Qwen's non-determinism (T=0.6). Cheap to add:

```ts
async function passAtK(k: number, runOnce: () => Promise<boolean>) {
  const results = await Promise.all(Array.from({ length: k }, () => runOnce()));
  return results.filter(Boolean).length / k;
}
expect(await passAtK(3, () => runScenario())).toBeGreaterThanOrEqual(2 / 3);
```

Only worth it for tests known to be flaky-but-usually-right. Don't apply
to everything — it multiplies cost by k.

---

## 8. CI/CD Integration

### 8.1 Tiered jobs

`turbo.json` + workspace scripts give you the tiers cheaply. Rough shape:

```jsonc
// turbo.json
{
  "tasks": {
    "test:unit":    { "dependsOn": ["^build"] },       // layers 1-3, every PR
    "test:e2e":     { "dependsOn": ["^build"] },       // layer 4 (Ollama), nightly
    "test:bedrock": { "dependsOn": ["^build"] }        // layer 4 (Bedrock), nightly/release
  }
}
```

Per-package:

```jsonc
// packages/harness-e2e/package.json
{
  "scripts": {
    "test":          "vitest run",
    "test:e2e":      "E2E_BACKEND=ollama vitest run --config vitest.config.ts",
    "test:bedrock":  "E2E_BACKEND=bedrock vitest run --config vitest.config.ts"
  }
}
```

### 8.2 Flakiness management

Qwen3.5 at T=0.6 has non-zero variance. Strategies used in this repo:

- **`it.runIf(() => available)`** — if the model isn't running locally,
  skip with a warning. No flakes from GPU-not-available.
- **Per-test timeouts** — `180_000` / `240_000` / `300_000` ms per hard
  test. Never set them globally or long-running cases will race with
  unrelated failures.
- **One model per process** — keeps Ollama's VRAM from stacking on
  parallel suites. Switch models via env between runs, not concurrently.

Strategies to add:

- **Pass@k for known-variance tests** (see §7.4).
- **Explicit quarantine list** — tests that pass ≥80% of the time get
  an `@flaky` tag; CI treats them as non-gating until fixed or stabilized.
- **Seed pinning where possible** — both Ollama and Bedrock Converse
  accept a temperature; Ollama also accepts `seed`. Pin seed on tests
  where determinism buys more than it costs (but not Qwen thinking
  mode, where the default 0.6 is intentional).

### 8.3 Cost control for Bedrock

- Gate by `AWS_BEARER_TOKEN_BEDROCK` existence (already done via
  `bedrock.smoke.test.ts`).
- Cap `maxTokens` per test (`bedrock.smoke` uses 16, hard tests use
  default with bounded turns).
- Use cross-region inference only where needed; pin `AWS_REGION` via
  `.env`.
- Run Bedrock tier on merge-to-main + nightly, not every PR.

### 8.4 Warmup and VRAM pressure (Ollama-specific)

The user already manages this manually: stop the old model before
loading a new one, keep one model resident. What to systematize:

- A `beforeAll` hook that calls `ollama stop` + `ollama pull` for the
  target model. Avoids first-call load time contaminating turn-count
  budgets.
- A process-level env gate: `E2E_MODEL=qwen3.5:27b-q4_K_M` per process;
  don't try to run two models in one `vitest` invocation. Use two
  invocations with different env.

---

## 9. Test Fixture Design for File-Mutating Tools

The repo's `packages/write/test/helpers.ts` is the canonical fixture
shape. Generalize it for new tools:

```ts
// Standard set:
makeTempDir(prefix?)          // returns realpath'd tmp dir
writeFixture(dir, name, content)   // returns abs path
readFileUtf8(p)               // utf-8 round-trip
readFileBytes(p)              // binary
sha256(bytes)                 // for ledger + atomic-write checks
makeSession(root, overrides?) // real InMemoryLedger, real sensitive patterns
recordRead(session, path)     // simulate a prior read
```

### 9.1 Known-sha/mtime fixtures for ledger tests

Any test that exercises read-before-mutate needs a known sha. `recordRead`
computes it from disk; to drive `STALE_READ`, call `recordRead` *first*,
then mutate the file, then call the tool. The ledger sha no longer
matches the on-disk sha → `STALE_READ`.

### 9.2 CRLF fixtures

Write with explicit `\r\n`:

```ts
writeFixture(dir, "crlf.txt", "line1\r\nline2\r\nline3\r\n");
```

Assert post-write that the tool's behavior is **spec-conformant**, not
some implicit default. The Edit engine test (`engine.test.ts`) already
normalizes both needle and haystack; verify the spec for Write (preserve
CRLF? normalize to LF?) and test the chosen behavior.

### 9.3 Binary fixtures

`writeBinaryFile(dir, name, Buffer.from(...))`. The TINY_PNG constant in
`read.e2e.hard.test.ts` is the template. For tests needing hard-to-
confuse binary, put the magic bytes (PNG header, ELF header, PDF `%PDF`)
at the start.

### 9.4 Atomic-write verification

Two assertions:

```ts
// 1. Final file exists, is a file (not a directory, not a dangling link)
expect(existsSync(target)).toBe(true);
expect(statSync(target).isFile()).toBe(true);

// 2. No temp file left behind — the atomic-write pattern is
// write(target.tmp.XYZ) + rename(target.tmp.XYZ, target), so if the
// tmp file remains, the rename didn't happen (or copy semantics
// leaked).
const siblings = readdirSync(dir).filter((n) => n.startsWith("atomic.txt"));
expect(siblings).toEqual(["atomic.txt"]);  // no .tmp siblings
```

The second assertion is currently implicit in `write.test.ts` ("writes
cleanly without leaving temp files behind"); making it explicit catches
a class of regressions where the write copies instead of renames.

### 9.5 Validate-hook testing

`write.test.ts` covers both branches:

```ts
const session = makeSession(dir, {
  validate: async () => ({ ok: false, errors: [{ line: 2, message: "..." }] }),
});
// → VALIDATE_FAILED, file not created

const session2 = makeSession(dir, { validate: async () => ({ ok: true }) });
// → text, file created
```

Replicate this for any tool that grows a validate hook (including
future Grep/Glob if they get one).

---

## 10. Specific to This Repo — Vitest and Tooling Tips

### 10.1 Conditional skips for real-model tests

```ts
let available = false;
beforeAll(async () => {
  available = BACKEND === "bedrock"
    ? await bedrockAvailable(process.env.AWS_REGION)
    : await ollamaModelAvailable(MODEL, BASE_URL);
});
it.runIf(() => available)("...", async () => { ... }, 300_000);
```

Vitest's `it.runIf` + `beforeAll` is the clean pattern. `test.skipIf` is
its inverse (skip when condition is true). Both take a **boolean**, so
you can chain conditions:

```ts
it.runIf(() => available && BACKEND === "bedrock")("bedrock-only scenario", ...);
```

### 10.2 Per-test timeouts

Always use the third argument, never the config default, for real-model
tests:

```ts
it.runIf(() => available)("H1 pagination", async () => { ... }, 240_000);
```

`testTimeout: 120_000` is the package-level ceiling for fast tests. E2E
tests opt in to longer timeouts explicitly. Don't bump the global — it
hides regressions.

### 10.3 `test.each` / `test.for` for parametric fixtures

Vitest supports pytest-style parametrization:

```ts
test.for([
  ["empty",   ""],
  ["1-line",  "one\n"],
  ["no-eol",  "no-eol"],
  ["big",     "x\n".repeat(10_000)],
])("read fixture %s handles correctly", ([label, content]) => { ... });
```

Use this for layer-1 and layer-3 tests that sweep input shapes. Don't
use for layer-4 — e2e tests benefit from explicit `describe` blocks
per scenario because the human needs to read the failure log.

### 10.4 `test.concurrent` for independent integration tests

Only for layer 3 and below. Layer 4 is inherently sequential on a
single-GPU machine (one model in VRAM). `describe.concurrent` at the
top level parallelizes safely when each test has its own tmpdir.

### 10.5 Turbo test orchestration

Keep `test:unit` and `test:e2e` as separate turbo tasks. Default `turbo
run test` should run only `test:unit`. E2E is opt-in:

```bash
turbo run test              # fast
turbo run test:e2e          # Ollama
turbo run test:bedrock      # Bedrock (release gate)
```

### 10.6 Bedrock settings via .env, the token via the keyring

The repo ships a zero-dep `loadDotEnv()` in `packages/harness-e2e/src/env.ts`.
Call it at the **top** of any test file that needs Bedrock:

```ts
loadDotEnv();
const BACKEND = resolveBackend();
```

This walks up from cwd, so monorepo-root `.env` works from any workspace.
Never commit `.env`, and keep keys out of it: `.env` holds settings only.

```
E2E_BACKEND=bedrock
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=anthropic.claude-opus-4-7
```

The token comes from the environment, or, when unset, from the OS keyring:
`loadDotEnv()` runs `cred-get bedrock-bearer` and sets
`AWS_BEARER_TOKEN_BEDROCK` (store it with `cred-set bedrock-bearer`). Where
`cred-get` is absent, as in CI, export the variable instead.

### 10.7 pnpm workspace test invocation

```bash
pnpm --filter @agent-sh/harness-e2e test           # unit + e2e in that package
pnpm --filter @agent-sh/harness-e2e test:bedrock   # bedrock-gated only
pnpm -r test                                       # all packages, unit only
```

---

## 11. What's Missing — A Concrete Backlog

Each of these is a test that the spec implies but the suite doesn't
exercise yet. Prioritized:

1. **Layer 5 aggregator.** Script that runs `write.e2e.hard.test.ts`
   on both backends, emits a per-(test, backend) pass/fail JSON, and
   diffs against a checked-in baseline. Regression detection for cross-
   model drift.
2. **CRLF fixture at layer 4.** Real-model edit of a CRLF file; assert
   disk state matches spec post-edit.
3. **Schema drift test.** Call with an extra unknown field; assert
   valibot behavior matches spec (strict or tolerant).
4. **Symlink behavior tests** for Read and Write.
5. **Bedrock throttling injection** — mock `bedrockConverse` to throw
   `ThrottlingException`; assert `runBedrockAgent` behavior.
6. **Pass@k wrapper for known-flaky scenarios** (W4 fuzzy-recovery is
   a candidate; Qwen occasionally over-widens).
7. **Trajectory matcher utility** — a `expectSequence([...])` helper
   that checks ordered subsequence with optional repeats. Cleaner than
   ad-hoc `indexOf` chains.
8. **VCR-style cassettes** around `ollamaChat` and `bedrockConverse`
   for fast CI regression of the *harness* code without hitting real
   models.
9. **Distractor-tool test** — wire a `read_file` tool alongside `read`,
   with a subtly worse description, and observe which one the model
   picks. Tool-description quality signal.
10. **First-turn warmup assertion** — measure turn-1 latency on Ollama
    to detect model-load contamination; bail or warm up in `beforeAll`.

---

## 12. Common Pitfalls

| Pitfall | Why It Happens | How to Avoid |
|---------|---------------|--------------|
| Asserting only `finalContent` | Misses non-invocation, bash-routing, wrong trajectory | Always assert trace (`toolsByName`, `toolSeq`, `turns`) too |
| Global `testTimeout` bumped to 5 min | Hides slow regressions in unrelated tests | Use per-test `300_000` argument; keep package default tight |
| Mocking the model | Tests pass, production breaks | Keep model real at layer 4; only mock for harness regression tests (layer 4.5) |
| `T=0` on Qwen to "make it deterministic" | Collapses thinking, tool selection degrades | Never set T=0 on Qwen3/3.5; use `passAtK` for variance mgmt |
| `think: false` on Qwen to save time | Tool-call quality drops | Keep `think: true` (default); variance is noise worth paying for |
| Running Bedrock on every PR | $$$ | Gate by env; Bedrock runs nightly + release |
| Skipping `beforeAll` availability check | CI red when GPU unreachable | Always gate real-model tests on `ollamaModelAvailable` / `bedrockAvailable` |
| Fixtures without realpath | Symlinks on macOS `/tmp` → `/private/tmp` confuses ledger | `realpathSync(mkdtempSync(...))` as in helpers.ts |
| Testing tool behavior via shell decoy and expecting passing | Model might use shell and produce correct answer — that's a tool-description failure | `expect(readCalls).toBeGreaterThanOrEqual(1)` when the tool should be preferred; `console.warn` when it wasn't |
| Leaving `.env` unloaded | Bedrock tests skip silently | Call `loadDotEnv()` at top of file |
| Treating a passing test as proof the tool works | Layer 4 passes ≠ production ships cleanly on Claude; test the matrix | Gate release on cross-family tier |

---

## 13. Best Practices (Synthesized)

1. **Assert on the trace, not only the answer.** `toolsByName`,
   `toolSeq`, `turns` are the contract with the model. (H4, H7, W2
   already do this.)
2. **Every error code is reachable from at least one layer-1 test.**
   That's the API surface the model sees. (`engine.test.ts` is the bar.)
3. **Every safety rail has both paths exercised.** No-hook hard-deny +
   hook allow + hook deny. (`read.permissions.test.ts` is the bar.)
4. **Real-model tests are gated by availability, never unconditional.**
   `it.runIf(() => available)` + `beforeAll` probe. (Already the pattern.)
5. **One model per process on Ollama.** Manage VRAM pressure explicitly.
6. **Bedrock is a release gate, not a PR gate.** Cost-aware.
7. **Tool descriptions are tested through failure modes.** If a
   description change doesn't break at least one adversarial test, it
   probably didn't change the model's behavior either.
8. **Treat the error message as part of the API.** Changing it requires
   re-running the recovery tests (W2, W3, W4).
9. **Record the trace in CI logs with a stable prefix** (`[W3 ${LABEL}]`)
   so you can grep regressions across runs.
10. **When the model bypasses the tool** (bash-decoy wins), that's a
    tool-description bug, not a model bug. Fix the description, not the
    model.

---

## 14. Further Reading

| Resource | Type | Why Recommended |
|----------|------|-----------------|
| [Anthropic — Define success criteria and build evaluations](https://platform.claude.com/docs/en/docs/test-and-evaluate/develop-tests) | Official docs | Canonical code/human/LLM grading rubrics; directly applicable to layer-5 judges |
| [Anthropic — Tool use overview](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/overview) | Official docs | `strict: true` tool use, tool_use token accounting, clarifying-question behavior per tier |
| [Anthropic — SWE-bench scaffold writeup](https://www.anthropic.com/engineering/swe-bench-sonnet) | Engineering post | Minimal scaffold (bash + edit), iterative tool-description refinement; most similar philosophy to this repo |
| [Anthropic — Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | Engineering post | Tool-testing agent that auto-rewrites descriptions (-40% task time); full production tracing |
| [Anthropic — Claude Code best practices](https://code.claude.com/docs/en/best-practices) | Official docs | Verify-its-own-work as leverage point; context-window degradation as dominant failure driver |
| [Anthropic — Project Vend](https://www.anthropic.com/research/project-vend-1) | Research post | Long-context production agent, observability for diagnosing emergent failures |
| [Berkeley Function Calling Leaderboard (BFCL)](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard) | Benchmark | AST + executable eval, multi-turn categories; pattern for structured tool-call accuracy |
| [TAU-bench](https://github.com/sierra-research/tau-bench) | Benchmark | Pass@k across simulated users + tools + policies; trajectory analysis |
| [SWE-bench README](https://github.com/princeton-nlp/SWE-bench) | Benchmark | Verified / Lite / Multimodal; docker-based evaluator design |
| [Inspect AI (UK AISI)](https://inspect.aisi.org.uk/) | Framework | Solvers + scorers + datasets with sandboxed tool use; MCP + custom scorer patterns |
| [Promptfoo — Anthropic provider](https://www.promptfoo.dev/docs/providers/anthropic/) | Framework | Side-by-side model comparison; YAML-config tool-call testing |
| [OpenAI Evals](https://github.com/openai/evals) | Framework | Eval registry + Completion Function Protocol for tool-using agents |
| [DeepEval](https://github.com/confident-ai/deepeval) | Framework | `ToolCorrectnessMetric`, `TaskCompletion`, pytest-style structure |
| [LangSmith — Evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts) | Docs | Pairwise evaluators, dataset splits/versions, agent trajectory grading |
| [MCP Inspector](https://github.com/modelcontextprotocol/inspector) | Tool | Interactive server testing; form-based tool execution; debugging MCP surface |
| [OpenAI Agents SDK — Tracing](https://github.com/openai/openai-agents-python/blob/main/docs/tracing.md) | SDK docs | `function_span` wraps every tool call; hierarchical trace model |
| [VCR.py](https://github.com/kevin1024/vcrpy) | Library | Record-replay pattern for API interactions; cassette format reference |
| [Nous Research — Hermes Function Calling](https://github.com/NousResearch/Hermes-Function-Calling) | Open-weights pattern | `<tool_call>` XML format; validator.py + Pydantic schema enforcement |
| (in-repo) `packages/harness-e2e/test/read.e2e.hard.test.ts` | Reference tests | Canonical shape for layer-4 hard-scenarios |
| (in-repo) `packages/write/test/*.test.ts` | Reference tests | Canonical layers 1-3; `makeSession` + `InMemoryLedger` + `recordRead` fixtures |

---

*Generated by /learn from 20 sources (14 external + 6 in-repo anchors).*
*See `resources/testing-harness-tools-sources.json` for quality scores
and per-source extracted insights.*
