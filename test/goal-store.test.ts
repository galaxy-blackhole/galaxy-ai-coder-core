import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalStore } from "../src/runtime/goal-store.js";

test("a goal is created active, with a revision of one", () => {
  const store = new GoalStore();
  const goal = store.create("Ship the desktop build");
  assert.equal(goal.phase, "active");
  assert.equal(goal.revision, 1);
  assert.equal(store.get(goal.id)?.objective, "Ship the desktop build");
  assert.equal(store.current()?.id, goal.id);
});

test("a stale revision changes nothing and is told so", () => {
  const store = new GoalStore();
  const goal = store.create("First objective");
  const paused = store.update(goal.id, goal.revision, "pause");
  assert.equal(paused.ok, true);
  const stale = store.update(goal.id, goal.revision, "complete");
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && "conflict" in stale ? stale.conflict.phase : null, "paused");
  assert.equal(store.get(goal.id)?.phase, "paused");
});

test("resuming counts a round, and a blocked goal carries its reason", () => {
  const store = new GoalStore();
  const goal = store.create("Keep going");
  const blocked = store.update(goal.id, 1, "blocked", { blockedReason: "no credentials" });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.ok ? blocked.goal.blockedReason : null, "no credentials");
  const resumed = store.update(goal.id, blocked.ok ? blocked.goal.revision : 2, "resume");
  assert.equal(resumed.ok, true);
  assert.equal(resumed.ok ? resumed.goal.roundsStarted : -1, 1);
  assert.equal(resumed.ok ? resumed.goal.blockedReason : null, null);
});

test("the journal is the whole truth, in order", () => {
  const store = new GoalStore();
  const goal = store.create("Trace it");
  store.update(goal.id, 1, "edit", { objective: "Trace it fully" });
  const events = store.events();
  assert.deepEqual(events.map((event) => event.type), ["created", "edited"]);
  assert.equal(store.get(goal.id)?.revision, 2);
});

test("an unknown goal reads as missing", () => {
  const store = new GoalStore();
  const result = store.update("goal-99", 1, "pause");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && "missing" in result, true);
  assert.equal(store.get("goal-99"), null);
});
