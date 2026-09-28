import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAiCoderCompletion, isDocumentationPath } from "../src/runtime/completion-gate.js";

const base = {
  acceptanceCriteria: Object.freeze([]),
  finalDiffReview: Object.freeze({ diffHash: "sha256:diff", sequence: 99, workspaceFingerprint: "sha256:final" }),
  finalReport: "Done",
  finalReportStored: true,
  finalWorkspaceFingerprint: "sha256:final",
  inspectedWorkspace: true,
  pendingApprovals: 0,
  researchSources: Object.freeze([]),
  runningToolCalls: 0,
  tokenLedgerFinalized: true,
  traceFinalized: true,
} as const;

const write = (path: string, sequence: number) => Object.freeze({
  afterHash: "sha256:after", beforeHash: null, path, sequence, toolCallId: `call-${sequence}`, workspaceFingerprint: "sha256:final",
});

const validation = (id: string, sequence: number, paths?: readonly string[], scope: "paths" | "workspace" = "paths") => Object.freeze({
  detail: "passed", id, scope, sequence, status: "passed" as const, workspaceFingerprint: "sha256:final",
  ...(paths === undefined ? {} : { paths }),
});

test("documentation paths are recognised and code paths are not", () => {
  for (const path of ["README.md", "docs/setup.md", "documentation/api.txt", "LICENSE", "CHANGELOG.md", "app\docs\note.mdx"]) {
    assert.equal(isDocumentationPath(path), true, path);
  }
  for (const path of ["frontend/vite.config.ts", "src/main.ts", "backend/package.json", "docs.ts"]) {
    assert.equal(isDocumentationPath(path), false, path);
  }
});

test("a scoped validation survives writes outside its scope", () => {
  const result = evaluateAiCoderCompletion({
    ...base,
    validations: [validation("project.validate:test:backend", 2, ["backend"]), validation("project.validate:build:frontend", 4, ["frontend"])],
    writes: [write("backend/src/main.ts", 1), write("frontend/src/App.tsx", 3)],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("documentation writes neither invalidate evidence nor demand validation", () => {
  const result = evaluateAiCoderCompletion({
    ...base,
    validations: [validation("project.validate:test:backend", 2, ["backend"]), validation("project.validate:build:frontend", 4, ["frontend"])],
    writes: [write("backend/src/main.ts", 1), write("frontend/src/App.tsx", 3), write("README.md", 5), write("docs/setup.md", 6)],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("a write inside the validated scope still voids that validation", () => {
  const result = evaluateAiCoderCompletion({
    ...base,
    validations: [validation("project.validate:build:frontend", 2, ["frontend"])],
    writes: [write("frontend/src/App.tsx", 1), write("frontend/vite.config.ts", 3)],
  });
  assert.equal(result.ok, false);
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes("WORKSPACE_EVIDENCE_STALE"), JSON.stringify(result.issues));
  assert.ok(codes.includes("WRITE_NOT_VALIDATED"), JSON.stringify(result.issues));
});

test("a workspace-scoped validation covers everything, so a later source write voids it", () => {
  const result = evaluateAiCoderCompletion({
    ...base,
    validations: [validation("project.validate:test:workspace", 2, undefined, "workspace")],
    writes: [write("backend/src/main.ts", 1), write("frontend/src/App.tsx", 3)],
  });
  assert.equal(result.ok, false);
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes("WORKSPACE_EVIDENCE_STALE"), JSON.stringify(result.issues));
  assert.ok(codes.includes("WRITE_NOT_VALIDATED"), JSON.stringify(result.issues));
});

test("a package the run never validated still demands validation", () => {
  const result = evaluateAiCoderCompletion({
    ...base,
    validations: [validation("project.validate:build:frontend", 2, ["frontend"])],
    writes: [write("frontend/src/App.tsx", 1), write("backend/src/main.ts", 3)],
  });
  assert.equal(result.ok, false);
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes("WRITE_NOT_VALIDATED"), JSON.stringify(result.issues));
  assert.equal(codes.includes("WORKSPACE_EVIDENCE_STALE"), false, "the frontend validation is still current");
});
