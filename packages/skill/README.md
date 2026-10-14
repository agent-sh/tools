# @agent-sh/harness-skill

Authored [Agent Skills](https://agentskills.io) activation with progressive disclosure, permission-gated activation, and trust-gated project skills.

Part of the [`@agent-sh/harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context and the full tool surface.

## Install

```sh
npm install @agent-sh/harness-skill
```

Requires Node ≥ 20.

## Usage

```ts
import { skill, FilesystemSkillRegistry } from "@agent-sh/harness-skill";

const session = {
  cwd: process.cwd(),
  permissions: { roots: [process.cwd()], sensitivePatterns: [], unsafeAllowSkillWithoutHook: true },
  registry: new FilesystemSkillRegistry([".skills"]),
  trust: { trustedRoots: [process.cwd()] },
  activated: new Set<string>(),
};

const r = await skill({ name: "api-conventions" }, session);
```

## Contract

The full contract — input shape, output discriminated-union, error codes, permission model, and acceptance tests — lives in [`agent-knowledge/design/skill.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/skill.md). Changes to this package must stay in sync with that spec.

## License

MIT © Avi Fenesh
