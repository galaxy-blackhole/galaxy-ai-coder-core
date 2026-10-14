/**
 * What an agent is allowed to be, named.
 *
 * The settings that decide how a run behaves — how much it asks before acting, whether it works through tools or
 * through a program, which extra capabilities it holds — used to be scattered and written into the code that needed
 * them. One of them was hard-coded to the strictest value and nobody could see it from the outside; the transcript
 * showed the symptom (every command asking permission) long before anyone found the cause.
 *
 * A preset is that whole composition, named once: a caller chooses one by name, and can see what it chose.
 */
import type { AiCoderApprovalProfile } from "../tools/settings-types.js";

export type AgentToolPresentation = "native" | "ptc" | "both";

export interface AgentPreset {
  readonly approvalProfile: AiCoderApprovalProfile;
  readonly description: string;
  /** One line a person can read in a tooltip: what this choice means for them, not what it is called. */
  readonly help: string;
  readonly id: string;
  readonly label: string;
  /** Extra permission ids beyond the granted baseline; empty means the baseline alone. */
  readonly permissions: readonly string[];
  readonly toolPresentation: AgentToolPresentation;
}

/**
 * The four the product offers. Each is a decision a person would recognise — not a bag of flags:
 *
 *   standard  tools, balanced approval; the shape most work wants
 *   ptc       a program per turn instead of one call per step; fewer tokens, fewer round trips
 *   cautious  asks before anything that changes the workspace, tools only
 *   trusted   a workspace the owner already trusts; the fewest interruptions
 */
export const AGENT_PRESETS: readonly AgentPreset[] = Object.freeze([
  Object.freeze({
    approvalProfile: "balanced" as const,
    description: "Tools, with permission asked before anything that changes the workspace.",
    id: "standard",
    help: "Gọi từng công cụ, hỏi trước khi thay đổi workspace.",
    label: "Tiêu chuẩn",
    permissions: Object.freeze([]),
    toolPresentation: "native" as const,
  }),
  Object.freeze({
    approvalProfile: "balanced" as const,
    description: "A program per turn instead of a call per step.",
    id: "ptc",
    help: "Mỗi lượt gửi MỘT chương trình thay vì gọi từng bước — ít token, ít vòng hơn.",
    label: "Chương trình",
    permissions: Object.freeze(["workspace.read", "workspace.write"]),
    toolPresentation: "ptc" as const,
  }),
  Object.freeze({
    approvalProfile: "strict" as const,
    description: "Asks more often, and works through tools only.",
    id: "cautious",
    help: "Hỏi nhiều hơn, và chỉ dùng công cụ.",
    label: "Thận trọng",
    permissions: Object.freeze([]),
    toolPresentation: "native" as const,
  }),
  Object.freeze({
    approvalProfile: "trusted-workspace" as const,
    description: "A workspace the owner already trusts; the fewest interruptions.",
    id: "trusted",
    help: "Workspace bạn đã tin: ít ngắt nhất.",
    label: "Tin cậy",
    permissions: Object.freeze(["workspace.read", "workspace.write"]),
    toolPresentation: "ptc" as const,
  }),
]);

/**
 * The preset a name refers to, or null when the name means nothing — an unknown name is a refusal to guess, not a
 * silent fall back to a default nobody asked for.
 */
export function resolveAgentPreset(id: string | undefined | null): AgentPreset | null {
  if (id === undefined || id === null) return null;
  const wanted = id.trim().toLowerCase();
  return AGENT_PRESETS.find((preset) => preset.id === wanted) ?? null;
}

/** The preset a caller gets when it names none. */
export const DEFAULT_AGENT_PRESET_ID = "ptc";
