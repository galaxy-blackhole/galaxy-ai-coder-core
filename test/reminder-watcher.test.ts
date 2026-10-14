import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReminderWatcher } from "../src/runtime/reminder-watcher.js";
import { addReminder, readReminders, writeReminders, type Reminder } from "../src/runtime/reminders.js";

const base = { createdAt: 1_000, dueAt: 5_000, id: "r1", text: "nhắc khi rảnh" };

test("a reminder that came due while nobody was asking is handed over once", async () => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-watch-"));
  const file = join(root, "reminders.json");
  const seen: Reminder[][] = [];
  try {
    await writeReminders(file, addReminder([], base));
    const watcher = new ReminderWatcher({ file: () => file, now: () => 6_000, onDue: (due) => { seen.push([...due]); } });
    await watcher.tick();
    assert.deepEqual(seen.map((batch) => batch.map((item) => item.id)), [["r1"]]);
    await watcher.tick();
    assert.equal(seen.length, 1, "said once, even though the watcher keeps looking");
    const stored = await readReminders(file);
    assert.equal(stored[0]?.deliveredAt, 6_000, "and it is written down as said");
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("nothing is due before its time, and a host with no store is left alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-watch-"));
  const file = join(root, "reminders.json");
  let calls = 0;
  try {
    await writeReminders(file, addReminder([], base));
    const early = new ReminderWatcher({ file: () => file, now: () => 4_999, onDue: () => { calls += 1; } });
    assert.deepEqual(await early.tick(), []);
    const homeless = new ReminderWatcher({ file: () => null, now: () => 9_999, onDue: () => { calls += 1; } });
    assert.deepEqual(await homeless.tick(), []);
    assert.equal(calls, 0);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("a store that cannot be read is a silent pass, not a crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-watch-"));
  try {
    const watcher = new ReminderWatcher({ file: () => join(root, "không-có-thư-mục-này", "x.json"), now: () => 1, onDue: () => { throw new Error("không được gọi"); } });
    assert.deepEqual(await watcher.tick(), []);
    assert.throws(() => { throw new Error("x"); });
  } finally { await rm(root, { force: true, recursive: true }); }
});
