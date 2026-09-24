#!/usr/bin/env node

import { executeCliCommand } from "./application.js";
import { parseCliCommand } from "./domain/cli-options.js";
import { processOutputWriter } from "./io/output.js";

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Canceled by operating-system signal."));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const command = parseCliCommand(args, { cwd: process.cwd() });
    return await executeCliCommand(command, {
      cwd: process.cwd(),
      output: processOutputWriter,
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    processOutputWriter.writeError(`blackhole: ${message}`);
    return 2;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  process.exitCode = await main();
}
