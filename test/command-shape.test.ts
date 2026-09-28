import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeLongRunningServer, serverCommandAdvisory, validationCommandAdvisory } from "../src/tools/command-shape.js";

test("recognises dev servers and watchers", () => {
  for (const command of [
    "bun run dev",
    "npm run start",
    "pnpm serve",
    "yarn watch",
    "cd apps/web && ./node_modules/.bin/vite --port 5199 --strictPort",
    "npx nodemon src/main.ts",
    "bun run build --watch",
  ]) {
    assert.equal(looksLikeLongRunningServer(command), true, command);
  }
});

test("bounded project work is not a server command", () => {
  for (const command of [
    "bun run build",
    "bunx vite build",
    "bun test",
    "node --test test/*.test.js",
    "tsc --noEmit",
    "bunx @galaxy-stack/orbit-cli new gymflow-api --directory apps/api",
    "rm -f frontend/src/assets/vite.svg frontend/src/App.css",
    "ls frontend/src/assets/vite.svg",
    "bun create vite@latest frontend --template react-ts",
    "bun create vite gymflow-frontend --template react-ts",
    "npm create vite@latest web -- --template react-ts",
    "bun create vite@latest .tmp-restore --template react-ts && cp .tmp-restore/src/App.css frontend/src/App.css",
  ]) {
    assert.equal(looksLikeLongRunningServer(command), false, command);
  }
});

test("advises validate_project for whole-project checks but not for targeted runs", () => {
  for (const command of ["cd backend && bun test", "npm run build", "cd backend && ./node_modules/.bin/tsc --noEmit", "eslint .", "vitest run"]) {
    assert.match(validationCommandAdvisory(command) ?? "", /validate_project/, command);
  }
  for (const command of ["bun test src/members/members.e2e.test.ts", "bunx @galaxy-stack/orbit-cli new app", "bun run dev", "ls apps/web/dist"]) {
    assert.equal(validationCommandAdvisory(command), undefined, command);
  }
});

test("the advisory names the bounded validation path", () => {
  const advisory = serverCommandAdvisory("bun run dev");
  assert.ok(advisory !== undefined);
  assert.match(advisory, /validate_project/);
  assert.match(advisory, /not validation evidence/);
  assert.equal(serverCommandAdvisory("bun run build"), undefined);
});
