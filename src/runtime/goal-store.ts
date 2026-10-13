/**
 * Goals that outlive a turn.
 *
 * A checkpoint records what a run is doing right now; a goal records what the work is *for*, and keeps saying so
 * across turns, compactions and restarts. Every change is an event and every goal carries the revision those events
 * produced, so a caller that read a goal an hour ago cannot silently overwrite a decision made since: it passes the
 * revision it saw and is told when the world moved on.
 */
export type GoalPhase = "active" | "paused" | "blocked" | "complete";
export type GoalAction = "edit" | "pause" | "resume" | "complete" | "blocked";

export interface GoalState {
  readonly blockedReason: string | null;
  readonly id: string;
  readonly maxGoalRounds: number;
  readonly objective: string;
  readonly phase: GoalPhase;
  readonly revision: number;
  readonly roundsStarted: number;
  readonly updatedAt: number;
}

export type GoalEvent =
  | Readonly<{ type: "created"; at: number; id: string; objective: string; maxGoalRounds: number }>
  | Readonly<{ type: "edited"; at: number; id: string; objective: string; revision: number }>
  | Readonly<{ type: "phase"; action: GoalAction; at: number; id: string; phase: GoalPhase; reason?: string; revision: number }>
  | Readonly<{ type: "round"; at: number; id: string; revision: number; roundsStarted: number }>;

const DEFAULT_MAX_ROUNDS = 12;

/** What a caller asked for, and whether the revision it held was still current. */
export type GoalUpdateResult =
  | Readonly<{ ok: true; goal: GoalState }>
  | Readonly<{ conflict: GoalState; ok: false }>
  | Readonly<{ missing: true; ok: false }>;

export class GoalStore {
  private readonly goals = new Map<string, GoalState>();
  private readonly journal: GoalEvent[] = [];
  private next = 1;

  create(objective: string, maxGoalRounds?: number): GoalState {
    const id = "goal-" + String(this.next);
    this.next += 1;
    const goal: GoalState = Object.freeze({
      blockedReason: null,
      id,
      maxGoalRounds: Math.max(1, maxGoalRounds ?? DEFAULT_MAX_ROUNDS),
      objective: objective.trim(),
      phase: "active",
      revision: 1,
      roundsStarted: 0,
      updatedAt: Date.now(),
    });
    this.goals.set(id, goal);
    this.journal.push(Object.freeze({ at: goal.updatedAt, id, maxGoalRounds: goal.maxGoalRounds, objective: goal.objective, type: "created" }));
    return goal;
  }

  get(id: string): GoalState | null {
    return this.goals.get(id) ?? null;
  }

  /** The most recent goal, which is the one a session means when it does not name one. */
  current(): GoalState | null {
    const all = [...this.goals.values()];
    return all.length === 0 ? null : (all[all.length - 1] ?? null);
  }

  list(): readonly GoalState[] {
    return [...this.goals.values()];
  }

  /** Every change, in the order it happened: the state is a fold over this, never a separate truth. */
  events(): readonly GoalEvent[] {
    return [...this.journal];
  }

  /**
   * One transition, guarded by the revision the caller last saw. A stale revision is a conflict and changes nothing:
   * two people editing one objective is a decision, and decisions belong to the person, not to whoever wrote last.
   */
  update(id: string, revision: number, action: GoalAction, patch: Readonly<{ objective?: string; blockedReason?: string; maxGoalRounds?: number }> = {}): GoalUpdateResult {
    const current = this.goals.get(id);
    if (current === undefined) return Object.freeze({ missing: true as const, ok: false as const });
    if (current.revision !== revision) return Object.freeze({ conflict: current, ok: false as const });

    const phase: GoalPhase = action === "edit" ? current.phase
      : action === "pause" ? "paused"
      : action === "resume" ? "active"
      : action === "complete" ? "complete"
      : "blocked";
    const objective = patch.objective === undefined ? current.objective : patch.objective.trim();
    const blockedReason = action === "blocked" ? (patch.blockedReason ?? current.blockedReason) : null;
    const next: GoalState = Object.freeze({
      blockedReason,
      id: current.id,
      maxGoalRounds: Math.max(1, patch.maxGoalRounds ?? current.maxGoalRounds),
      objective,
      phase,
      revision: current.revision + 1,
      roundsStarted: action === "resume" ? current.roundsStarted + 1 : current.roundsStarted,
      updatedAt: Date.now(),
    });
    this.goals.set(id, next);
    if (action === "edit") {
      this.journal.push(Object.freeze({ at: next.updatedAt, id, objective, revision: next.revision, type: "edited" }));
    } else {
      this.journal.push(Object.freeze({
        action,
        at: next.updatedAt,
        id,
        phase,
        revision: next.revision,
        type: "phase",
        ...(blockedReason === null ? {} : { reason: blockedReason }),
      }));
    }
    return Object.freeze({ goal: next, ok: true as const });
  }
}
