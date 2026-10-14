/**
 * Watches a reminder store while nobody is asking anything.
 *
 * A reminder is a promise made to a person, and a promise that is only kept when they happen to speak first is not
 * kept. This is the part that makes it fire on its own: it looks at the store on an interval, and hands whatever came
 * due to the host, which decides how a person is told.
 *
 * `tick()` is public and takes its clock by injection, so the rule can be tested without waiting for a timer — and the
 * marking is shared with the turn path, so a reminder that fires while idle is not repeated at the next turn.
 */
import { dueReminders, markDelivered, readReminders, writeReminders, type Reminder } from "./reminders.js";

export interface ReminderWatcherOptions {
  /** Where the store is right now, or null when this host has none to watch. */
  readonly file: () => string | null;
  readonly onDue: (reminders: readonly Reminder[]) => Promise<void> | void;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_REMINDER_INTERVAL_MS = 30_000;

export class ReminderWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: ReminderWatcherOptions) {}

  start(): void {
    if (this.timer !== null) return;
    const interval = this.options.intervalMs ?? DEFAULT_REMINDER_INTERVAL_MS;
    this.timer = setInterval(() => { void this.tick(); }, Math.max(1_000, interval));
    /* A watcher must never be the reason a process refuses to exit. */
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass: whatever is due is marked delivered and handed over. A store that cannot be read or written is a
   * silent pass rather than a thrown error, because a watcher runs unattended and has nobody to tell.
   */
  async tick(): Promise<readonly Reminder[]> {
    const file = this.options.file();
    if (file === null) return Object.freeze([]);
    try {
      const now = (this.options.now ?? Date.now)();
      const reminders = await readReminders(file);
      const due = dueReminders(reminders, now);
      if (due.length === 0) return Object.freeze([]);
      let next = reminders;
      for (const reminder of due) next = markDelivered(next, reminder.id, now);
      await writeReminders(file, next);
      await this.options.onDue(due);
      return due;
    } catch {
      return Object.freeze([]);
    }
  }
}
