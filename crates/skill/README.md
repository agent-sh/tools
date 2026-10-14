# harness-skill

Authored [Agent Skills](https://agentskills.io) activation with progressive disclosure, permission-gated activation, trust-gated project skills.

Rust port of [`@agent-sh/harness-skill`](https://www.npmjs.com/package/@agent-sh/harness-skill). Part of the [`harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context.

## Install

```toml
[dependencies]
harness-skill = "0.1"
```

## Usage

```rust
use harness_skill::{skill, FilesystemSkillRegistry};
use harness_skill::types::{SkillSessionConfig, SkillPermissionPolicy, SkillTrustPolicy, ActivatedSet};
use harness_core::PermissionPolicy;
use std::sync::Arc;
use serde_json::json;

let perms = SkillPermissionPolicy::new(PermissionPolicy::new(vec!["/workspace".into()]))
    .with_unsafe_bypass(true);
let registry = Arc::new(FilesystemSkillRegistry::new(vec!["/workspace/.skills".into()]));
let mut session = SkillSessionConfig::new("/workspace", perms, registry);
session.trust = SkillTrustPolicy {
    trusted_roots: vec!["/workspace".into()],
    untrusted_project_skills: None,
};
session.activated = Some(ActivatedSet::new());
let r = skill(json!({ "name": "api-conventions" }), &session).await;
```

## Contract

The full contract lives in [`agent-knowledge/design/skill.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/skill.md). Changes to this crate must stay in sync with that spec, and with the TypeScript sibling at [`@agent-sh/harness-skill`](https://www.npmjs.com/package/@agent-sh/harness-skill).

## License

MIT © Avi Fenesh
