/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Interface-segregated host capabilities consumed by the single-agent runtime.
 */

import type { ApprovalPort } from "./approval-port.js";
import type { ArtifactPort } from "./artifact-port.js";
import type { CodingModelPort } from "./coding-model-port.js";
import type {
  CommandRunnerPort,
  CommandSessionPort,
} from "./command-port.js";
import type { GitPort } from "./git-port.js";
import type { PersistencePort } from "./persistence-port.js";
import type { PreviewPort } from "./preview-port.js";
import type { ResearchPort } from "./research-port.js";
import type { TracePort } from "./trace-port.js";
import type {
  WorkspaceReaderPort,
  WorkspaceWriterPort,
} from "./workspace-port.js";

export type RequiredHostPorts = Readonly<{
  codingModel: CodingModelPort;
  workspaceReader: WorkspaceReaderPort;
}>;

/** Optional ports are absent—not stubs—when a host cannot safely implement them. */
export type OptionalHostPorts = Readonly<{
  approval?: ApprovalPort;
  artifact?: ArtifactPort;
  command?: CommandRunnerPort;
  commandSession?: CommandSessionPort;
  git?: GitPort;
  persistence?: PersistencePort;
  preview?: PreviewPort;
  research?: ResearchPort;
  trace?: TracePort;
  workspaceWriter?: WorkspaceWriterPort;
}>;

export type HostAdapter = RequiredHostPorts & OptionalHostPorts;
