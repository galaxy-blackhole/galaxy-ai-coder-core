import assert from "node:assert/strict";
import test from "node:test";
import { buildBubblewrapArguments } from "../src/adapters/node/host/command-containment.js";

/*
 * Linux containment is exercised without needing bwrap installed: what matters is the argument list, because that
 * list is the whole policy. A backend nobody asserted is a backend that quietly stops confining anything.
 */
const workspace = "/tmp/galaxy-containment-workspace";

test("the workspace is the only writable mount, and the network is not shared", () => {
  const args = buildBubblewrapArguments({
    command: "/bin/sh",
    commandArguments: ["-c", "echo hi"],
    cwd: workspace,
    environment: { PATH: "/usr/bin" },
    workspace,
  });
  assert.ok(args.includes("--unshare-all"), "no shared namespaces");
  assert.ok(args.includes("--die-with-parent"), "a contained command cannot outlive its run");
  assert.ok(args.includes("--clearenv"), "the environment is rebuilt, not inherited");
  const bind = args.indexOf("--bind");
  assert.equal(args[bind + 1], workspace, "the workspace is bound");
  assert.equal(args[bind + 2], "/workspace", "at a fixed path inside the sandbox");
  assert.ok(args.includes("--tmpfs") && args.includes("/tmp"), "scratch space exists and is not the real one");
  assert.deepEqual(args.slice(-6), ["--chdir", "/workspace", "--", "/bin/sh", "-c", "echo hi"]);
});

test("a working directory outside the workspace is refused, not silently remapped", () => {
  assert.throws(() => buildBubblewrapArguments({
    command: "/bin/sh",
    commandArguments: [],
    cwd: "/tmp/somewhere-else",
    environment: {},
    workspace,
  }), /must remain inside the workspace/);
});

test("a subdirectory keeps its place inside the sandbox", () => {
  const args = buildBubblewrapArguments({
    command: "/bin/sh",
    commandArguments: [],
    cwd: workspace + "/packages/core",
    environment: {},
    workspace,
  });
  assert.deepEqual(args.slice(-4), ["--chdir", "/workspace/packages/core", "--", "/bin/sh"]);
});

test("the environment travels in a stable order, so the same run builds the same command", () => {
  const args = buildBubblewrapArguments({
    command: "/bin/sh",
    commandArguments: [],
    cwd: workspace,
    environment: { ZED: "1", ALPHA: "2" },
    workspace,
  });
  assert.deepEqual(args.filter((_value, index) => args[index - 1] === "--setenv"), ["ALPHA", "ZED"]);
});
