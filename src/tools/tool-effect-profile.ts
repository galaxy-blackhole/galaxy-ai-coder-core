/**
 * Canonical host-effect policy for the built-in AI Coder tool catalog.
 *
 * Hosts must consume this profile instead of maintaining a local copy. The
 * runtime treats these entries as a maximum authority boundary: a tool may
 * omit an allowed effect, but it must never emit an effect absent here.
 */

import { compareAiCoderText } from "../deterministic-order.js";
import { AI_CODER_CORE_TOOL_CATALOG } from "./tool-registry.js";
import type { AiCoderToolDescriptor } from "./tool-registry-types.js";

const EFFECT_CAPABILITY_NAMES = [
  "approval",
  "criterion_satisfy",
  "criterion_waive",
  "diff_review",
  "inspect",
  "plan",
  "research",
  "state_version",
  "validate",
  "write",
] as const;

export type AiCoderToolEffectCapability = (typeof EFFECT_CAPABILITY_NAMES)[number];

export const AI_CODER_TOOL_EFFECT_CAPABILITIES: readonly AiCoderToolEffectCapability[] = Object.freeze(
  [...EFFECT_CAPABILITY_NAMES],
);

export const AI_CODER_CORE_TOOL_EFFECT_PROFILE_VERSION = "1.1.0";

function effectCapabilities(
  ...values: readonly AiCoderToolEffectCapability[]
): readonly AiCoderToolEffectCapability[] {
  return Object.freeze([...values].sort(compareAiCoderText));
}

/**
 * Exact effect capabilities for all 21 built-in tools. An empty or omitted
 * effect is always valid; these arrays only describe effects a host may attest.
 * Acceptance-criterion effects intentionally remain unavailable to built-in
 * tools until a dedicated evidence-bearing contract is introduced.
 */
export const AI_CODER_CORE_TOOL_EFFECT_PROFILE: Readonly<
  Record<string, readonly AiCoderToolEffectCapability[]>
> = Object.freeze({
  "artifact.create": effectCapabilities("approval", "state_version"),
  "artifact.list": effectCapabilities("approval"),
  "artifact.read": effectCapabilities("approval"),
  "catalog.search": effectCapabilities("approval", "state_version"),
  "command.run": effectCapabilities("approval", "state_version", "write"),
  "command.session": effectCapabilities("approval", "state_version", "write"),
  "git.exec": effectCapabilities("approval", "diff_review", "inspect"),
  "perception.analyze": effectCapabilities("approval"),
  "preview.manage": effectCapabilities("approval", "state_version"),
  "project.detect": effectCapabilities("approval", "inspect"),
  "project.validate": effectCapabilities("approval", "state_version", "validate", "write"),
  "research.fetch": effectCapabilities("approval", "research"),
  "research.search": effectCapabilities("approval", "research"),
  "task.checkpoint": effectCapabilities("approval", "plan", "state_version"),
  "user.ask": effectCapabilities("approval"),
  "workspace.edit": effectCapabilities("approval", "state_version", "write"),
  "workspace.glob": effectCapabilities("approval", "inspect"),
  "workspace.grep": effectCapabilities("approval", "inspect"),
  "workspace.list": effectCapabilities("approval", "inspect"),
  "workspace.read": effectCapabilities("approval", "inspect"),
  "workspace.write": effectCapabilities("approval", "state_version", "write"),
});

export type AiCoderCoreToolEffectMetadata = Readonly<{
  canonicalToolIds: Readonly<Record<string, string>>;
  effectCapabilities: Readonly<Record<string, readonly AiCoderToolEffectCapability[]>>;
}>;

type EffectProfileInput = Readonly<{
  descriptors?: readonly Pick<AiCoderToolDescriptor, "id" | "modelName">[];
  effectCapabilities?: Readonly<Record<string, readonly string[]>>;
}>;

function ownEntry(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Return every catalog/profile drift issue without throwing at the first one. */
export function validateAiCoderCoreToolEffectProfile(
  input: EffectProfileInput = {},
): readonly string[] {
  const descriptors = input.descriptors ?? AI_CODER_CORE_TOOL_CATALOG;
  const profile = input.effectCapabilities ?? AI_CODER_CORE_TOOL_EFFECT_PROFILE;
  const errors: string[] = [];
  const allowed = new Set<string>(AI_CODER_TOOL_EFFECT_CAPABILITIES);
  const catalogIds = new Set<string>();
  const modelNames = new Set<string>();

  for (const descriptor of descriptors) {
    if (!descriptor.id.trim()) errors.push("Catalog contains an empty canonical tool ID.");
    else if (catalogIds.has(descriptor.id)) errors.push(`Duplicate canonical tool ID: ${descriptor.id}.`);
    else catalogIds.add(descriptor.id);

    if (!descriptor.modelName.trim()) errors.push(`Tool ${descriptor.id || "<empty>"} has an empty model name.`);
    else if (modelNames.has(descriptor.modelName)) errors.push(`Duplicate model-facing tool name: ${descriptor.modelName}.`);
    else modelNames.add(descriptor.modelName);
  }

  for (const id of [...catalogIds].sort(compareAiCoderText)) {
    if (!ownEntry(profile, id)) errors.push(`Effect profile is missing core tool ${id}.`);
  }
  for (const id of Object.keys(profile).sort(compareAiCoderText)) {
    if (!catalogIds.has(id)) errors.push(`Effect profile contains unknown core tool ${id}.`);
    const values = profile[id];
    if (!Array.isArray(values)) {
      errors.push(`Effect profile for ${id} must be an array.`);
      continue;
    }
    const normalized = [...new Set(values)].sort(compareAiCoderText);
    if (normalized.length !== values.length) errors.push(`Effect profile for ${id} contains duplicates.`);
    if (normalized.some((value, index) => value !== values[index])) {
      errors.push(`Effect profile for ${id} must use canonical deterministic order.`);
    }
    for (const value of values) {
      if (!allowed.has(value)) errors.push(`Effect profile for ${id} contains unknown capability ${value}.`);
    }
  }
  return Object.freeze(errors);
}

export function assertAiCoderCoreToolEffectProfile(input: EffectProfileInput = {}): void {
  const errors = validateAiCoderCoreToolEffectProfile(input);
  if (errors.length > 0) throw new Error(`Invalid AI Coder core tool effect profile: ${errors.join(" ")}`);
}

/**
 * Fail closed when a host changes the authority of a built-in tool. Unknown
 * canonical IDs are extension/MCP tools and remain governed by the host's
 * explicitly declared profile.
 */
export function assertAiCoderCoreToolEffectCapabilities(
  canonicalToolId: string,
  actual: readonly string[],
): void {
  const expected = AI_CODER_CORE_TOOL_EFFECT_PROFILE[canonicalToolId];
  if (expected === undefined) return;
  const normalized = [...new Set(actual)].sort(compareAiCoderText);
  if (normalized.length !== actual.length
    || normalized.some((value, index) => value !== expected[index])
    || normalized.length !== expected.length) {
    throw new Error(
      `Core tool ${canonicalToolId} effect capabilities drifted; expected [${expected.join(", ")}], received [${actual.join(", ")}].`,
    );
  }
}

/**
 * Build the exact active model-name mapping plus the complete stable effect
 * policy expected by `AiCoderRuntimeToolSet`. Hosts should call this for the
 * registry's active descriptors on every tool-set snapshot.
 */
export function createAiCoderCoreToolEffectMetadata(
  descriptors: readonly Pick<AiCoderToolDescriptor, "id" | "modelName">[],
): AiCoderCoreToolEffectMetadata {
  const canonicalToolIds: Record<string, string> = {};
  const seenIds = new Set<string>();

  for (const descriptor of [...descriptors].sort((left, right) => compareAiCoderText(left.id, right.id))) {
    const capabilities = AI_CODER_CORE_TOOL_EFFECT_PROFILE[descriptor.id];
    if (capabilities === undefined) throw new Error(`No core effect profile exists for ${descriptor.id}.`);
    if (seenIds.has(descriptor.id)) throw new Error(`Duplicate active canonical tool ID: ${descriptor.id}.`);
    if (ownEntry(canonicalToolIds, descriptor.modelName)) {
      throw new Error(`Duplicate active model-facing tool name: ${descriptor.modelName}.`);
    }
    seenIds.add(descriptor.id);
    canonicalToolIds[descriptor.modelName] = descriptor.id;
  }

  return Object.freeze({
    canonicalToolIds: Object.freeze(canonicalToolIds),
    // Keep the complete profile stable across lazy tool activation. The
    // runtime still limits invocation/result identity to canonicalToolIds.
    effectCapabilities: AI_CODER_CORE_TOOL_EFFECT_PROFILE,
  });
}

// A catalog/profile mismatch is a package construction error, not a condition
// a host is allowed to recover from with a locally invented policy.
assertAiCoderCoreToolEffectProfile();
