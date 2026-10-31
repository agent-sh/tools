# AGENTS.md: `@agent-sh/harness-*` monorepo

Guidance for AI agents working on this repo. The repo builds LLM-facing agent
tools (Read, Write, Grep, Glob, ...) as a TypeScript-first npm library, with
Rust ports coming later. The tools are consumed by real language models inside
agent harnesses, **not** by deterministic callers.

## The prime directive: treat LLM tools as a chaotic distributed system, not as kernel code

The user is a systems software engineer (Valkey, CRIU, ElastiCache). These
tools look like regular functions (typed inputs, typed outputs, clean error
enums), but that framing is a trap. The consumer is a probabilistic model,
so the contract is not "given these args, produce this output." The contract is:

> Given only the tool's *textual surface* (name, description, schema field
> names, error messages, output shape, pagination hints), does a real model,
> across many families (Qwen, Llama, GPT, Claude, Codex, DeepSeek), pick this tool,
> call it correctly, interpret the result, and make good next moves
> without giving up and falling back to Bash?

That is the spec. Everything else is implementation detail.

### Why this matters: the failure modes that unit tests never catch

1. **Description-driven misuse.** An ambiguous parameter name (`path` vs
   `file_path`, `limit` vs `max_lines`) causes the model to pass the wrong
   thing. The code is fine. The tool is broken.
2. **Unrecoverable errors.** `ENOENT` with no context leaves the model stuck.
   A NOT_FOUND that lists sibling candidates lets it self-correct.
3. **Ignored hints.** The output says `next_offset: 2000` but the model
   re-reads from 0 and loops. The pagination design is the failure.
4. **Silent non-invocation.** The model reads the description, decides the
   tool doesn't fit, and shells out to `cat` / `grep` / `ls` via Bash
   instead. You will not see this in any unit test. You will only see it
   when you log real sessions and notice your tool is never called.
5. **Hallucinated output.** The tool returns JSON the model misparses, so
   the model confidently reports content that was never in the file.
6. **Tool-as-friction.** A well-intentioned safety rail (sensitive-path
   deny, forced pagination, mandatory ledger confirmation) makes the tool
   annoying enough that the model routes around it. The user has shipped
   many tools and watched exactly this happen: "too many to count."

Summary: LLMs are statistics. "Return 0 or 1" doesn't mean you get 0 or 1.
Precisely because of that, you must be **more** systematic than you would
be for deterministic code, not less. Cover every edge case, every
"unbelievable" behavior, and verify against real models in the loop.

## What counts as a test for an LLM tool

- **Unit tests do not count** as validation of the tool's LLM contract.
  They validate the code. They are necessary but never sufficient.
- **E2E tests with a real model** are the primary validation surface.
  Every tool must be exercised by at least one real LLM, end-to-end,
  calling the tool through the same JSON-schema surface a production
  harness would use.
- **Multi-model coverage** is required before a tool ships. The same
  description lands differently on Qwen vs Llama vs GPT vs Claude or Codex. At
  minimum: one thinking-capable open model (Qwen3.5 family) plus one
  closed model (Claude or GPT, including a Codex workflow) via its API.
- **Multi-prompt coverage** per tool. At minimum include:
  - Golden path (obvious correct invocation)
  - Ambiguous phrasing ("take a look at X" vs "read X")
  - Adversarial / distractor prompts (tempting to use Bash instead)
  - Multi-turn: error → self-correct → retry
  - Pagination / size-limit case
  - Edge cases in the schema (optional fields omitted, unusual types)
  - Attachment / binary / non-text paths where applicable
- **Observe, don't just assert.** For every e2e run, record:
  - Did the tool get called at all? (Non-invocation is a failure mode.)
  - How many turns did the task take? (Turn count is a quality metric.)
  - Did the args match what a human would send? (Off-by-one, wrong
    units, hallucinated required fields.)
  - Did the model's final answer reflect the tool output faithfully?
  - Did the model try to route around the tool (Bash, shell, another
    tool it shouldn't use)? If yes, the tool is the problem.

## Operational rules for this repo

- **Keep Qwen models in thinking mode for e2e runs.** Do not pass
  `think: false` or `/no_think` to a run that exercises a tool: thinking
  off lowers tool-call quality, which is what the suites measure, so
  latency is not a reason to turn it off. `think` defaults to `true` in
  `packages/harness-e2e`, including the one-word warmup.
- **E2E harness is `packages/harness-e2e`.** It is the canonical place to
  prove a tool works. New tools must land with a corresponding e2e suite
  that covers the categories above.
- **Spec and code move together.** Each tool's spec lives in
  `agent-knowledge/design/` (for example `agent-knowledge/design/read.md`)
  and is the cross-language source of truth for TS and future Rust ports.
  When one changes, change the other in the same change.
- **Safety rails must fail open to the hook, not hard-deny.** If a rail
  is annoying enough for the model to route around, it fails its purpose.
  Current pattern: sensitive-path and out-of-workspace requests go
  through a permission hook; only fall back to a deny error when no hook
  is wired up. (Decision D11 in the Read spec.)
- **Error messages are part of the API.** They are read by a model, not
  a human. Treat them like documentation: specific, actionable, include
  the alternatives the model should try next (e.g. suggested siblings on
  NOT_FOUND).
- **Output shapes are discriminated unions**, not free-form strings. The
  model parses `kind: "text" | "directory" | "attachment" | "error"` far
  more reliably than it parses embedded markers in a string.

## Stack & tooling (context, not instructions)

- TypeScript monorepo: Turborepo + pnpm workspace + tsup (dual ESM/CJS)
  + vitest + valibot + changesets.
- Strict TS: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `isolatedModules`.
- E2E model: `qwen3.5:27b-q4_K_M` on local Ollama, GPU-offloaded on
  RTX 5090 Laptop (CUDA 12.0). Thinking on. See
  `packages/harness-e2e/test/read.e2e.test.ts` for the canonical shape.
- Published surface: umbrella `@agent-sh/harness-tools` plus per-tool
  packages (`@agent-sh/harness-read`, `-write`, `-grep`, `-glob`, ...).

## Working agreement

- Once a task is authorized, design and implement it without asking at
  each step. Ask only for a real safety boundary or a material change of
  scope.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
