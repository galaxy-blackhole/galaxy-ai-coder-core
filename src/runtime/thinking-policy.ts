/**
 * Thinking (reasoning) effort differs per system and per model: Ollama's
 * \`think\` field takes a boolean or the named levels low/medium/high/max,
 * Claude takes a token budget, Gemini a thinking level, OpenAI a
 * \`reasoning_effort\`. The CLI keeps one shared vocabulary, then resolves per
 * model which choices exist and what actually reaches the wire.
 */

/** Levels shared across systems, in escalation order. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** A pickable option: the system default ("don't send the field") plus levels. */
export type ThinkingChoice = "default" | "off" | "on" | ThinkingLevel;
/** Probed provider capability, mirroring the core capability port. */
export type ThinkingCapabilityState = "none" | "optional" | "required" | "unknown";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
/** Levels Ollama accepts by name (docs/api.md, the \`think\` field). */
export const OLLAMA_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high", "max"];
/** Wire values the Ollama adapter can carry. */
export type OllamaThinkingValue = boolean | "low" | "medium" | "high" | "max";

export const THINKING_LABELS: Readonly<Record<ThinkingChoice, string>> = Object.freeze({
  default: "Mặc định",
  off: "Tắt",
  on: "Bật",
  minimal: "Tối thiểu",
  low: "Thấp",
  medium: "Vừa",
  high: "Cao",
  xhigh: "Rất cao",
  max: "Tối đa",
});

export interface ThinkingPolicy {
  readonly kind: "none" | "toggle" | "levels" | "required" | "unknown";
  /** Pickable choices; "default" is always first. */
  readonly choices: readonly ThinkingChoice[];
  readonly default: ThinkingChoice;
  /** Wire overrides declared by the manual config entry (reasoningEfforts). */
  readonly wire: Readonly<Partial<Record<ThinkingChoice, string | null>>>;
  readonly notes: readonly string[];
}

export interface ResolveThinkingInput {
  readonly model?: string;
  readonly capability?: ThinkingCapabilityState;
  /** Per-model declaration from ~/.galaxy/config.json (DSH-style reasoningEfforts). */
  readonly declared?: Readonly<Record<string, unknown>>;
  /** Manual entry or --thinking selection, before validation. */
  readonly preferred?: string;
}

/** Model whose chat template requires thinking; mirrors the core probe exception. */
const REQUIRES_THINKING = /(^|\/)kimi-k2\.7-code(?::|$)/i;
const ALIASES: Readonly<Record<string, ThinkingChoice>> = Object.freeze({
  auto: "default", system: "default", macdinh: "default",
  true: "on", on: "on", bat: "on",
  false: "off", off: "off", none: "off", tat: "off",
});

/** Parse a user or config value into a shared choice, or undefined when unknown. */
export function parseThinkingChoice(raw: string | undefined): ThinkingChoice | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return undefined;
  if (value in ALIASES) return ALIASES[value];
  return (THINKING_LEVELS as readonly string[]).includes(value) ? value as ThinkingLevel : undefined;
}

function sanitizeWire(declared: Readonly<Record<string, unknown>> | undefined, notes: string[]): Partial<Record<ThinkingChoice, string | null>> {
  const wire: Partial<Record<ThinkingChoice, string | null>> = {};
  if (declared === undefined) return wire;
  for (const [key, value] of Object.entries(declared)) {
    const choice = parseThinkingChoice(key);
    if (choice === undefined || choice === "default" || choice === "on") { notes.push('bỏ qua mức suy luận không nhận diện được: "' + key + '"'); continue; }
    if (value === null || value === "") {
      if (choice !== "off") { notes.push('mức "' + key + '" cần giá trị wire, chỉ "off" được để trống'); continue; }
      wire.off = null;
      continue;
    }
    if (typeof value !== "string") { notes.push('mức "' + key + '" phải là chuỗi hoặc null'); continue; }
    wire[choice] = value.trim().length > 0 ? value.trim() : null;
  }
  return wire;
}

/** Resolve the pickable thinking choices for one model. */
export function resolveThinkingPolicy(input: ResolveThinkingInput = {}): ThinkingPolicy {
  const notes: string[] = [];
  const wire = sanitizeWire(input.declared, notes);
  const declaredLevels = THINKING_LEVELS.filter(level => wire[level] !== undefined);
  const preferred = parseThinkingChoice(input.preferred);
  const pick = (choices: readonly ThinkingChoice[], fallback: ThinkingChoice): ThinkingChoice =>
    preferred !== undefined && choices.includes(preferred) ? preferred : fallback;
  if (Object.keys(wire).length > 0) {
    if (declaredLevels.length === 0) {
      notes.push("reasoningEfforts không khai mức nào ngoài off");
      return { kind: "none", choices: ["default"], default: "default", wire, notes };
    }
    const hasOff = wire.off !== undefined;
    const choices: readonly ThinkingChoice[] = ["default", ...(hasOff ? ["off" as const] : []), ...declaredLevels];
    return { kind: hasOff ? "levels" : "required", choices, default: pick(choices, "default"), wire, notes };
  }
  if (REQUIRES_THINKING.test(input.model ?? "")) {
    notes.push("model này yêu cầu suy luận nên không tắt được");
    const choices: readonly ThinkingChoice[] = ["default", ...OLLAMA_THINKING_LEVELS];
    return { kind: "required", choices, default: pick(choices, "default"), wire, notes };
  }
  if (input.capability === "none") {
    notes.push("model không khai báo khả năng suy luận");
    return { kind: "none", choices: ["default"], default: "default", wire, notes };
  }
  if (input.capability === "unknown") {
    notes.push("chưa xác minh được model có hỗ trợ suy luận; mức gửi đi có thể bị bỏ qua");
    const choices: readonly ThinkingChoice[] = ["default", "off", ...OLLAMA_THINKING_LEVELS];
    return { kind: "unknown", choices, default: pick(choices, "default"), wire, notes };
  }
  const choices: readonly ThinkingChoice[] = ["default", "off", ...OLLAMA_THINKING_LEVELS];
  notes.push("route này nhận mức suy luận qua trường think");
  return { kind: "levels", choices, default: pick(choices, "default"), wire, notes };
}

export interface ThinkingOption { readonly choice: ThinkingChoice; readonly label: string }

export function thinkingOptions(policy: ThinkingPolicy): readonly ThinkingOption[] {
  return policy.choices.map(choice => ({ choice, label: THINKING_LABELS[choice] }));
}

export function isThinkingAllowed(policy: ThinkingPolicy, choice: ThinkingChoice): boolean {
  return policy.choices.includes(choice);
}

/** Next choice in the policy list, wrapping around. */
export function cycleThinking(policy: ThinkingPolicy, current: ThinkingChoice): ThinkingChoice {
  const index = policy.choices.indexOf(current);
  if (index < 0) return policy.default;
  return policy.choices[(index + 1) % policy.choices.length]!;
}

/** Label shown in the TUI, with the system default spelled out. */
export function thinkingLabel(choice: ThinkingChoice): string {
  return choice === "default" ? THINKING_LABELS.default + " (hệ thống)" : THINKING_LABELS[choice];
}

/** The value handed to the Ollama adapter; undefined sends no think field. */
export function toOllamaThinking(policy: ThinkingPolicy, choice: ThinkingChoice): OllamaThinkingValue | undefined {
  if (!isThinkingAllowed(policy, choice)) return undefined;
  if (choice === "default") return undefined;
  if (choice === "off") return false;
  if (choice === "on") return true;
  const override = policy.wire[choice];
  if (typeof override === "string" && isOllamaLevel(override)) return override;
  return isOllamaLevel(choice) ? choice : undefined;
}

function isOllamaLevel(value: string): value is "low" | "medium" | "high" | "max" {
  return (OLLAMA_THINKING_LEVELS as readonly string[]).includes(value);
}
