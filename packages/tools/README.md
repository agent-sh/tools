# @agent-sh/harness-tools

Umbrella package re-exporting every `@agent-sh/harness-*` tool under one import. Install this if you want everything.

Part of the [`@agent-sh/harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context and the full tool surface.

## Install

```sh
npm install @agent-sh/harness-tools
```

Requires Node 22.22.2+, 24.15.0+ or 26+.

## Usage

```ts
import { read, grep, glob, bash, webfetch, websearch, lsp, skill } from "@agent-sh/harness-tools";

// Or import a single tool via its subpath:
import { read } from "@agent-sh/harness-tools/read";
```

This package also exposes `./pi-extension` through `pi.extensions` for Pi Coding Agent hosts using `@earendil-works/pi-coding-agent` 1.3 line. The deprecated `@mariozechner` package is no longer used for the extension's type contract.

## Contract

This is a foundation package; see the per-tool packages it supports for concrete contracts.

## License

MIT © Avi Fenesh
