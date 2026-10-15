import assert from "node:assert/strict";
import test from "node:test";
import { AI_CODER_CORE_TOOL_CATALOG } from "../src/tools/tool-registry.js";
import { createAiCoderCoreToolEffectMetadata } from "../src/tools/tool-effect-profile.js";

/**
 * A credential obtained through conversation is only safe if the tool that obtains it cannot hand the secret back.
 * These tests hold the three things that make that true: the tool exists, it carries a policy like every other tool,
 * and the shape it declares cannot hold a secret.
 */
const descriptor = AI_CODER_CORE_TOOL_CATALOG.find((tool) => tool.id === "authorization.request");

test("asking for a credential is a tool a run can be offered", () => {
  assert.ok(descriptor, "authorization.request must be in the catalogue");
  assert.equal(descriptor.modelName, "request_credential");
  assert.match(descriptor.description, /never enters this conversation/i, "the model is told the answer stays out");
});

test("it carries an effect policy, so it can never be offered without one", () => {
  const metadata = createAiCoderCoreToolEffectMetadata([descriptor!]);
  assert.deepEqual(metadata.effectCapabilities["authorization.request"], ["approval", "state_version"]);
});

test("the declared output cannot carry the credential itself", () => {
  const properties = Object.keys((descriptor!.outputSchema as { properties?: Record<string, unknown> }).properties ?? {});
  assert.deepEqual([...properties].sort(), ["credential", "masked", "stored"]);
  assert.equal(properties.includes("secret"), false);
  assert.equal(properties.includes("value"), false);
});

test("the credential name is required, so a caller cannot ask for an anonymous secret", () => {
  const required = (descriptor!.inputSchema as { required?: readonly string[] }).required ?? [];
  assert.equal(required.includes("credential"), true);
  assert.equal(required.includes("message"), true);
});
