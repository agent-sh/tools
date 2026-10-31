# agent-sh tools

**Agent tools built for how LLMs actually call tools:** `read`, `write`/`edit`, `grep`, `glob`, `bash`, `webfetch`, `websearch`, `lsp`, `skill` and `batch`. Each ships as its own npm package and as a Rust crate with matching behavior.

[![npm](https://img.shields.io/npm/v/@agent-sh/harness-tools?label=%40agent-sh%2Fharness-tools)](https://www.npmjs.com/package/@agent-sh/harness-tools)
[![crates.io](https://img.shields.io/crates/v/harness-tools?label=harness-tools)](https://crates.io/crates/harness-tools)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Most tool libraries are written for deterministic callers. The caller here is a model (Claude, GPT, Qwen, Gemini and others) that guesses parameter names, misremembers paths and retries on whatever the error says. So every result is a typed union instead of a thrown exception, every error carries a recovery hint, and anything that reaches outside the workspace has to pass a permission check.

```text
read({ path: "src/permisions.ts" })

kind: "error"   code: "NOT_FOUND"
File not found: src/permisions.ts

Did you mean one of these?
src/permissions.ts
```

## Contents

- [Packages](#packages)
- [Install](#install)
- [Web search and fetch in Claude Code and Codex](#web-search-and-fetch-in-claude-code-and-codex)
- [Use it in an agent loop](#use-it-in-an-agent-loop)
- [Permissions](#permissions)
- [Design principles](#design-principles)
- [Rust](#rust)
- [Repository layout](#repository-layout)
- [Development](#development)

## Packages

| Tool | npm | What it does |
|---|---|---|
| read | [`@agent-sh/harness-read`](./packages/read) | Bounded, line-numbered file reads with pagination, directory listing, image/PDF attachments, binary refusal, and a "did you mean" `NOT_FOUND`. |
| write | [`@agent-sh/harness-write`](./packages/write) | Atomic `write`, targeted `edit` and `multi_edit`. A read-before-edit ledger blocks blind overwrites; `OLD_STRING_NOT_UNIQUE` lists every match. |
| grep | [`@agent-sh/harness-grep`](./packages/grep) | ripgrep-backed content search with structured output modes, pagination, and regex hints on `INVALID_REGEX`. |
| glob | [`@agent-sh/harness-glob`](./packages/glob) | Filename search that respects ignore files, sorted by modification time, fenced to the workspace. |
| bash | [`@agent-sh/harness-bash`](./packages/bash) | Shell with a persistent working directory, inactivity and wall-clock timeouts, head+tail spill-to-file for huge output, and background jobs (`bash_output`, `bash_kill`). |
| batch | [`@agent-sh/harness-batch`](./packages/batch) | Run one command across many directories (glob, subdirectories or an explicit list). |
| webfetch | [`@agent-sh/harness-webfetch`](./packages/webfetch) | HTTP GET/POST with SSRF defense, readability + markdown extraction, redirect-chain reporting, size caps and a per-session cache. |
| websearch | [`@agent-sh/harness-websearch`](./packages/websearch) | Web search with **no API key and no setup** (Exa → Parallel → Mojeek → Marginalia → Wikipedia), optionally Brave, Tavily or self-hosted SearXNG. When one engine comes up short, results from several are merged and ranked. |
| lsp | [`@agent-sh/harness-lsp`](./packages/lsp) | Language-server hover, definition, references, implementation and symbols, with 1-indexed positions and retry hints while the server starts. |
| skill | [`@agent-sh/harness-skill`](./packages/skill) | [Agent Skills](https://agentskills.io) `SKILL.md` activation with progressive disclosure and trust-gated project skills. |
| web-mcp | [`@agent-sh/harness-web-mcp`](./packages/web-mcp) | MCP server exposing `websearch` and `webfetch` to Claude Code, Codex and any MCP client. |
| core | [`@agent-sh/harness-core`](./packages/core) | Shared result types, errors, permission policy, read ledger and adapters. Every tool builds on it. |
| **all** | [`@agent-sh/harness-tools`](./packages/tools) | Everything above under one import, plus a [pi](https://github.com/earendil-works/pi) coding-agent extension. |

## Install

```sh
npm install @agent-sh/harness-tools        # everything
npm install @agent-sh/harness-websearch    # or just the tools you need
```

Node.js ≥ 20 for the single-tool packages. `@agent-sh/harness-tools`, `@agent-sh/harness-webfetch` and `@agent-sh/harness-web-mcp` need Node 22.22.2+, 24.15.0+ or 26+. ESM and CommonJS builds, with TypeScript types.

## Web search and fetch in Claude Code and Codex

The fastest way to use these tools needs no code. [`@agent-sh/harness-web-mcp`](./packages/web-mcp) serves `websearch` and `webfetch` over MCP, and search works with no API key.

**Claude Code**

```sh
claude mcp add -s user harness-web -- npx -y @agent-sh/harness-web-mcp
```

**Codex**

```sh
codex mcp add harness-web -- npx -y @agent-sh/harness-web-mcp
```

Restart the agent (in Claude Code, `/mcp` reconnects) and ask it to search the web. The tools appear as `mcp__harness-web__websearch` / `mcp__harness-web__webfetch` in Claude Code and under `harness-web` in Codex.

Optional upgrades are environment variables passed at registration, for example a free Brave key for broader search:

```sh
claude mcp add -s user harness-web -e BRAVE_API_KEY=... -- npx -y @agent-sh/harness-web-mcp
codex mcp add harness-web --env BRAVE_API_KEY=... -- npx -y @agent-sh/harness-web-mcp
```

| Variable | Effect |
|---|---|
| `BRAVE_API_KEY` / `TAVILY_API_KEY` | That engine leads the search chain; the keyless chain stays as fallback. |
| `EXA_API_KEY` / `PARALLEL_API_KEY` | Raise those engines' keyless rate limits. |
| `SEARXNG_URL` | Use a self-hosted SearXNG first, e.g. `http://127.0.0.1:8888`. |
| `HARNESS_WEB_FETCH_ALLOW_LOOPBACK=1` / `HARNESS_WEB_FETCH_ALLOW_PRIVATE=1` | Let `webfetch` reach localhost / private networks (blocked by default). |

Config-file setups (`~/.claude.json`, `.mcp.json`, `~/.codex/config.toml`) and a global install are in the [package README](./packages/web-mcp#readme).

## Use it in an agent loop

Every tool exports a ready-made definition (`name`, `description`, JSON Schema `inputSchema`) to hand to the model, and an async function that runs the call. The descriptions are part of the product: they teach the model how to use the tool well, so pass them through unchanged.

```ts
import {
  read, grep, websearch,
  readToolDefinition, grepToolDefinition, websearchToolDefinition,
  DEFAULT_SENSITIVE_PATTERNS,
} from "@agent-sh/harness-tools";

const cwd = process.cwd();
const session = {
  cwd,
  permissions: {
    roots: [cwd],                                   // the workspace fence
    sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,  // .env, keys, ~/.aws/credentials, ...
    hook: async (req) => (req.tool === "websearch" ? "allow" : "deny"),
  },
};

// 1. Advertise the tools to your model (Anthropic, OpenAI, Bedrock, Ollama, ...).
const tools = [readToolDefinition, grepToolDefinition, websearchToolDefinition];

// 2. Run whatever tool call the model sends back.
const handlers = { read, grep, websearch };

async function runToolCall(name: string, input: unknown) {
  const result = await handlers[name](input, session);
  // Every result is a union on `kind`; errors are values, never exceptions.
  return result.kind === "error"
    ? `${result.error.code}: ${result.error.message}`
    : result.output;
}
```

The text you return goes straight back to the model, recovery hints included. If you need structured data, read the typed fields on `result` (for example `meta`, or `results` for websearch) instead of parsing `output`.

## Permissions

Permissions fail closed.

- **`roots`** fences file tools to the workspace. Paths outside are refused unless the hook allows them.
- **`sensitivePatterns`** blocks secrets even inside the workspace. `DEFAULT_SENSITIVE_PATTERNS` covers `.env*`, SSH and TLS keys, `~/.aws/credentials`, service-account JSON and similar.
- **`hook(request) => "allow" | "deny"`** decides anything that leaves the fence or touches the outside world. `request` carries the tool, path, action and metadata.
- Tools with side effects outside the workspace (`bash`, `webfetch`, `websearch`, `lsp`, `skill`) **refuse to run without a hook**. For scripts and tests you can opt out explicitly with `unsafeAllowBashWithoutHook`, `unsafeAllowFetchWithoutHook`, `unsafeAllowSearchWithoutHook`, `unsafeAllowLspWithoutHook` or `unsafeAllowSkillWithoutHook`. The names are deliberately loud.
- **`batch` has no permission hook.** `executeBatch(params, workspaceRoot)` runs the command with `bash -c` in every target and only drops targets that resolve outside `workspaceRoot`. Validate input with `safeParseBatchParams` and gate the call yourself.

## Design principles

The textual surface of a tool (its name, description, field names, error messages, output shape and pagination hints) is its real contract with a model. Each choice below follows from that.

- **Typed results, not exceptions.** A model reliably acts on `kind: "not_found"`. It does not reliably parse an error buried in a stack trace.
- **Recovery hints in every error.** `NOT_FOUND` lists likely siblings, `OLD_STRING_NOT_UNIQUE` lists every match location, and `INVALID_REGEX` explains the escape. The model is expected to fix the call and retry.
- **Alias pushback.** Send `file_path` instead of `path` and you get a targeted "did you mean `path`?" instead of a generic schema error.
- **Bounded output.** Pagination, size caps, and head+tail spill-to-file keep one call from flooding the context window.
- **Tested against real models.** [`packages/harness-e2e`](./packages/harness-e2e) runs real tool-call loops for every tool on four Ollama models plus Claude Opus on Bedrock, and checks each run against a recorded baseline.
- **Spec first.** Each tool's contract lives in [`agent-knowledge/design/`](./agent-knowledge/design/). Code and spec change together.

More in [`AGENTS.md`](./AGENTS.md).

## Rust

Every tool has a Rust port under [`crates/`](./crates), published to crates.io as `harness-<tool>` (`harness-read`, `harness-websearch`, …) with the umbrella crate [`harness-tools`](https://crates.io/crates/harness-tools). The ports keep parity with the TypeScript packages: same inputs, same result kinds, same error codes.

```sh
cargo add harness-tools
```

## Repository layout

```text
tools/
├─ packages/              TypeScript packages, one per tool (npm)
│  ├─ core/               @agent-sh/harness-core
│  ├─ read/ … skill/      @agent-sh/harness-<tool>
│  ├─ tools/              @agent-sh/harness-tools (umbrella + pi extension)
│  └─ harness-e2e/        private: real-LLM tool-call test harness
├─ crates/                Rust ports, one crate per tool (crates.io)
└─ agent-knowledge/
   ├─ design/             canonical per-tool specs
   └─ *.md                research guides (LSP, skills, exec, webfetch, …)
```

## Development

Use a supported Node release from `package.json` (Node 22.22.2+, 24.15.0+, or 26+) for development. tsup 9 and Vitest 5 require Node 22 or newer.

```sh
pnpm install
pnpm build && pnpm test && pnpm typecheck    # TypeScript (pnpm 9)
cargo test --workspace                       # Rust (stable toolchain)
```

**End-to-end runs against real models.** `packages/harness-e2e` drives tool-call loops on `gemma4:e2b`, `gemma4:26b`, `qwen3:8b` and `qwen3.5:27b-q4_K_M` (Ollama), plus Claude Opus on Bedrock. Baselines in `packages/harness-e2e/baselines/` (gitignored, recorded locally with `aggregate:<tool>:update`) encode what "good" looks like per tool and model; `pnpm --filter @agent-sh/harness-e2e aggregate:<tool>:check` compares a fresh run against them.

**Releases** use [Changesets](https://github.com/changesets/changesets). Add one with `pnpm changeset` in your PR. On merge to `main`, the release workflow opens a "chore: version packages" PR, and merging that publishes to npm. Rust crates publish from version tags. Required repository secrets: `NPM_TOKEN` (publish rights on the `@agent-sh` scope) and `CARGO_REGISTRY_TOKEN`.

**Contributing.** The specs in [`agent-knowledge/design/`](./agent-knowledge/design/) are canonical: a behavior change updates the spec in the same PR, and vice versa. See [`AGENTS.md`](./AGENTS.md).

## License

[MIT](LICENSE) © Avi Fenesh
