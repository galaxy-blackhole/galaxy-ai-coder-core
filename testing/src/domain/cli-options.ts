export type OutputFormat = "text" | "json";

export type CliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "doctor"; readonly format: OutputFormat }
  | { readonly kind: "tools"; readonly format: OutputFormat }
  | { readonly kind: "prompt"; readonly task: string; readonly format: OutputFormat }
  | {
      readonly kind: "run";
      readonly task?: string;
      readonly fixturePath: string;
      readonly workspacePath?: string;
      readonly format: OutputFormat;
    }
  | {
      readonly kind: "eval";
      readonly fixturePath: string;
      readonly workspacePath?: string;
      readonly format: OutputFormat;
    }
  | {
      readonly kind: "campaign";
      readonly fixturePath: string;
      readonly workspacePath?: string;
      readonly format: OutputFormat;
    }
  | {
      readonly kind: "health";
      readonly baseUrl?: string;
      readonly configPath?: string;
      readonly format: OutputFormat;
      readonly live: true;
      readonly model?: string;
      readonly pauseAfterToolCalls?: number;
      readonly recordPath?: string;
      readonly resume: boolean;
      readonly runId?: string;
      readonly scenarioPath: string;
      readonly storeDir?: string;
      readonly workspacePath?: string;
    };

export interface ParseCliOptions {
  readonly cwd: string;
}

function valueAfter(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function parseFlags(args: readonly string[]): {
  readonly positional: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
} {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const valueFlags = new Set(["--base-url", "--config", "--fixture", "--model", "--pause-after-tool-calls", "--record", "--run-id", "--scenario", "--store-dir", "--workspace"]);
  const booleanFlags = new Set(["--json", "--live", "--resume"]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (valueFlags.has(argument)) {
      if (values.has(argument)) throw new Error(`Duplicate option: ${argument}.`);
      values.set(argument, valueAfter(args, index, argument));
      index += 1;
    } else if (booleanFlags.has(argument)) {
      if (booleans.has(argument)) throw new Error(`Duplicate option: ${argument}.`);
      booleans.add(argument);
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}.`);
    } else {
      positional.push(argument);
    }
  }
  return { positional, values, booleans };
}

export function parseCliCommand(args: readonly string[], options: ParseCliOptions): CliCommand {
  const [command = "help", ...rest] = args;
  if (command === "help" || command === "--help" || command === "-h") return { kind: "help" };
  if (command === "version" || command === "--version" || command === "-v") return { kind: "version" };

  const parsed = parseFlags(rest);
  const format: OutputFormat = parsed.booleans.has("--json") ? "json" : "text";
  const rejectLive = (): void => {
    if (parsed.booleans.has("--live")) throw new Error(`The ${command} command does not accept --live.`);
  };
  if (command === "doctor" || command === "tools") {
    rejectLive();
    if (parsed.positional.length > 0 || parsed.values.size > 0) {
      throw new Error(`The ${command} command accepts only --json.`);
    }
    return { kind: command, format };
  }
  if (command === "prompt") {
    rejectLive();
    if (parsed.values.size > 0) throw new Error("The prompt command accepts a task and optional --json only.");
    const task = parsed.positional.join(" ").trim();
    if (task.length === 0) throw new Error("The prompt command requires a task.");
    return { kind: "prompt", task, format };
  }
  if (command === "run") {
    rejectLive();
    for (const flag of parsed.values.keys()) {
      if (flag !== "--fixture" && flag !== "--workspace") throw new Error(`The run command does not accept ${flag}.`);
    }
    const fixturePath = parsed.values.get("--fixture");
    if (fixturePath === undefined) throw new Error("The run command requires --fixture <path>.");
    const task = parsed.positional.join(" ").trim();
    return {
      kind: "run",
      ...(task.length === 0 ? {} : { task }),
      fixturePath,
      ...(parsed.values.get("--workspace") === undefined
        ? {}
        : { workspacePath: parsed.values.get("--workspace")! }),
      format,
    };
  }
  if (command === "eval" || command === "campaign") {
    rejectLive();
    for (const flag of parsed.values.keys()) {
      if (flag !== "--fixture" && flag !== "--workspace") throw new Error(`The ${command} command does not accept ${flag}.`);
    }
    if (parsed.positional.length > 0) throw new Error(`The ${command} command does not accept a positional task.`);
    const fixturePath = parsed.values.get("--fixture");
    if (fixturePath === undefined) throw new Error(`The ${command} command requires --fixture <file-or-directory>.`);
    const workspacePath = parsed.values.get("--workspace");
    return {
      kind: command,
      fixturePath,
      ...(workspacePath === undefined ? {} : { workspacePath }),
      format,
    };
  }
  if (command === "health") {
    if (parsed.positional.length > 0) throw new Error("The health command does not accept a positional task.");
    if (!parsed.booleans.has("--live")) {
      throw new Error("The health command requires --live to explicitly allow a real provider request.");
    }
    const scenarioPath = parsed.values.get("--scenario");
    if (scenarioPath === undefined) throw new Error("The health command requires --scenario <file-or-directory>.");
    if (parsed.values.has("--fixture")) throw new Error("The health command does not accept --fixture.");
    const baseUrl = parsed.values.get("--base-url");
    const configPath = parsed.values.get("--config");
    const model = parsed.values.get("--model");
    const pauseAfterToolCallsText = parsed.values.get("--pause-after-tool-calls");
    const recordPath = parsed.values.get("--record");
    const pauseAfterToolCalls = pauseAfterToolCallsText === undefined
      ? undefined
      : Number(pauseAfterToolCallsText);
    const runId = parsed.values.get("--run-id");
    const storeDir = parsed.values.get("--store-dir");
    const workspacePath = parsed.values.get("--workspace");
    const resume = parsed.booleans.has("--resume");
    if (pauseAfterToolCalls !== undefined && (!Number.isSafeInteger(pauseAfterToolCalls) || pauseAfterToolCalls < 1 || pauseAfterToolCalls > 10_000)) {
      throw new Error("The health --pause-after-tool-calls value must be an integer from 1 to 10000.");
    }
    if (resume && pauseAfterToolCalls !== undefined) {
      throw new Error("The health --resume command does not accept --pause-after-tool-calls.");
    }
    if (resume && recordPath !== undefined) {
      throw new Error("The health --record command records a fresh run and does not accept --resume.");
    }
    if (resume && (runId === undefined || storeDir === undefined || workspacePath === undefined)) {
      throw new Error("The health --resume command requires --run-id, --store-dir, and --workspace.");
    }
    if (runId !== undefined && storeDir === undefined) {
      throw new Error("The health --run-id option requires --store-dir.");
    }
    if (storeDir !== undefined && workspacePath === undefined) {
      throw new Error("The health --store-dir option requires a persistent --workspace.");
    }
    return {
      kind: "health",
      live: true,
      resume,
      scenarioPath,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(configPath === undefined ? {} : { configPath }),
      ...(model === undefined ? {} : { model }),
      ...(pauseAfterToolCalls === undefined ? {} : { pauseAfterToolCalls }),
      ...(recordPath === undefined ? {} : { recordPath }),
      ...(runId === undefined ? {} : { runId }),
      ...(storeDir === undefined ? {} : { storeDir }),
      ...(workspacePath === undefined ? {} : { workspacePath }),
      format,
    };
  }
  throw new Error(`Unknown command: ${command}.`);
}
