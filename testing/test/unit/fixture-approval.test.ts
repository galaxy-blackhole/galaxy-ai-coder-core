import type {
  AiCoderApprovalRequest,
  AiCoderToolDescriptor,
  ToolExecutionContext,
} from "@galaxy-stack/ai-coder-core";
import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureApprovalPort } from "../../src/lab/fixture-approval.js";

const tool = Object.freeze({ id: "command.run", modelName: "command_run" }) as AiCoderToolDescriptor;
const request = Object.freeze({ tool }) as AiCoderApprovalRequest;
const context = Object.freeze({
  runId: "run-approval",
  taskId: "task-approval",
  toolCallId: "call-approval",
  idempotencyKey: "key-approval",
  mode: "auto",
  workspaceRoot: "/tmp",
  signal: new AbortController().signal,
  deadline: Date.now() + 10_000,
}) satisfies ToolExecutionContext;

test("fixture approval fails closed when no decision exists", async () => {
  const result = await createFixtureApprovalPort()(request, context);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.approved, false);
});

test("fixture approval accepts an explicit canonical tool decision", async () => {
  const result = await createFixtureApprovalPort({ "command.run": "allow" })(request, context);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.approved, true);
});
