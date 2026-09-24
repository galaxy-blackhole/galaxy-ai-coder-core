import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertWorkspaceHasNoHardLinks,
  buildBubblewrapArguments,
  containmentStatus,
  type CommandContainmentProbeResult,
} from "../../src/host/command-containment.js";

function verifiedProbe(backend: "linux_bubblewrap" | "macos_sandbox_exec"): CommandContainmentProbeResult {
  return Object.freeze({
    available: true,
    backend,
    descendantChildSpawned: true,
    descendantQuiescent: true,
    executable: backend === "linux_bubblewrap" ? "/usr/bin/bwrap" : "/usr/bin/sandbox-exec",
    hardLinkWriteDenied: true,
    networkDenied: true,
    outsideWriteDenied: true,
    privateTempWrite: true,
    reason: null,
    systemRead: true,
    toolchainExecution: true,
    verified: true,
    workspaceWrite: true,
  });
}

test("only a fully verified implemented backend becomes active", () => {
  const linux = containmentStatus("required", verifiedProbe("linux_bubblewrap"));
  assert.equal(linux.active, true);
  assert.equal(linux.verified, true);
  assert.equal(linux.state, "active");
  assert.equal(linux.filesystemReads, "system_and_workspace");
  assert.equal(linux.filesystemWrites, "workspace_and_private_temp");
  assert.equal(linux.network, "denied");

  const deprecatedMacPrototype = containmentStatus("required", verifiedProbe("macos_sandbox_exec"));
  assert.equal(deprecatedMacPrototype.active, false);
  assert.equal(deprecatedMacPrototype.verified, false);
  assert.equal(deprecatedMacPrototype.state, "unverified");

  const inconsistent = containmentStatus("required", Object.freeze({
    ...verifiedProbe("linux_bubblewrap"),
    networkDenied: false,
  }));
  assert.equal(inconsistent.active, false);
  assert.equal(inconsistent.verified, false);
  assert.match(inconsistent.reason ?? "", /without passing every containment assertion/);
});

test("bubblewrap launch is deny-by-default and preserves command arguments without shell interpolation", () => {
  const args = buildBubblewrapArguments({
    command: "/bin/sh",
    commandArguments: ["-c", "printf '%s' \"$VALUE\""],
    cwd: "/workspace-root/packages/app",
    environment: { VALUE: "literal;$(not-executed)", ZED: "last", ALPHA: "first" },
    workspace: "/workspace-root",
  });
  assert.equal(args.includes("--unshare-all"), true);
  assert.equal(args.includes("--new-session"), true);
  assert.equal(args.includes("--die-with-parent"), true);
  assert.equal(args.includes("--disable-userns"), true);
  assert.equal(args.includes("--share-net"), false);
  assert.deepEqual(args.slice(-4), ["--", "/bin/sh", "-c", "printf '%s' \"$VALUE\""]);
  assert.equal(args[args.indexOf("--chdir") + 1], "/workspace/packages/app");
  assert.equal(args[args.indexOf("--bind") + 1], "/workspace-root");
  assert.equal(args[args.indexOf("--bind") + 2], "/workspace");
  assert.ok(args.indexOf("ALPHA") < args.indexOf("VALUE"));
  assert.ok(args.indexOf("VALUE") < args.indexOf("ZED"));
});

test("hard-linked workspace files are rejected before a contained command can spawn", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-hardlink-guard-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(workspace);
  await writeFile(outside, "sentinel", "utf8");
  await link(outside, join(workspace, "linked.txt"));
  testContext.after(async () => rm(root, { force: true, recursive: true }));

  await assert.rejects(assertWorkspaceHasNoHardLinks(workspace), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "PERMISSION_DENIED");
    assert.match((error as Error).message, /hard-linked workspace file 'linked\.txt'/);
    return true;
  });
});
