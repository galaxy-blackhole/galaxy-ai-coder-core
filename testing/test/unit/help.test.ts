import assert from "node:assert/strict";
import test from "node:test";

import { GALAXY_CODE_VERSION, HELP_TEXT } from "../../src/ui/help.js";

test("help separates deterministic commands from explicit live health", () => {
  assert.match(HELP_TEXT, /--fixture/);
  assert.match(HELP_TEXT, /health --live --scenario/);
  assert.match(HELP_TEXT, /--store-dir <dir>/);
  assert.match(HELP_TEXT, /--run-id <id>/);
  assert.match(HELP_TEXT, /--resume/);
  assert.match(HELP_TEXT, /--pause-after-tool-calls <count>/);
  assert.match(HELP_TEXT, /explicit opt-in live path/);
  assert.match(HELP_TEXT, /never prints its API key/);
  assert.equal(GALAXY_CODE_VERSION, "2.0.0-alpha.8");
});
