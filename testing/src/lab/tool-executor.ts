import { NodeToolExecutor, type NodeToolExecutorOptions } from "@galaxy-stack/ai-coder-core/adapters/node/tools/tool-executor";
import { DeterministicContractTools } from "./deterministic-contract-tools.js";
export * from "@galaxy-stack/ai-coder-core/adapters/node/tools/tool-executor";
export type LabToolExecutorOptions = NodeToolExecutorOptions;
export class LabToolExecutor extends NodeToolExecutor {
  constructor(options: LabToolExecutorOptions) {
    super({ ...options, ...((options.enableContractTools || options.toolProfile === "full_contract") ? { contractTools: new DeterministicContractTools() } : {}) });
  }
}
