import { run } from "node:test";
import { inspect } from "node:util";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const name = args[0] === "--name" ? args.splice(0, 2)[1] : undefined;
if (args.length === 0) throw new Error("At least one test file is required.");
const controller = new AbortController();
const cancel = () => controller.abort(new Error("Audit interrupted."));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
let firstFailure = null;
let passed = 0;
let skipped = 0;
let failed = 0;
let declared = 0;
let lastPassed = null;
const stream = run({
  files: args,
  concurrency: 1,
  signal: controller.signal,
  ...(name === undefined ? {} : { testNamePatterns: name }),
  setup(events) {
    events.on("test:fail", (data) => {
      if (data.todo || firstFailure !== null) return;
      firstFailure = {
        name: data.name,
        file: data.file,
        line: data.line,
        error: inspect(data.details.error, { depth: 6, colors: false }),
        timestamp: new Date().toISOString(),
      };
      // Abort as soon as Node reports a failure, including queued file workers.
      controller.abort(new Error(`First failed test: ${data.name}`));
    });
  },
});
for await (const event of stream) {
  const { type, data } = event;
  if (type === 'test:enqueue') declared++;
  if (type === "test:stdout") process.stdout.write(data.message);
  else if (type === "test:stderr") process.stderr.write(data.message);
  else if (type === "test:pass" || type === "test:fail") {
    if (data.skip || data.todo) skipped++;
    else if (type === "test:pass" && data.details.type !== "suite"
      // Node emits a synthetic successful file test if a name filter matched nothing.
      && !(data.file && resolve(data.name) === resolve(data.file) && data.line === 1 && data.column === 1)) {
      passed++;
      lastPassed = { name: data.name, file: data.file, line: data.line };
    } else if (type === 'test:fail' && data.details.type !== 'suite') failed++;
    process.stdout.write(`${JSON.stringify({ event: type, timestamp: new Date().toISOString(), name: data.name, file: data.file, line: data.line, skip: data.skip, todo: data.todo })}\n`);
  }
}
process.off("SIGINT", cancel);
process.off("SIGTERM", cancel);
if (passed === 0 && firstFailure === null) {
  firstFailure = { name: "No matching tests executed", error: name ?? "No runnable tests" };
}
process.stdout.write(`${JSON.stringify({ event: "audit:test-summary", timestamp: new Date().toISOString(), passed, failed, skipped, declared, total: controller.signal.aborted ? null : passed + failed + skipped, lastPassed, firstFailure })}\n`);
if (firstFailure !== null) process.stderr.write(`${JSON.stringify(firstFailure, null, 2)}\n`);
process.exitCode = firstFailure !== null || controller.signal.aborted ? 1 : 0;
