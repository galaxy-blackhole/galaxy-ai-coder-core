import assert from "node:assert/strict";
import test from "node:test";

import { nodeCommandHostEnvironment } from "../../src/host/host-environment.js";

test("host environment exactly describes the command adapter interpreter", () => {
  assert.deepEqual(nodeCommandHostEnvironment("darwin", "arm64"), {
    architecture: "arm64",
    command: {
      argumentsPrefix: ["-c"],
      commandMode: "shell_string",
      executable: "/bin/sh",
      interactive: false,
      pathStyle: "posix",
      shell: "sh",
      stdin: "closed",
      tty: false,
    },
    operatingSystem: "darwin",
  });
  assert.deepEqual(nodeCommandHostEnvironment("linux", "x64"), {
    architecture: "x64",
    command: {
      argumentsPrefix: ["-c"],
      commandMode: "shell_string",
      executable: "/bin/sh",
      interactive: false,
      pathStyle: "posix",
      shell: "sh",
      stdin: "closed",
      tty: false,
    },
    operatingSystem: "linux",
  });
  assert.deepEqual(nodeCommandHostEnvironment("win32", "x64"), {
    architecture: "x64",
    command: {
      argumentsPrefix: ["/d", "/s", "/v:off", "/c"],
      commandMode: "shell_string",
      executable: "cmd.exe",
      interactive: false,
      pathStyle: "windows",
      shell: "cmd",
      stdin: "closed",
      tty: false,
    },
    operatingSystem: "win32",
  });
  assert.throws(
    () => nodeCommandHostEnvironment("freebsd", ""),
    (error: unknown) => error instanceof Error
      && (error as NodeJS.ErrnoException).code === "UNAVAILABLE"
      && /freebsd/.test(error.message),
  );
});
