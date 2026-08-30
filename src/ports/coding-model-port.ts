/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Port alias for the provider-neutral coding model adapter.
 */

import type { CodingModelAdapter } from "../tools/coding-messages.js";

export type {
  CodingAssistantMessage,
  CodingMessage,
  CodingModelAdapter,
  CodingRoundEvent,
  CodingRoundRequest,
  CodingSystemMessage,
  CodingTokenCount,
  CodingTokenCountInput,
  CodingTokenUsage,
  CodingToolCall,
  CodingToolDefinition,
  CodingToolResultMessage,
  CodingUserMessage,
} from "../tools/coding-messages.js";

export { CodingProviderError } from "../tools/coding-messages.js";

export type CodingModelPort = CodingModelAdapter;
