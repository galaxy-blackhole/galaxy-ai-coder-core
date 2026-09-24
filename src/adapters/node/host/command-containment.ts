import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, link, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, relative, sep } from "node:path";

export type CommandContainmentMode = "best_effort" | "required";

export type CommandContainmentBackend =
  | "linux_bubblewrap"
  | "macos_sandbox_exec"
  | "none";

export interface CommandContainmentProbeResult {
  readonly available: boolean;
  readonly backend: CommandContainmentBackend;
  readonly descendantChildSpawned: boolean;
  readonly descendantQuiescent: boolean;
  readonly executable: string | null;
  readonly hardLinkWriteDenied: boolean;
  readonly networkDenied: boolean;
  readonly outsideWriteDenied: boolean;
  readonly privateTempWrite: boolean;
  readonly reason: string | null;
  readonly systemRead: boolean;
  readonly toolchainExecution: boolean;
  readonly verified: boolean;
  readonly workspaceWrite: boolean;
}

export interface CommandContainmentStatus {
  readonly active: boolean;
  readonly backend: CommandContainmentBackend;
  readonly executable: string | null;
  readonly filesystemReads: "host_visible" | "system_and_workspace";
  readonly filesystemWrites: "uncontained" | "workspace_and_private_temp";
  readonly mode: CommandContainmentMode;
  readonly network: "denied" | "uncontained";
  readonly reason: string | null;
  readonly state: "active" | "probe_failed" | "unavailable" | "unverified";
  readonly verified: boolean;
}

const MACOS_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";

/*
 * Prototype profile used only by the conformance probe. It is intentionally
 * not selected for real NodeCommandPort runs: the probe currently demonstrates
 * that pathname-based Seatbelt write rules do not protect outside inodes
 * reachable through workspace hard links, and do not supervise descendants
 * that create a new process group.
 *
 * The profile is a write/network experiment, not a confidentiality boundary.
 * Broad reads keep the installed Node/toolchain visible. There are no TTY,
 * pseudo-terminal, or network allowances.
 */
const MACOS_CONFORMANCE_PROFILE = `(version 1)
(deny default)
(allow file-read*)
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow file-write*
  (subpath (param "WORKSPACE"))
  (subpath (param "PRIVATE_TMP"))
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/null"))
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent"))`;

const PROBE_TIMEOUT_MS = 5_000;
const DESCENDANT_OBSERVATION_MS = 700;

const MACOS_PROBE_SCRIPT = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const result = {
  descendantChildSpawned: false,
  hardLinkWriteDenied: false,
  networkDenied: false,
  outsideWriteDenied: false,
  privateTempWrite: false,
  systemRead: false,
  workspaceWrite: false,
};
try {
  fs.readFileSync("/etc/hosts");
  result.systemRead = true;
  fs.writeFileSync(process.env.GALAXY_PROBE_WORKSPACE_FILE, "workspace-ok", "utf8");
  result.workspaceWrite = true;
  fs.writeFileSync(process.env.GALAXY_PROBE_TEMP_FILE, "temp-ok", "utf8");
  result.privateTempWrite = true;
  try {
    fs.writeFileSync(process.env.GALAXY_PROBE_OUTSIDE_FILE, "changed", "utf8");
  } catch (error) {
    result.outsideWriteDenied = Boolean(error);
  }
  try {
    fs.writeFileSync(process.env.GALAXY_PROBE_HARD_LINK_FILE, "changed-through-link", "utf8");
  } catch (error) {
    result.hardLinkWriteDenied = error && (error.code === "EACCES" || error.code === "EPERM");
  }
  const lateScript = 'setTimeout(() => require("node:fs").writeFileSync(process.env.GALAXY_PROBE_LATE_FILE, "late", "utf8"), 250)';
  const child = spawn(process.execPath, ["-e", lateScript], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  result.descendantChildSpawned = child.pid !== undefined;
  child.unref();
} catch {}
let finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify(result));
};
const socket = net.createConnection({
  host: "127.0.0.1",
  port: Number(process.env.GALAXY_PROBE_PORT),
});
socket.once("connect", () => {
  socket.destroy();
  finish();
});
socket.once("error", (error) => {
  result.networkDenied = Boolean(error);
  finish();
});
socket.setTimeout(2_000, () => {
  result.networkDenied = true;
  socket.destroy();
  finish();
});
`;

type ProbeProcessResult = Readonly<{
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}>;

type MacOsProbePayload = Readonly<{
  descendantChildSpawned: boolean;
  hardLinkWriteDenied: boolean;
  networkDenied: boolean;
  outsideWriteDenied: boolean;
  privateTempWrite: boolean;
  systemRead: boolean;
  workspaceWrite: boolean;
}>;

let cachedProbe: Promise<CommandContainmentProbeResult> | undefined;

function freezeProbe(result: CommandContainmentProbeResult): CommandContainmentProbeResult {
  return Object.freeze({ ...result });
}

function unavailableProbe(
  backend: CommandContainmentBackend,
  executable: string | null,
  available: boolean,
  reason: string,
): CommandContainmentProbeResult {
  return freezeProbe({
    available,
    backend,
    descendantChildSpawned: false,
    descendantQuiescent: false,
    executable,
    hardLinkWriteDenied: false,
    networkDenied: false,
    outsideWriteDenied: false,
    privateTempWrite: false,
    reason,
    systemRead: false,
    toolchainExecution: false,
    verified: false,
    workspaceWrite: false,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function executableOnPath(name: string): Promise<string | null> {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry.length === 0) continue;
    const candidate = join(entry, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function killProbeProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Nothing remains to terminate.
    }
  }
}

async function runProbeProcess(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<ProbeProcessResult> {
  return await new Promise<ProbeProcessResult>((resolveResult) => {
    const child = spawn(executable, args, {
      detached: true,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let didTimeOut = false;
    let forceFinish: NodeJS.Timeout | undefined;
    let settled = false;
    let stderr = "";
    let stdout = "";
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceFinish !== undefined) clearTimeout(forceFinish);
      resolveResult(Object.freeze({ exitCode, stderr, stdout, timedOut: didTimeOut }));
    };
    const timeout = setTimeout(() => {
      didTimeOut = true;
      killProbeProcessGroup(child.pid);
      forceFinish = setTimeout(() => finish(null), 1_000);
      forceFinish.unref();
    }, PROBE_TIMEOUT_MS);
    timeout.unref();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 64_000) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk;
    });
    child.once("error", (error) => {
      stderr += errorMessage(error);
      finish(null);
    });
    child.once("close", (exitCode) => finish(exitCode));
  });
}

async function listenOnLoopback(server: Server): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The containment probe did not receive a TCP port."));
        return;
      }
      resolvePort(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function probeMacOsSeatbelt(): Promise<CommandContainmentProbeResult> {
  if (!(await isExecutable(MACOS_SANDBOX_EXECUTABLE))) {
    return unavailableProbe(
      "macos_sandbox_exec",
      MACOS_SANDBOX_EXECUTABLE,
      false,
      `${MACOS_SANDBOX_EXECUTABLE} is not executable.`,
    );
  }

  const temporaryRoots: string[] = [];
  const server = createServer((socket) => socket.destroy());
  let networkConnections = 0;
  server.on("connection", () => {
    networkConnections += 1;
  });

  try {
    const makeTemporaryRoot = async (prefix: string): Promise<string> => {
      const root = await mkdtemp(join(tmpdir(), prefix));
      temporaryRoots.push(root);
      return await realpath(root);
    };
    // Allocate sequentially so a rejection cannot race successful siblings
    // that have not yet registered themselves for the finally cleanup.
    const workspace = await makeTemporaryRoot("galaxy-containment-workspace-");
    const privateTemp = await makeTemporaryRoot("galaxy-containment-temp-");
    const outside = await makeTemporaryRoot("galaxy-containment-outside-");
    const workspaceFile = join(workspace, `workspace-${randomUUID()}`);
    const privateTempFile = join(privateTemp, `temp-${randomUUID()}`);
    const outsideFile = join(outside, `sentinel-${randomUUID()}`);
    const outsideHardLinkTarget = join(outside, `hard-link-target-${randomUUID()}`);
    const workspaceHardLink = join(workspace, `hard-link-${randomUUID()}`);
    const lateFile = join(workspace, `late-${randomUUID()}`);
    const sentinel = `outside-${randomUUID()}`;
    const hardLinkSentinel = `hard-link-outside-${randomUUID()}`;
    await Promise.all([
      writeFile(outsideFile, sentinel, "utf8"),
      writeFile(outsideHardLinkTarget, hardLinkSentinel, "utf8"),
    ]);
    await link(outsideHardLinkTarget, workspaceHardLink);
    const port = await listenOnLoopback(server);
    const environment: NodeJS.ProcessEnv = {
      CI: "1",
      FORCE_COLOR: "0",
      GALAXY_PROBE_HARD_LINK_FILE: workspaceHardLink,
      GALAXY_PROBE_LATE_FILE: lateFile,
      GALAXY_PROBE_OUTSIDE_FILE: outsideFile,
      GALAXY_PROBE_PORT: String(port),
      GALAXY_PROBE_TEMP_FILE: privateTempFile,
      GALAXY_PROBE_WORKSPACE_FILE: workspaceFile,
      PATH: process.env.PATH,
      TEMP: privateTemp,
      TMP: privateTemp,
      TMPDIR: privateTemp,
    };
    const processResult = await runProbeProcess(MACOS_SANDBOX_EXECUTABLE, [
      "-D",
      `WORKSPACE=${workspace}`,
      "-D",
      `PRIVATE_TMP=${privateTemp}`,
      "-p",
      MACOS_CONFORMANCE_PROFILE,
      process.execPath,
      "-e",
      MACOS_PROBE_SCRIPT,
    ], environment);
    await delay(DESCENDANT_OBSERVATION_MS);

    let payload: MacOsProbePayload | undefined;
    try {
      payload = JSON.parse(processResult.stdout) as MacOsProbePayload;
    } catch {
      payload = undefined;
    }
    const [workspaceContent, privateTempContent, outsideContent, hardLinkContent, lateContent] = await Promise.all([
      readFile(workspaceFile, "utf8").catch(() => ""),
      readFile(privateTempFile, "utf8").catch(() => ""),
      readFile(outsideFile, "utf8").catch(() => ""),
      readFile(outsideHardLinkTarget, "utf8").catch(() => ""),
      readFile(lateFile, "utf8").catch(() => ""),
    ]);
    const systemRead = payload?.systemRead === true;
    const workspaceWrite = payload?.workspaceWrite === true && workspaceContent === "workspace-ok";
    const privateTempWrite = payload?.privateTempWrite === true && privateTempContent === "temp-ok";
    const outsideWriteDenied = payload?.outsideWriteDenied === true && outsideContent === sentinel;
    const hardLinkWriteDenied = payload?.hardLinkWriteDenied === true && hardLinkContent === hardLinkSentinel;
    const networkDenied = payload?.networkDenied === true && networkConnections === 0;
    const descendantChildSpawned = payload?.descendantChildSpawned === true;
    const descendantQuiescent = descendantChildSpawned && lateContent.length === 0;
    const toolchainExecution = processResult.exitCode === 0 && !processResult.timedOut;
    const assertions = {
      descendantChildSpawned,
      descendantQuiescent,
      hardLinkWriteDenied,
      networkDenied,
      outsideWriteDenied,
      privateTempWrite,
      systemRead,
      toolchainExecution,
      workspaceWrite,
    } as const;
    const failedAssertions = Object.entries(assertions)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    const verified = failedAssertions.length === 0;
    const detail = processResult.timedOut
      ? "The Seatbelt conformance probe timed out."
      : processResult.exitCode !== 0
        ? `The Seatbelt conformance probe exited with ${String(processResult.exitCode)}: ${processResult.stderr.trim()}`
        : !verified
          ? `The Seatbelt conformance probe failed: ${failedAssertions.join(", ")}.`
          : null;
    return freezeProbe({
      available: true,
      backend: "macos_sandbox_exec",
      descendantChildSpawned,
      descendantQuiescent,
      executable: MACOS_SANDBOX_EXECUTABLE,
      hardLinkWriteDenied,
      networkDenied,
      outsideWriteDenied,
      privateTempWrite,
      reason: detail,
      systemRead,
      toolchainExecution,
      verified,
      workspaceWrite,
    });
  } catch (error) {
    return unavailableProbe(
      "macos_sandbox_exec",
      MACOS_SANDBOX_EXECUTABLE,
      true,
      `The Seatbelt conformance probe failed: ${errorMessage(error)}`,
    );
  } finally {
    await closeServer(server).catch(() => undefined);
    await Promise.all(temporaryRoots.map(async (root) => {
      await rm(root, { force: true, recursive: true });
    })).catch(() => undefined);
  }
}

async function probeLinuxBubblewrap(): Promise<CommandContainmentProbeResult> {
  const executable = await executableOnPath("bwrap");
  if (executable === null) {
    return unavailableProbe(
      "linux_bubblewrap",
      null,
      false,
      "bubblewrap (bwrap) is not available on PATH.",
    );
  }
  const temporaryRoots: string[] = [];
  const server = createServer((socket) => socket.destroy());
  let networkConnections = 0;
  server.on("connection", () => {
    networkConnections += 1;
  });
  try {
    const makeTemporaryRoot = async (prefix: string): Promise<string> => {
      const root = await mkdtemp(join(tmpdir(), prefix));
      temporaryRoots.push(root);
      return await realpath(root);
    };
    const workspace = await makeTemporaryRoot("galaxy-bwrap-workspace-");
    const outside = await makeTemporaryRoot("galaxy-bwrap-outside-");
    const workspaceFile = join(workspace, `workspace-${randomUUID()}`);
    const outsideFile = join(outside, `sentinel-${randomUUID()}`);
    const lateFile = join(workspace, `late-${randomUUID()}`);
    const hardLinkTarget = join(outside, `hard-link-target-${randomUUID()}`);
    const hardLinkPath = join(workspace, `hard-link-${randomUUID()}`);
    const sentinel = `outside-${randomUUID()}`;
    await Promise.all([
      writeFile(outsideFile, sentinel, "utf8"),
      writeFile(hardLinkTarget, sentinel, "utf8"),
    ]);
    await link(hardLinkTarget, hardLinkPath);
    let hardLinkWriteDenied = false;
    try {
      await assertWorkspaceHasNoHardLinks(workspace);
    } catch {
      hardLinkWriteDenied = true;
    }
    await rm(hardLinkPath);
    const port = await listenOnLoopback(server);
    const environment: NodeJS.ProcessEnv = {
      CI: "1",
      FORCE_COLOR: "0",
      GALAXY_PROBE_HARD_LINK_FILE: "/workspace/nonexistent-hard-link",
      GALAXY_PROBE_LATE_FILE: `/workspace/${lateFile.split(sep).at(-1) ?? "late"}`,
      GALAXY_PROBE_OUTSIDE_FILE: outsideFile,
      GALAXY_PROBE_PORT: String(port),
      GALAXY_PROBE_TEMP_FILE: "/tmp/probe-temp",
      GALAXY_PROBE_WORKSPACE_FILE: `/workspace/${workspaceFile.split(sep).at(-1) ?? "workspace"}`,
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TEMP: "/tmp",
      TMP: "/tmp",
      TMPDIR: "/tmp",
    };
    const processResult = await runProbeProcess(executable, buildBubblewrapArguments({
      command: process.execPath,
      commandArguments: Object.freeze(["-e", MACOS_PROBE_SCRIPT]),
      cwd: workspace,
      environment,
      workspace,
    }), environment);
    await delay(DESCENDANT_OBSERVATION_MS);
    let payload: MacOsProbePayload | undefined;
    try {
      payload = JSON.parse(processResult.stdout) as MacOsProbePayload;
    } catch {
      payload = undefined;
    }
    const [workspaceContent, outsideContent, lateContent] = await Promise.all([
      readFile(workspaceFile, "utf8").catch(() => ""),
      readFile(outsideFile, "utf8").catch(() => ""),
      readFile(lateFile, "utf8").catch(() => ""),
    ]);
    const assertions = {
      descendantChildSpawned: payload?.descendantChildSpawned === true,
      descendantQuiescent: payload?.descendantChildSpawned === true && lateContent.length === 0,
      hardLinkWriteDenied,
      networkDenied: payload?.networkDenied === true && networkConnections === 0,
      outsideWriteDenied: payload?.outsideWriteDenied === true && outsideContent === sentinel,
      privateTempWrite: payload?.privateTempWrite === true,
      systemRead: payload?.systemRead === true,
      toolchainExecution: processResult.exitCode === 0 && !processResult.timedOut,
      workspaceWrite: payload?.workspaceWrite === true && workspaceContent === "workspace-ok",
    } as const;
    const failed = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
    return freezeProbe({
      available: true,
      backend: "linux_bubblewrap",
      ...assertions,
      executable,
      reason: failed.length === 0 ? null : `The bubblewrap conformance probe failed: ${failed.join(", ")}.`,
      verified: failed.length === 0,
    });
  } catch (error) {
    return unavailableProbe(
      "linux_bubblewrap",
      executable,
      true,
      `The bubblewrap conformance probe failed: ${errorMessage(error)}`,
    );
  } finally {
    await closeServer(server).catch(() => undefined);
    await Promise.all(temporaryRoots.map(async (root) => rm(root, { force: true, recursive: true }))).catch(() => undefined);
  }
}

async function detectCommandContainment(): Promise<CommandContainmentProbeResult> {
  try {
    return process.platform === "darwin"
      ? await probeMacOsSeatbelt()
      : process.platform === "linux"
        ? await probeLinuxBubblewrap()
        : unavailableProbe(
          "none",
          null,
          false,
          `No command-containment backend is implemented for '${process.platform}'.`,
        );
  } catch (error) {
    return unavailableProbe(
      "none",
      null,
      false,
      `Command-containment detection failed closed: ${errorMessage(error)}`,
    );
  }
}

/**
 * Run the host conformance check once per process. A binary merely existing is
 * not enough. Only a backend that passes every probe assertion can activate.
 */
export async function probeCommandContainment(): Promise<CommandContainmentProbeResult> {
  cachedProbe ??= detectCommandContainment();
  return await cachedProbe;
}

export function containmentStatus(
  mode: CommandContainmentMode,
  probe: CommandContainmentProbeResult,
): CommandContainmentStatus {
  const assertionsVerified = probe.descendantChildSpawned
    && probe.descendantQuiescent
    && probe.hardLinkWriteDenied
    && probe.networkDenied
    && probe.outsideWriteDenied
    && probe.privateTempWrite
    && probe.systemRead
    && probe.toolchainExecution
    && probe.workspaceWrite;
  const active = probe.backend === "linux_bubblewrap" && probe.verified && assertionsVerified;
  const state = !probe.available
    ? "unavailable" as const
    : active
      ? "active" as const
      : probe.verified
      ? "unverified" as const
      : "probe_failed" as const;
  const reason = active ? null : probe.verified && !assertionsVerified
    ? "The backend claimed verification without passing every containment assertion."
    : probe.verified
      ? "The backend passed its probe but this platform implementation is not activated."
    : probe.reason;
  return Object.freeze({
    active,
    backend: probe.backend,
    executable: probe.executable,
    filesystemReads: active ? "system_and_workspace" : "host_visible",
    filesystemWrites: active ? "workspace_and_private_temp" : "uncontained",
    mode,
    network: active ? "denied" : "uncontained",
    reason,
    state,
    verified: active,
  });
}

const BUBBLEWRAP_READ_ONLY_ROOTS = Object.freeze([
  "/bin", "/etc", "/lib", "/lib64", "/nix/store", "/opt", "/sbin", "/usr",
]);

export function buildBubblewrapArguments(input: Readonly<{
  command: string;
  commandArguments: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  workspace: string;
}>): readonly string[] {
  const relativeCwd = relative(input.workspace, input.cwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)) {
    throw new Error("Contained command cwd must remain inside the workspace.");
  }
  const args: string[] = [
    "--die-with-parent", "--new-session", "--unshare-all", "--disable-userns", "--cap-drop", "ALL",
    "--clearenv", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
  ];
  for (const root of BUBBLEWRAP_READ_ONLY_ROOTS) {
    try {
      if (existsSync(root)) args.push("--ro-bind", root, root);
    } catch {
      // Missing optional system roots are intentionally invisible.
    }
  }
  args.push("--bind", input.workspace, "/workspace");
  for (const [name, value] of Object.entries(input.environment).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    if (value !== undefined) args.push("--setenv", name, value);
  }
  const sandboxCwd = relativeCwd.length === 0 ? "/workspace" : `/workspace/${relativeCwd.split(sep).join("/")}`;
  args.push("--chdir", sandboxCwd, "--", input.command, ...input.commandArguments);
  return Object.freeze(args);
}

export async function assertWorkspaceHasNoHardLinks(workspace: string): Promise<void> {
  let entries = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > 100_000) {
        throw Object.assign(new Error("Contained command hard-link scan exceeded 100000 workspace entries."), {
          code: "LIMIT_EXCEEDED",
        });
      }
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(path);
      } else if (info.isFile() && info.nlink > 1) {
        throw Object.assign(new Error(`Contained command refused hard-linked workspace file '${relative(workspace, path)}'.`), {
          code: "PERMISSION_DENIED",
        });
      }
    }
  };
  await visit(workspace);
}
