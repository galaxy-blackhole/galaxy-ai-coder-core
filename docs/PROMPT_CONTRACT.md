# Runtime-Owned Prompt Contract

The AI Coder system prompt is core-owned executable policy. A host supplies
structured facts and policy choices; it never supplies prompt text, a prompt
version, or a claimed prompt hash.

## Run request

```ts
const request: AiCoderRunRequest = {
  taskId: "task-123",
  workspaceRoot: "/workspace/project",
  goal: "Fix the parser and add regression coverage.",
  mode: "auto",
  constraints: ["Do not change the public wire format."],
  acceptanceCriteria: [
    { id: "parser-regression", text: "The reported parser case passes." },
  ],
  prompt: {
    approvalProfile: "balanced",
    complexity: "standard",
    networkAccess: "policy_gated",
    writeAccess: "allowed",
    dirtyStateSummary: "modified: src/parser.ts",
    trustedWorkspaceInstructions: [
      {
        source: "AGENTS.md",
        content: "Run the focused parser tests before the full suite.",
        contentHash: "sha256:...",
      },
    ],
  },
};
```

Required prompt fields are:

- `approvalProfile`: `strict`, `balanced`, or `trusted-workspace`;
- `complexity`: `simple`, `standard`, or `complex`;
- `networkAccess`: `allowed`, `denied`, or `policy_gated`;
- `writeAccess`: `allowed`, `denied`, or `policy_gated`.

`dirtyStateSummary` is optional untrusted workspace-state data. Trusted
workspace instructions are optional host-validated records with provenance;
quoted repository content does not become trusted merely because it was read
from a particular filename.

The former `systemPrompt`, `promptHash`, `promptVersion`, and
`workspaceInstructions` request fields are rejected synchronously. Unknown
request and prompt fields are also rejected so typos cannot silently weaken
policy.

## Assembly lifecycle

After obtaining verified model capabilities and the current registry snapshot,
the runtime calls `assembleAiCoderPrompt`. The resulting immutable
`AiCoderPromptSnapshot` owns the complete system prompt, versions,
deterministic SHA-256 hash, token estimates, registry hash, and model capability
snapshot.

The context manager receives only this assembled system prompt. Checkpoints and
trace events use the snapshot's hash and version; callers cannot claim them
independently.

Lazy tool activation changes the active registry hash. The runtime therefore
reassembles the prompt, atomically replaces the P0 system-policy context item,
updates its integrity snapshot, and emits another `prompt_snapshot` trace. The
canonical 21-tool effect profile remains stable across activation.

## User task lifecycle

The runtime creates one `AiCoderTaskContract` from goal, mode, complexity,
constraints, acceptance-criterion IDs, and workspace identity. It calls
`formatAiCoderUserTask` exactly once for the P0 user task. There is no second
runtime-local formatter, and trusted workspace instructions are not copied into
the user message.

If no explicit acceptance criteria are supplied, the contract contains no
invented criterion. The runtime does not create an unsatisfiable inferred
criterion.

## Resume compatibility

Resume probes capabilities, restores the checkpoint tool snapshot, and
reassembles the prompt from structured configuration. It requires exact prompt,
system-prompt, task-contract, registry, effect-policy, model-identity, and model-
capability hashes. Changing any of those inputs rejects the checkpoint instead
of silently continuing under a different contract. Capability evidence keeps
its semantic source/verification state in the prompt; volatile probe timestamps
are diagnostic-only and cannot invalidate an otherwise compatible resume.
