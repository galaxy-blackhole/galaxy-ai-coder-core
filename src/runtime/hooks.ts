/**
 * The hooks a workspace already has.
 *
 * Claude Code and Codex both let a project run a command around a tool call, and the format is small enough to read
 * directly: a matcher for which tools, and commands that answer on stdout with an exit code. A project that already
 * wrote hooks should not have to write them again for us, which is the whole reason this file exists.
 *
 * The contract, as the other tools define it: exit 0 lets the call through; exit 2 refuses it, and whatever the
 * command wrote on stderr is the reason the model is given. Any other exit code, a timeout, or a command that cannot
 * start is a NON-BLOCKING error — the call proceeds and the failure is reported, because a hook that never answers
 * must not be able to freeze every tool call in the session.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const HOOK_EVENTS = Object.freeze(["PreToolUse", "PostToolUse"] as const);
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookCommand {
  readonly command: string;
  readonly timeoutSeconds?: number;
}

export interface HookMatcher {
  readonly hooks: readonly HookCommand[];
  readonly matcher?: string;
}

export interface HookConfig {
  readonly PreToolUse?: readonly HookMatcher[];
  readonly PostToolUse?: readonly HookMatcher[];
}

export interface HookDecision {
  readonly deny: boolean;
  readonly reason?: string;
  /** Notes about hooks that failed to answer, for a log that must not pretend they passed. */
  readonly warnings: readonly string[];
}

/** The config files a workspace may keep, in the order they are read. */
export const HOOK_CONFIG_PATHS = Object.freeze([
  Object.freeze([".claude", "settings.json"]),
  Object.freeze([".codex", "hooks.json"]),
]);

/**
 * Reads the hooks a workspace declares. A malformed file is a workspace without hooks, not a broken session.
 */
export async function readHookConfig(workspaceRoot: string): Promise<HookConfig> {
  const merged: Record<HookEvent, HookMatcher[]> = { PostToolUse: [], PreToolUse: [] };
  for (const parts of HOOK_CONFIG_PATHS) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(workspaceRoot, ...parts), "utf8"));
    } catch {
      continue;
    }
    const hooks = (raw as { hooks?: unknown }).hooks;
    if (typeof hooks !== "object" || hooks === null) continue;
    for (const event of HOOK_EVENTS) {
      const entries = (hooks as Record<string, unknown>)[event];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const matcher = typeof (entry as { matcher?: unknown }).matcher === "string"
          ? (entry as { matcher: string }).matcher
          : undefined;
        const commands = Array.isArray((entry as { hooks?: unknown }).hooks)
          ? ((entry as { hooks: unknown[] }).hooks)
          : [];
        const parsed = commands.flatMap((command) => {
          const value = (command as { command?: unknown }).command;
          if (typeof value !== "string" || value.trim().length === 0) return [];
          const timeout = (command as { timeout?: unknown }).timeout;
          return [Object.freeze({
            command: value,
            ...(typeof timeout === "number" && Number.isFinite(timeout) ? { timeoutSeconds: timeout } : {}),
          })];
        });
        if (parsed.length === 0) continue;
        merged[event].push(Object.freeze({ hooks: Object.freeze(parsed), ...(matcher === undefined ? {} : { matcher }) }));
      }
    }
  }
  return Object.freeze({
    ...(merged.PreToolUse.length === 0 ? {} : { PreToolUse: Object.freeze(merged.PreToolUse) }),
    ...(merged.PostToolUse.length === 0 ? {} : { PostToolUse: Object.freeze(merged.PostToolUse) }),
  });
}

/**
 * Whether a matcher covers a tool. An empty or absent matcher covers everything, and the pattern is read as a regular
 * expression the way the other tools document it — `Bash`, `Edit|Write`, `mcp__.*`.
 */
export function matchesHookTool(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined) return true;
  const pattern = matcher.trim();
  if (pattern.length === 0 || pattern === "*") return true;
  try {
    return new RegExp(pattern).test(toolName);
  } catch {
    return pattern === toolName;
  }
}

function runHookCommand(command: HookCommand, toolName: string, payload: unknown): Promise<HookDecision> {
  return new Promise((resolve) => {
    const timeoutMs = Math.max(1, Math.min(60, command.timeoutSeconds ?? 10)) * 1_000;
    const child = execFile(command.command, { shell: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      const code = typeof (error as { code?: unknown } | null)?.code === "number"
        ? (error as { code: number }).code
        : 0;
      if (code === 2) {
        resolve(Object.freeze({
          deny: true,
          reason: String(stderr).trim() || "a workspace hook refused this call",
          warnings: Object.freeze([]),
        }));
        return;
      }
      if (error !== null) {
        resolve(Object.freeze({
          deny: false,
          warnings: Object.freeze(["hook failed for " + toolName + ": " + String(stderr || error.message).trim().slice(0, 200)]),
        }));
        return;
      }
      void stdout;
      resolve(Object.freeze({ deny: false, warnings: Object.freeze([]) }));
    });
    /*
     * A hook is allowed to ignore its input — `exit 0` is a perfectly good hook — and a command that ignores stdin
     * exits without reading it, which closes the pipe under us. Writing then raises EPIPE on a stream nobody is
     * listening to, and an unhandled stream error takes the whole session down with it. The payload is a courtesy,
     * so a hook that does not want it is not an error.
     */
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.end(JSON.stringify(payload));
    } catch {
      /* The pipe was already gone; the exit code is the answer that matters. */
    }
  });
}

/**
 * Runs every matching hook for one event and merges their answers: the first refusal wins, and failures are collected
 * rather than thrown, so a broken hook cannot take the session down with it.
 */
export async function runToolHooks(
  config: HookConfig,
  event: "PreToolUse" | "PostToolUse",
  toolName: string,
  payload: unknown,
): Promise<HookDecision> {
  const matchers = config[event] ?? [];
  const warnings: string[] = [];
  for (const matcher of matchers) {
    if (!matchesHookTool(matcher.matcher, toolName)) continue;
    for (const command of matcher.hooks) {
      const decision = await runHookCommand(command, toolName, payload);
      warnings.push(...decision.warnings);
      if (decision.deny) {
        return Object.freeze({
          deny: true,
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
          warnings: Object.freeze(warnings),
        });
      }
    }
  }
  return Object.freeze({ deny: false, warnings: Object.freeze(warnings) });
}
