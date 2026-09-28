import assert from "node:assert/strict";
import test from "node:test";
import { validationScopeForProjectPath } from "../src/tools/validation-scope.js";

test("a check in a subproject is scoped to that subproject", () => {
  assert.deepEqual(validationScopeForProjectPath("frontend"), { paths: ["frontend"], scope: "paths" });
  assert.deepEqual(validationScopeForProjectPath("apps/api"), { paths: ["apps/api"], scope: "paths" });
  assert.deepEqual(validationScopeForProjectPath("./apps/api/"), { paths: ["apps/api"], scope: "paths" });
  assert.deepEqual(validationScopeForProjectPath("apps\\api"), { paths: ["apps/api"], scope: "paths" });
});

test("a check at the workspace root keeps the strict workspace scope", () => {
  assert.deepEqual(validationScopeForProjectPath("."), { scope: "workspace" });
  assert.deepEqual(validationScopeForProjectPath(""), { scope: "workspace" });
  assert.deepEqual(validationScopeForProjectPath("./"), { scope: "workspace" });
});
