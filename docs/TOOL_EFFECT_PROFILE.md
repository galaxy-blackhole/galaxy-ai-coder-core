# Canonical Tool Effect Profile

Tool output is model-visible data. It becomes trusted runtime evidence only
through a host-authored `effects` object accompanied by
`effectsAuthority: "host"`. The effect profile is the maximum authority each
built-in tool may exercise; it does not require the tool to emit every listed
effect on every call.

All hosts must derive the active policy from the package export:

```ts
const metadata = createAiCoderCoreToolEffectMetadata(registry.activeDescriptors);

return {
  definitions: registry.definitions,
  snapshotHash: registry.activeHash,
  ...metadata,
};
```

`canonicalToolIds` contains only active definitions. `effectCapabilities`
contains the complete 21-tool profile so its integrity hash remains stable when
`catalog.search` lazily activates another built-in tool.

The profile is version `1.1.0` and covers the complete 21-tool core catalog.

| Canonical tool ID | Allowed host effects | Evidence boundary |
| --- | --- | --- |
| `artifact.create` | `approval`, `state_version` | Artifact-store state only; never a workspace write |
| `artifact.list` | `approval` | Model observation only |
| `artifact.read` | `approval` | Model observation only |
| `catalog.search` | `approval`, `state_version` | Active registry version |
| `command.run` | `approval`, `state_version`, `write` | Write requires an independent changed-file inventory with hashes |
| `command.session` | `approval`, `state_version`, `write` | Same write rule; state may represent supervised session progress |
| `git.exec` | `approval`, `diff_review`, `inspect` | `diff_review` only for a complete, untruncated diff action |
| `perception.analyze` | `approval` | Artifact observations are not workspace inspection evidence |
| `preview.manage` | `approval`, `state_version` | Preview-session state only |
| `project.detect` | `approval`, `inspect` | Deterministically inspected project root |
| `project.validate` | `approval`, `state_version`, `validate`, `write` | High-risk repository scripts require approval/containment; generated writes require independent typed inventory |
| `research.fetch` | `approval`, `research` | Host records bounded, untrusted source evidence durably |
| `research.search` | `approval`, `research` | Host records bounded, untrusted source discovery durably |
| `task.checkpoint` | `approval`, `plan`, `state_version` | Bounded durable task state |
| `user.ask` | `approval` | Correlated answers; no implicit criterion waiver |
| `workspace.edit` | `approval`, `state_version`, `write` | Exact edit plus before/after hashes |
| `workspace.glob` | `approval`, `inspect` | Inspected workspace scope/path |
| `workspace.grep` | `approval`, `inspect` | Inspected matched workspace paths |
| `workspace.list` | `approval`, `inspect` | Inspected directory scope |
| `workspace.read` | `approval`, `inspect` | Inspected bounded file/range |
| `workspace.write` | `approval`, `state_version`, `write` | Atomic create/replace plus before/after hashes |

## Important constraints

- `approval` is available to every built-in tool because task mode, permission,
  and approval policy can deny any invocation. A successful low-risk call may
  report `not_required`; it must not invent a grant.
- `write` is evidence of exact workspace mutation, not permission to mutate.
  Approval and OS/workspace policy are evaluated independently first.
- Mutation evidence compares typed `(kind, hash)` states. Files use a content
  hash; directories and missing paths use `null`; symlinks and special entries
  use a host-defined deterministic hash. The before/after typed states must
  differ. In the legacy kind-less form, create is `null -> hash`, edit is
  `hash -> different hash`, delete is `hash -> null`, and both-null is invalid.
- A metadata fingerprint for generated or dependency state is not a file
  content hash and must never be emitted as `write` evidence. Hosts may report
  those changes separately as bounded derived mutations and advance
  `state_version`; only byte-verifiable durable paths belong in `write`.
- A generic command exit code or stdout statement is not validation. Use
  `project.validate` for structured validation evidence.
- No built-in tool currently has `criterion_satisfy` or `criterion_waive`.
  Those capabilities remain reserved until a dedicated contract can correlate
  a criterion with concrete evidence or an explicit user decision.
- Extension and MCP tools may define a separate versioned profile. They cannot
  alter the authority of a built-in canonical ID.

Runtime initialization rejects a missing policy for an active tool, duplicate
canonical mappings, unknown capability names, and any built-in capability set
that differs from the exported profile.
