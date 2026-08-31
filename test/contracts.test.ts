import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelCapabilities } from "../src/ports/capability-port.js";
import {
  isExecutionCanceled,
  type ToolExecutionContext,
} from "../src/ports/execution-context.js";
import type { HostAdapter } from "../src/ports/host-adapter.js";
import {
  isPortFailure,
  isPortSuccess,
  portFailure,
  portSuccess,
  type PortResult,
  type PortSuccess,
} from "../src/ports/port-result.js";
import type {
  WorkspaceApplyPatchResult,
  WorkspaceReaderPort,
  WorkspaceWriterPort,
} from "../src/ports/workspace-port.js";
import type {
  CodingModelAdapter,
  CodingRoundRequest,
  CodingToolResultMessage,
} from "../src/tools/coding-messages.js";
import {
  DEFAULT_AI_CODER_CORE_SETTINGS,
  isAiCoderCoreSettings,
  type AiCoderCoreSettings,
} from "../src/tools/settings-types.js";
import type { AiCoderRuntimeToolResult } from "../src/runtime/runtime-types.js";

function toolContext(signal: AbortSignal): ToolExecutionContext {
  return {
    deadline: Date.now() + 1_000,
    idempotencyKey: "idem-1",
    mode: "auto",
    runId: "run-1",
    signal,
    taskId: "task-1",
    toolCallId: "call-1",
    workspaceRoot: "/workspace",
  };
}

test("PortResult narrows to data or a structured error", () => {
  const success: PortResult<number> = portSuccess(42);
  const failure: PortResult<number> = portFailure({
    code: "NOT_FOUND",
    message: "missing",
    retryable: false,
  });

  assert.equal(isPortSuccess(success), true);
  if (isPortSuccess(success)) assert.equal(success.data, 42);

  assert.equal(isPortFailure(failure), true);
  if (isPortFailure(failure)) {
    assert.equal(failure.error.code, "NOT_FOUND");
    assert.equal("data" in failure, false);
  }
});

test("execution context propagates cancellation and absolute deadlines", () => {
  const controller = new AbortController();
  const context = toolContext(controller.signal);
  assert.equal(isExecutionCanceled(context, context.deadline - 1), false);
  assert.equal(isExecutionCanceled(context, context.deadline), true);

  controller.abort();
  assert.equal(isExecutionCanceled(context), true);
});

test("tool results require stable provider correlation", () => {
  const call = {
    arguments: { path: "src/index.ts" },
    name: "workspace_read_text",
    toolCallId: "provider-call-17",
  } as const;
  const result: CodingToolResultMessage = {
    content: "ok",
    role: "tool",
    toolCallId: "provider-call-17",
    toolName: "workspace_read_text",
  };

  assert.equal(call.toolCallId, result.toolCallId);
  assert.equal(result.toolCallId, "provider-call-17");
});

test("model attachments preserve artifact provenance and untrusted status", () => {
  const request: CodingRoundRequest = {
    attachments: [
      {
        artifactId: "artifact-1",
        contentSha256: "sha256:image",
        mimeType: "image/png",
        name: "screenshot.png",
        provenance: { source: "user_upload" },
        retention: "temporary",
        trust: "untrusted_data",
      },
    ],
    messages: [{ content: "Inspect the screenshot", role: "user" }],
    preserveThinking: false,
    think: false,
    tools: [],
  };

  assert.equal(request.attachments?.[0]?.trust, "untrusted_data");
});

test("single-agent settings reject legacy multiple mode", () => {
  assert.equal(isAiCoderCoreSettings(DEFAULT_AI_CODER_CORE_SETTINGS), true);
  assert.equal(Object.isFrozen(DEFAULT_AI_CODER_CORE_SETTINGS), true);
  assert.equal(Object.isFrozen(DEFAULT_AI_CODER_CORE_SETTINGS.singleAgent), true);
  assert.equal(
    isAiCoderCoreSettings({
      ...DEFAULT_AI_CODER_CORE_SETTINGS,
      executionMode: "multiple",
    }),
    false,
  );
});

test("model capability snapshot stays deployment-specific", () => {
  const capabilities: ModelCapabilities = {
    evidence: [
      {
        observedAt: "2026-08-28T00:00:00.000Z",
        source: "runtime_probe",
        verified: true,
      },
    ],
    identity: {
      baseUrl: "https://example.invalid",
      digest: "sha256:model",
      model: "coding-model",
      provider: "openai-compatible",
    },
    input: {
      audio: "unknown",
      image: "supported",
      text: "supported",
      video: "unsupported",
    },
    output: { image: "unsupported", text: "supported" },
    parallelToolCalling: "unknown",
    preserveThinking: "supported",
    streaming: "supported",
    structuredOutput: "supported",
    thinking: "optional",
    tokenCounting: "supported",
    toolCalling: "supported",
  };

  assert.equal(capabilities.identity.digest, "sha256:model");
  assert.equal(capabilities.input.image, "supported");
});

test("a read-only host does not receive mutation capabilities", () => {
  const reader = {} as WorkspaceReaderPort;
  const model = {} as CodingModelAdapter;
  const host: HostAdapter = { codingModel: model, workspaceReader: reader };

  assert.equal(host.workspaceWriter, undefined);
  assert.equal(host.command, undefined);
  assert.equal(host.commandSession, undefined);
});

test("workspace writer exposes one atomic patch operation", () => {
  const writer: WorkspaceWriterPort = {
    async applyPatch(input, context) {
      assert.equal(input.precondition.kind, "matches_sha256");
      assert.equal(context.toolCallId, "call-1");
      return portSuccess<WorkspaceApplyPatchResult>({
        afterContentSha256: "after",
        beforeContentSha256: "before",
        path: input.path,
        replacements: 1,
        resolvedPath: `/workspace/${input.path}`,
      });
    },
    async mkdir(input) {
      return portSuccess({ created: true, path: input.path });
    },
    async writeText(input) {
      return portSuccess({
        afterContentSha256: "after",
        length: input.content.length,
        path: input.path,
        resolvedPath: `/workspace/${input.path}`,
      });
    },
  };
  const context = toolContext(new AbortController().signal);

  return writer
    .applyPatch(
      {
        newText: "new",
        oldText: "old",
        path: "src/index.ts",
        precondition: {
          contentSha256: "before",
          kind: "matches_sha256",
        },
      },
      context,
    )
    .then((result) => {
      assert.equal(result.ok, true);
    });
});

test("compile-time contracts reject ambiguous success, mode, and mutation shapes", () => {
  // @ts-expect-error A successful port result must carry data.
  const ambiguousSuccess: PortSuccess<number> = { ok: true };
  const multipleMode: AiCoderCoreSettings = {
    ...DEFAULT_AI_CODER_CORE_SETTINGS,
    // @ts-expect-error The new core is single-agent only.
    executionMode: "multiple",
  };
  // @ts-expect-error Every full write must make its precondition explicit.
  const unsafeWrite: Parameters<WorkspaceWriterPort["writeText"]>[0] = {
    content: "replacement",
    path: "src/index.ts",
  };
  // @ts-expect-error Failed results cannot attest successful mutation effects.
  const failedMutation: AiCoderRuntimeToolResult = {
    canonicalToolId: "workspace.write",
    content: "partial",
    effects: { writes: [{ afterHash: "after", beforeHash: "before", path: "src/a.ts" }] },
    effectsAuthority: "host",
    error: { code: "PARTIAL", message: "failed after commit", retryable: false },
    ok: false,
    summary: "partial failure",
    trust: "workspace",
  };

  assert.deepEqual(ambiguousSuccess, { ok: true });
  assert.equal(multipleMode.executionMode, "multiple");
  assert.equal(unsafeWrite.path, "src/index.ts");
  assert.equal(failedMutation.ok, false);
});
