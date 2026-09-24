import type { AiCoderHostEnvironment } from "../../../index.js";

/**
 * Resolve the exact interpreter contract used by NodeCommandPort.
 *
 * This is deliberately independent of the user's login shell. The same frozen
 * value is exposed to the model and used to build the child-process argv.
 */
export function nodeCommandHostEnvironment(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): AiCoderHostEnvironment {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw Object.assign(new Error(`run_command is not supported on platform '${platform}'.`), {
      code: "UNAVAILABLE",
    });
  }
  const windows = platform === "win32";
  return Object.freeze({
    architecture: architecture.trim() || "unknown",
    command: Object.freeze({
      argumentsPrefix: Object.freeze(windows ? ["/d", "/s", "/v:off", "/c"] : ["-c"]),
      commandMode: "shell_string",
      executable: windows ? "cmd.exe" : "/bin/sh",
      interactive: false,
      pathStyle: windows ? "windows" : "posix",
      shell: windows ? "cmd" : "sh",
      stdin: "closed",
      tty: false,
    }),
    operatingSystem: platform,
  });
}
