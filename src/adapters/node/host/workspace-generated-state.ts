/**
 * Node host re-export of the shared generated-state policy.
 *
 * The canonical implementation lives in the runtime layer so the runtime can
 * filter generated paths from authored evidence without importing an adapter.
 */
export {
  GENERATED_WORKSPACE_DIRECTORIES,
  GENERATED_WORKSPACE_FILE_NAMES,
  GENERATED_WORKSPACE_FILE_SUFFIXES,
  isGeneratedWorkspaceDirectoryName,
  isGeneratedWorkspaceFileName,
  isGeneratedWorkspacePath,
} from "../../../runtime/workspace-generated-path.js";
