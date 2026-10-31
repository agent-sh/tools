# Batch tool

Execute one shell command in several selected directories. The production tool and real-model adapter expose the same JSON schema.

`command` is required. `targets` is a required object with exactly one of these forms:

- `{ kind: "subdirs", path: "/workspace", name_filter?: "repo-*" }`
- `{ kind: "glob", pattern: "/workspace/repo-*" }`
- `{ kind: "explicit", paths: ["/workspace/a", "/workspace/b"] }`

Declare the object type, discriminator and fields directly on the JSON schema's `targets` property, as well as keeping its `oneOf` branches. Renderers that do not display union branches must still show an object with `kind`, `path`, `pattern` and `paths`. Include concrete object examples in the description. Do not decode a string into a selector or accept `mode` as the target discriminator. Invalid target errors retain their validation detail and show the three valid object forms.

The separate optional `mode` is `sequential` (default) or `parallel`. Other controls are `max_concurrent` (parallel, default4), `timeout_secs` (1..3600, default120), `fail_fast` (defaultfalse) and `summary_only` (defaultfalse). Unknown fields remain invalid. Execution and workspace checks stay in `executeBatch`; schema guidance grants no additional access.

The default response reports per-target paths, status and a bounded stdout preview. `summary_only` returns success/failure/timeout counts. Empty target sets return the no-matching-targets response. Sequential fail-fast must receive the complete ordered target list and stop after the first failed target.

Real-model qualification in `packages/harness-e2e/test/batch.e2e.test.ts` covers explicit and ambiguous subdirectory requests, no-target recovery, parallel fanout, sequential fail-fast, a shell distractor, large-output summary selection, optional controls and paths with spaces. Positive cases require actual Batch calls and execution results. Both thinking-open and closed API models must pass; protocol-only assertion controls do not count as model coverage.
