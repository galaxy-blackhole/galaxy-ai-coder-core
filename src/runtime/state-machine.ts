export type AiCoderRunState =
  | "cancelled"
  | "completed"
  | "compacting"
  | "created"
  | "executing"
  | "failed"
  | "inspecting"
  | "paused"
  | "planning"
  | "preparing"
  | "resuming"
  | "reviewing"
  | "validating"
  | "waiting_approval";

export type AiCoderTerminalRunState = Extract<AiCoderRunState, "cancelled" | "completed" | "failed" | "paused">;

const states = (...values: AiCoderRunState[]): readonly AiCoderRunState[] => Object.freeze(values);
const OPERATIONAL = Object.freeze(["inspecting", "planning", "executing", "validating", "reviewing"] as const);
const INTERRUPTIBLE = Object.freeze(["waiting_approval", "compacting", "paused", "failed", "cancelled"] as const);

const TRANSITIONS: Readonly<Record<AiCoderRunState, readonly AiCoderRunState[]>> = Object.freeze({
  cancelled: Object.freeze([]),
  completed: Object.freeze([]),
  compacting: states(...OPERATIONAL, "waiting_approval", "failed", "cancelled", "paused"),
  created: states("preparing", "cancelled"),
  executing: states(...OPERATIONAL, ...INTERRUPTIBLE),
  failed: Object.freeze([]),
  inspecting: states(...OPERATIONAL, ...INTERRUPTIBLE),
  paused: Object.freeze([]),
  planning: states(...OPERATIONAL, ...INTERRUPTIBLE),
  preparing: states("inspecting", "planning", "executing", "reviewing", "resuming", "paused", "failed", "cancelled"),
  resuming: states("inspecting", "planning", "executing", "validating", "reviewing", "paused", "failed", "cancelled"),
  reviewing: states(...OPERATIONAL, "completed", ...INTERRUPTIBLE),
  validating: states(...OPERATIONAL, ...INTERRUPTIBLE),
  waiting_approval: states(...OPERATIONAL, "compacting", "paused", "failed", "cancelled"),
});

export type AiCoderStateTransition = Readonly<{
  from: AiCoderRunState;
  reason: string;
  sequence: number;
  timestamp: string;
  to: AiCoderRunState;
}>;

export class AiCoderInvalidStateTransitionError extends Error {
  constructor(readonly from: AiCoderRunState, readonly to: AiCoderRunState) {
    super(`Invalid AI Coder state transition: ${from} -> ${to}.`);
    this.name = "AiCoderInvalidStateTransitionError";
  }
}

export function canTransitionAiCoderRun(from: AiCoderRunState, to: AiCoderRunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isAiCoderTerminalState(state: AiCoderRunState): state is AiCoderTerminalRunState {
  return state === "cancelled" || state === "completed" || state === "failed" || state === "paused";
}

export class AiCoderRunStateMachine {
  private readonly historyValue: AiCoderStateTransition[] = [];
  private sequence = 0;

  constructor(
    private stateValue: AiCoderRunState = "created",
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get state(): AiCoderRunState {
    return this.stateValue;
  }

  get history(): readonly AiCoderStateTransition[] {
    return Object.freeze([...this.historyValue]);
  }

  transition(to: AiCoderRunState, reason: string): AiCoderStateTransition | null {
    if (to === this.stateValue) return null;
    if (!canTransitionAiCoderRun(this.stateValue, to)) throw new AiCoderInvalidStateTransitionError(this.stateValue, to);
    const transition = Object.freeze({
      from: this.stateValue,
      reason,
      sequence: this.sequence += 1,
      timestamp: this.now(),
      to,
    });
    this.stateValue = to;
    this.historyValue.push(transition);
    return transition;
  }
}
