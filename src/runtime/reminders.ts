/**
 * Reminders that outlive a session.
 *
 * A reminder is a promise made to a person: at this time, say this again. It has to survive a restart, so it is a
 * file rather than memory; it has to be answerable, so it records the session it came from and the moment it was
 * delivered; and it has to be safe to read twice, so delivery is a marking rather than a deletion.
 *
 * The logic here is pure — a list in, a list out — and the file is only a place to keep it, because the rule that
 * decides what is due must be the same one a test can run without a clock.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Reminder {
  readonly createdAt: number;
  /** When it should be spoken, in epoch milliseconds. */
  readonly dueAt: number;
  readonly id: string;
  /** Where it came from, so the answer arrives in the conversation that asked for it. */
  readonly sessionId?: string;
  readonly text: string;
  /** Set once it has been delivered; a reminder is marked, never silently dropped. */
  readonly deliveredAt?: number;
}

export interface AddReminderInput {
  readonly createdAt: number;
  readonly dueAt: number;
  readonly id: string;
  readonly sessionId?: string;
  readonly text: string;
}

/** Due means due: not yet delivered, and the time has come. */
export function dueReminders(reminders: readonly Reminder[], now: number): readonly Reminder[] {
  return reminders.filter((reminder) => reminder.deliveredAt === undefined && reminder.dueAt <= now);
}

export function addReminder(reminders: readonly Reminder[], input: AddReminderInput): readonly Reminder[] {
  const reminder: Reminder = Object.freeze({
    createdAt: input.createdAt,
    dueAt: input.dueAt,
    id: input.id,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    text: input.text,
  });
  return Object.freeze([...reminders, reminder].sort((left, right) => left.dueAt - right.dueAt || (left.id < right.id ? -1 : 1)));
}

export function removeReminder(reminders: readonly Reminder[], id: string): readonly Reminder[] {
  return Object.freeze(reminders.filter((reminder) => reminder.id !== id));
}

export function markDelivered(reminders: readonly Reminder[], id: string, at: number): readonly Reminder[] {
  return Object.freeze(reminders.map((reminder) => reminder.id === id ? Object.freeze({ ...reminder, deliveredAt: at }) : reminder));
}

/** A reminder that has already been said, newest first — history, not a queue. */
export function deliveredReminders(reminders: readonly Reminder[]): readonly Reminder[] {
  return reminders
    .filter((reminder) => reminder.deliveredAt !== undefined)
    .sort((left, right) => (right.deliveredAt ?? 0) - (left.deliveredAt ?? 0));
}

/**
 * Reads the file, tolerating everything: a missing file, a broken line, an entry written by an older version. A
 * reminder store that refuses to load is worse than one that forgets a malformed entry.
 */
export async function readReminders(file: string): Promise<readonly Reminder[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return Object.freeze([]);
  }
  if (!Array.isArray(raw)) return Object.freeze([]);
  const reminders: Reminder[] = [];
  for (const entry of raw) {
    const value = entry as Partial<Reminder>;
    if (typeof value.id !== "string" || typeof value.text !== "string") continue;
    if (typeof value.dueAt !== "number" || typeof value.createdAt !== "number") continue;
    if (!Number.isFinite(value.dueAt) || !Number.isFinite(value.createdAt)) continue;
    reminders.push(Object.freeze({
      createdAt: value.createdAt,
      dueAt: value.dueAt,
      ...(typeof value.deliveredAt === "number" ? { deliveredAt: value.deliveredAt } : {}),
      id: value.id,
      ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
      text: value.text,
    }));
  }
  return Object.freeze(reminders);
}

/**
 * Writes through a temporary file and a rename, so a crash cannot leave half a reminder behind.
 */
export async function writeReminders(file: string, reminders: readonly Reminder[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + ".tmp";
  await writeFile(temporary, JSON.stringify(reminders, null, 2) + "\n", "utf8");
  await rename(temporary, file);
}
