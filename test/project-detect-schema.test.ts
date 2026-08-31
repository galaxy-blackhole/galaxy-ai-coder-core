import assert from "node:assert/strict";
import test from "node:test";

import { validateAiCoderJsonSchema } from "../src/tools/json-schema.js";
import { AI_CODER_CORE_TOOL_CATALOG } from "../src/tools/tool-registry.js";

test("project.detect schema requires explicit scan coverage and warnings", () => {
  const descriptor = AI_CODER_CORE_TOOL_CATALOG.find((tool) => tool.id === "project.detect");
  assert.ok(descriptor);
  const valid = validateAiCoderJsonSchema(descriptor.outputSchema, {
    projectRoot: ".",
    languages: ["TypeScript"],
    packageManager: "npm",
    manifests: ["package.json"],
    commands: { test: "node --test" },
    scan: {
      complete: false,
      entriesScanned: 20_000,
      deepestDepth: 20,
      maxDepth: 20,
    },
    warnings: ["The scan was bounded."],
  });
  assert.equal(valid.valid, true, valid.errors.join("\n"));

  const missingCoverage = validateAiCoderJsonSchema(descriptor.outputSchema, {
    projectRoot: ".",
    languages: [],
    manifests: [],
    commands: {},
  });
  assert.equal(missingCoverage.valid, false);
  assert.ok(missingCoverage.errors.some((issue) => issue.includes("scan")));
  assert.ok(missingCoverage.errors.some((issue) => issue.includes("warnings")));
});
