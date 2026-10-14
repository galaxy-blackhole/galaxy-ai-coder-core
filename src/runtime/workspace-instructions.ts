import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The instruction files a workspace keeps for agents.
 *
 * AGENTS.md is the convention this product follows. CLAUDE.md is what a project already has from another tool, and a
 * team should not have to rename a file to be read by us. Both are workspace DATA: they travel to the prompt as
 * untrusted workspace text, never as system policy, and the cap keeps one large file from eating the prompt.
 */
export const DEFAULT_WORKSPACE_INSTRUCTION_FILES = Object.freeze(["AGENTS.md", "CLAUDE.md"]);
export const DEFAULT_WORKSPACE_INSTRUCTION_MAX_CHARS = 8_000;

export interface WorkspaceInstruction {
  readonly content: string;
  readonly source: string;
}

export interface WorkspaceInstructionOptions {
  readonly files?: readonly string[];
  readonly maxChars?: number;
}

export async function readWorkspaceInstructions(
  root: string,
  options: WorkspaceInstructionOptions = {},
): Promise<readonly WorkspaceInstruction[]> {
  const files = options.files ?? DEFAULT_WORKSPACE_INSTRUCTION_FILES;
  const maxChars = options.maxChars ?? DEFAULT_WORKSPACE_INSTRUCTION_MAX_CHARS;
  const instructions: WorkspaceInstruction[] = [];
  for (const file of files) {
    try {
      const content = (await readFile(join(root, file), "utf8")).trim().slice(0, maxChars);
      if (content.length > 0) instructions.push(Object.freeze({ content, source: file }));
    } catch {
      /* A workspace without the file is a workspace without instructions, not a failure. */
    }
  }
  return Object.freeze(instructions);
}
