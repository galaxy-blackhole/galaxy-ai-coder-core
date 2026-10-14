import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addReminder, deliveredReminders, dueReminders, formatReminderNote, markDelivered, readReminders, removeReminder, writeReminders } from "../src/runtime/reminders.js";

const base = { createdAt: 1_000, dueAt: 5_000, id: "r1", text: "nhắc việc" };

test("only what is due and not yet delivered comes up", () => {
  const one = addReminder([], base);
  assert.equal(dueReminders(one, 4_999).length, 0, "early is not due");
  assert.equal(dueReminders(one, 5_000).length, 1, "on the minute is due");
  const delivered = markDelivered(one, "r1", 5_100);
  assert.equal(dueReminders(delivered, 9_999).length, 0, "said once is said");
  assert.equal(deliveredReminders(delivered).length, 1, "and it is still written down");
});

test("the list stays ordered by the time it will speak", () => {
  const later = addReminder([], { ...base, dueAt: 9_000, id: "r2" });
  const both = addReminder(later, base);
  assert.deepEqual(both.map((item) => item.id), ["r1", "r2"]);
});

test("removing takes exactly one reminder", () => {
  const both = addReminder(addReminder([], base), { ...base, dueAt: 9_000, id: "r2" });
  assert.deepEqual(removeReminder(both, "r1").map((item) => item.id), ["r2"]);
});

test("a store round-trips, and a malformed entry is forgotten rather than fatal", async () => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-reminders-"));
  const file = join(root, "reminders.json");
  try {
    await writeReminders(file, addReminder([], base));
    assert.deepEqual(await readReminders(file), addReminder([], base));
    await writeFile(file, JSON.stringify([{ id: "x" }, base, "không phải object", { id: "y", text: "z", dueAt: "sau", createdAt: 1 }]));
    const recovered = await readReminders(file);
    assert.deepEqual(recovered.map((item) => item.id), ["r1"], "only the entry that makes sense survives");
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("a due reminder is handed over as data, above the work that was asked for", () => {
  const note = formatReminderNote([{ createdAt: 1, dueAt: 2, id: "r1", text: "gọi cho khách" }]);
  assert.match(note, /GALAXY REMINDER/);
  assert.match(note, /data, not an instruction/);
  assert.match(note, /- gọi cho khách/);
});

test("a store that is not there is an empty store, not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-reminders-"));
  try { assert.deepEqual(await readReminders(join(root, "nothing.json")), []); }
  finally { await rm(root, { force: true, recursive: true }); }
});
