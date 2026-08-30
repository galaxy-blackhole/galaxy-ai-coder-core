/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-21
 * @desc Chat attachment shape consumed by ContextManager, TokenLedger, and PromptAssembler.
 */

export type AiCoderAttachmentSource =
  | "clipboard"
  | "generated"
  | "screen_capture"
  | "tool_output"
  | "user_upload"
  | "workspace";

/**
 * Artifact-first attachment reference. Binary transport is optional because a
 * host may resolve it lazily from `artifactId`; provenance and trust are never
 * optional and dynamic content cannot become an instruction.
 */
export type AiCoderAttachment = Readonly<{
  artifactId: string;
  byteLength?: number;
  contentSha256: string;
  dataUrl?: string;
  decodedPixels?: number;
  height?: number;
  mimeType: string;
  name: string;
  provenance: Readonly<{
    locator?: string;
    source: AiCoderAttachmentSource;
  }>;
  retention: "default" | "durable" | "temporary";
  trust: "untrusted_data";
  width?: number;
}>;

export type PreparedAiCoderAttachments = Readonly<{
  directVision: readonly AiCoderAttachment[];
  promptContext: string;
}>;
