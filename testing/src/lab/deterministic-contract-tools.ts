import type {
  AiCoderRuntimeToolEffects,
  AiCoderRuntimeToolResult,
  RunExecutionContext,
} from "@galaxy-stack/ai-coder-core";
import { isIP } from "node:net";

import { sha256Text } from "../host/content-hash.js";

const FIXED_TIME = "1970-01-01T00:00:00.000Z";
const DEFAULT_ARTIFACT_READ_BYTES = 4_096;
const DEFAULT_FETCH_BYTES = 8_192;
const DEFAULT_SESSION_CHARS = 4_096;

type JsonObject = Readonly<Record<string, unknown>>;

export type DeterministicContractToolResult = Readonly<{
  effects?: AiCoderRuntimeToolEffects;
  output: JsonObject;
  summary: string;
  trust: AiCoderRuntimeToolResult["trust"];
}>;

type ArtifactRecord = Readonly<{
  content: string;
  contentHash: string;
  createdAt: string;
  id: string;
  kind: string;
  mimeType: string;
  name: string;
  retention: "default" | "durable" | "temporary";
}>;

type SessionRecord = {
  command: string;
  id: string;
  status: "interrupted" | "killed" | "running";
  stderr: string;
  stdout: string;
};

type PreviewRecord = Readonly<{
  artifactId?: string;
  command: string;
  id: string;
  status: "closed" | "open";
  url: string;
}>;

import { ContractToolError as DeterministicContractToolError } from "@galaxy-stack/ai-coder-core/adapters/node/tools/tool-executor";
export { DeterministicContractToolError };

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function stateVersion(value: unknown): string {
  return `sha256:${sha256Text(stableJson(value))}`;
}

function checkContext(context: RunExecutionContext): void {
  if (context.signal.aborted) {
    throw new DeterministicContractToolError("CANCELED", "The deterministic contract tool was canceled.");
  }
  if (Date.now() >= context.deadline) {
    throw new DeterministicContractToolError("DEADLINE_EXCEEDED", "The deterministic contract tool exceeded the run deadline.");
  }
}

function stringArgument(argumentsValue: JsonObject, name: string, fallback?: string): string {
  const value = argumentsValue[name];
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new DeterministicContractToolError("INVALID_INPUT", `Missing string argument '${name}'.`);
}

function numberArgument(argumentsValue: JsonObject, name: string, fallback: number): number {
  const value = argumentsValue[name];
  return typeof value === "number" ? value : fallback;
}

function booleanArgument(argumentsValue: JsonObject, name: string, fallback = false): boolean {
  const value = argumentsValue[name];
  return typeof value === "boolean" ? value : fallback;
}

function requireNonEmpty(value: string, message: string): string {
  if (value.length === 0) throw new DeterministicContractToolError("INVALID_INPUT", message);
  return value;
}

function parseIpv4(address: string): readonly number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? Object.freeze(bytes)
    : null;
}

function isPublicIpv4(address: string): boolean {
  const bytes = parseIpv4(address);
  if (bytes === null) return false;
  const [first = 0, second = 0, third = 0] = bytes;
  return !(
    first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224
  );
}

function ipv6Bytes(address: string): readonly number[] | null {
  const sections = address.toLowerCase().split("::");
  if (sections.length > 2) return null;
  const parseSection = (section: string): number[] | null => {
    if (section.length === 0) return [];
    const groups: number[] = [];
    for (const part of section.split(":")) {
      if (!/^[a-f0-9]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };
  const head = parseSection(sections[0] ?? "");
  const tail = parseSection(sections[1] ?? "");
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (sections.length === 1 && missing !== 0) || (sections.length === 2 && missing < 1)) return null;
  const groups = sections.length === 1 ? head : [...head, ...Array.from({ length: missing }, () => 0), ...tail];
  if (groups.length !== 8) return null;
  return Object.freeze(groups.flatMap((group) => [group >> 8, group & 0xff]));
}

function isPublicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (bytes === null) return false;
  const isUnspecified = bytes.every((byte) => byte === 0);
  const isLoopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const isUniqueLocal = (bytes[0]! & 0xfe) === 0xfc;
  const isLinkLocal = bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80;
  const isSiteLocal = bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0;
  const isMulticast = bytes[0] === 0xff;
  const isDocumentation = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
  const isIpv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isIpv4Mapped) return isPublicIpv4(bytes.slice(12).join("."));
  return !(isUnspecified || isLoopback || isUniqueLocal || isLinkLocal || isSiteLocal || isMulticast || isDocumentation);
}

function isPublicHttpUrl(parsed: URL): boolean {
  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (hostname.length === 0) return false;
  const version = isIP(hostname);
  if (version === 4) return isPublicIpv4(hostname);
  if (version === 6) return isPublicIpv6(hostname);
  if (!hostname.includes(".")) return false;
  return !["localhost", "local", "internal", "home", "lan", "test", "invalid", "example", "arpa"]
    .some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function provenance(source: string, trust: "trusted_host" | "untrusted_external" | "untrusted_tool_output", contentHash?: string) {
  return Object.freeze({
    source,
    trust,
    retrievedAt: FIXED_TIME,
    ...(contentHash === undefined ? {} : { contentHash }),
  });
}

function parseCursor(value: unknown, prefix: string, maximum: number): number {
  if (value === undefined) return 0;
  if (typeof value !== "string") {
    throw new DeterministicContractToolError("INVALID_INPUT", `Cursor must use '${prefix}<offset>'.`);
  }
  const match = new RegExp(`^${prefix}(\\d+)$`).exec(value);
  const offset = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximum) {
    throw new DeterministicContractToolError("INVALID_INPUT", `Cursor must use '${prefix}<offset>' within the resource.`);
  }
  return offset;
}

function textPage(text: string, start: number, maxBytes: number): Readonly<{
  content: string;
  end: number;
  truncated: boolean;
}> {
  const bytes = Buffer.from(text, "utf8");
  const endLimit = Math.min(bytes.byteLength, start + maxBytes);
  let end = endLimit;
  let content = "";
  while (end >= start) {
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
      break;
    } catch {
      end -= 1;
    }
  }
  if (end < start) {
    throw new DeterministicContractToolError("INVALID_INPUT", "Cursor does not point to a UTF-8 boundary.");
  }
  return Object.freeze({ content, end, truncated: end < bytes.byteLength });
}

function sessionPage(text: string, cursor: unknown, maxChars: number): Readonly<{
  cursor: string;
  text: string;
}> {
  const start = parseCursor(cursor, "offset:", text.length);
  const end = Math.min(text.length, start + maxChars);
  return Object.freeze({ cursor: `offset:${end}`, text: text.slice(start, end) });
}

function artifactKind(mimeType: string): string {
  const slash = mimeType.indexOf("/");
  return slash <= 0 ? "data" : mimeType.slice(0, slash);
}

/**
 * Deterministic, in-memory doubles for exercising the nine optional core tool
 * contracts. This class performs no network, process, preview, media, storage,
 * or user integration and must not be presented as a production adapter.
 */
export class DeterministicContractTools {
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly previews = new Map<string, PreviewRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private artifactSequence = 0;
  private previewSequence = 0;
  private sessionSequence = 0;

  async execute(
    canonicalToolId: string,
    argumentsValue: JsonObject,
    context: RunExecutionContext,
  ): Promise<DeterministicContractToolResult> {
    checkContext(context);
    switch (canonicalToolId) {
      case "research.fetch":
        return this.fetch(argumentsValue);
      case "research.search":
        return this.search(argumentsValue);
      case "command.session":
        return this.manageSession(argumentsValue);
      case "preview.manage":
        return this.managePreview(argumentsValue);
      case "perception.analyze":
        return this.analyzeArtifact(argumentsValue);
      case "artifact.create":
        return this.createArtifact(argumentsValue);
      case "artifact.list":
        return this.listArtifacts(argumentsValue);
      case "artifact.read":
        return this.readArtifact(argumentsValue);
      case "user.ask":
        return this.askUser(argumentsValue);
      default:
        throw new DeterministicContractToolError(
          "UNSUPPORTED_TOOL",
          `No deterministic optional contract double exists for ${canonicalToolId}.`,
        );
    }
  }

  private fetch(argumentsValue: JsonObject): DeterministicContractToolResult {
    const url = requireNonEmpty(stringArgument(argumentsValue, "url"), "URL must not be empty.");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DeterministicContractToolError("INVALID_INPUT", "URL must be a valid public HTTP(S) URL.");
    }
    if (!isPublicHttpUrl(parsed)) {
      throw new DeterministicContractToolError("INVALID_INPUT", "URL must be a valid public HTTP(S) URL.");
    }
    const fullContent = Array.from(
      { length: 32 },
      (_, index) => `Contract document ${String(index + 1).padStart(2, "0")} for ${parsed.href}`,
    ).join("\n");
    const contentHash = sha256Text(fullContent);
    const page = textPage(fullContent, 0, numberArgument(argumentsValue, "maxBytes", DEFAULT_FETCH_BYTES));
    return Object.freeze({
      output: Object.freeze({
        url: parsed.href,
        title: `Deterministic document for ${parsed.hostname}`,
        content: page.content,
        mimeType: "text/plain; charset=utf-8",
        contentHash,
        truncated: page.truncated,
        provenance: provenance(parsed.href, "untrusted_external", contentHash),
      }),
      summary: `Fetched deterministic contract content for ${parsed.hostname}.`,
      trust: "external",
    });
  }

  private search(argumentsValue: JsonObject): DeterministicContractToolResult {
    const query = requireNonEmpty(stringArgument(argumentsValue, "query"), "Search query must not be empty.");
    const maxResults = numberArgument(argumentsValue, "maxResults", 5);
    const count = Math.min(maxResults, 3);
    const queryHash = sha256Text(query);
    const results = Object.freeze(Array.from({ length: count }, (_, index) => {
      const url = `https://example.invalid/search/${queryHash.slice(0, 16)}/${index + 1}`;
      const contentHash = sha256Text(`${query}\0${index + 1}`);
      return Object.freeze({
        title: `Deterministic result ${index + 1} for ${query}`,
        url,
        snippet: `Contract-only search result ${index + 1}.`,
        provider: "galaxy-code-contract",
        provenance: provenance(url, "untrusted_external", contentHash),
      });
    }));
    return Object.freeze({
      output: Object.freeze({
        results,
        provenance: provenance("contract:research.search", "untrusted_external", queryHash),
      }),
      summary: `Returned ${results.length} deterministic search result(s).`,
      trust: "external",
    });
  }

  private manageSession(argumentsValue: JsonObject): DeterministicContractToolResult {
    const action = stringArgument(argumentsValue, "action") as "interrupt" | "kill" | "list" | "read" | "start" | "write";
    if (action === "list") {
      const sessions = Object.freeze([...this.sessions.values()]
        .sort((left, right) => compareCodeUnits(left.id, right.id))
        .map((session) => Object.freeze({
          sessionId: session.id,
          command: session.command,
          status: session.status,
        })));
      return Object.freeze({
        output: Object.freeze({ action, status: "listed", sessions }),
        summary: `Listed ${sessions.length} deterministic session(s).`,
        trust: "trusted",
      });
    }
    if (action === "start") {
      const command = requireNonEmpty(
        stringArgument(argumentsValue, "command", ""),
        "Starting a deterministic session requires a command.",
      );
      this.sessionSequence += 1;
      const id = `session-${String(this.sessionSequence).padStart(4, "0")}`;
      const session: SessionRecord = {
        command,
        id,
        status: "running",
        stderr: "",
        stdout: `started:${command}\n`,
      };
      this.sessions.set(id, session);
      return this.sessionResult(action, session, undefined, Object.freeze({ stateVersion: this.sessionStateVersion() }));
    }
    const sessionId = requireNonEmpty(
      stringArgument(argumentsValue, "sessionId", ""),
      `Session action '${action}' requires sessionId.`,
    );
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new DeterministicContractToolError("NOT_FOUND", `Deterministic session '${sessionId}' does not exist.`);
    }
    if (action === "read") return this.sessionResult(action, session, argumentsValue);
    if (action === "write") {
      if (session.status !== "running") {
        throw new DeterministicContractToolError("CONFLICT", `Session '${sessionId}' is not running.`);
      }
      const input = stringArgument(argumentsValue, "input", "");
      session.stdout += `input:${input}\n`;
    } else if (action === "interrupt") {
      session.status = "interrupted";
      session.stderr += "interrupted\n";
    } else if (action === "kill") {
      session.status = "killed";
      session.stderr += "killed\n";
    }
    return this.sessionResult(
      action,
      session,
      argumentsValue,
      Object.freeze({ stateVersion: this.sessionStateVersion() }),
    );
  }

  private sessionResult(
    action: string,
    session: SessionRecord,
    argumentsValue?: JsonObject,
    effects?: AiCoderRuntimeToolEffects,
  ): DeterministicContractToolResult {
    const maxChars = argumentsValue === undefined
      ? DEFAULT_SESSION_CHARS
      : numberArgument(argumentsValue, "maxChars", DEFAULT_SESSION_CHARS);
    const stdout = sessionPage(session.stdout, argumentsValue?.stdoutAfter, maxChars);
    const stderr = sessionPage(session.stderr, argumentsValue?.stderrAfter, maxChars);
    return Object.freeze({
      output: Object.freeze({
        action,
        sessionId: session.id,
        status: session.status,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutCursor: stdout.cursor,
        stderrCursor: stderr.cursor,
      }),
      summary: `Deterministic session ${session.id} is ${session.status}.`,
      trust: "external",
      ...(effects === undefined ? {} : { effects }),
    });
  }

  private sessionStateVersion(): string {
    return stateVersion([...this.sessions.values()]
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .map((session) => ({ ...session })));
  }

  private managePreview(argumentsValue: JsonObject): DeterministicContractToolResult {
    const action = stringArgument(argumentsValue, "action") as "close" | "open";
    if (action === "open") {
      const command = requireNonEmpty(
        stringArgument(argumentsValue, "command", ""),
        "Opening a deterministic preview requires a command.",
      );
      const port = numberArgument(argumentsValue, "expectPort", 4_173);
      this.previewSequence += 1;
      const id = `preview-${String(this.previewSequence).padStart(4, "0")}`;
      const artifactId = booleanArgument(argumentsValue, "captureArtifact")
        ? this.storeArtifact({
          content: `preview:${id}\nurl:http://127.0.0.1:${port}\n`,
          mimeType: "text/plain",
          name: `${id}.txt`,
          retention: "temporary",
        }).id
        : undefined;
      const preview: PreviewRecord = Object.freeze({
        id,
        command,
        status: "open",
        url: `http://127.0.0.1:${port}`,
        ...(artifactId === undefined ? {} : { artifactId }),
      });
      this.previews.set(id, preview);
      return this.previewResult(action, preview);
    }
    const sessionId = requireNonEmpty(
      stringArgument(argumentsValue, "sessionId", ""),
      "Closing a deterministic preview requires sessionId.",
    );
    const current = this.previews.get(sessionId);
    if (current === undefined) {
      throw new DeterministicContractToolError("NOT_FOUND", `Deterministic preview '${sessionId}' does not exist.`);
    }
    const closed: PreviewRecord = Object.freeze({ ...current, status: "closed" });
    this.previews.set(sessionId, closed);
    return this.previewResult(action, closed);
  }

  private previewResult(action: string, preview: PreviewRecord): DeterministicContractToolResult {
    return Object.freeze({
      output: Object.freeze({
        action,
        sessionId: preview.id,
        status: preview.status,
        url: preview.url,
        ...(preview.artifactId === undefined ? {} : { artifactId: preview.artifactId }),
      }),
      summary: `Deterministic preview ${preview.id} is ${preview.status}.`,
      trust: "trusted",
      effects: Object.freeze({ stateVersion: this.previewStateVersion() }),
    });
  }

  private previewStateVersion(): string {
    return stateVersion({
      artifacts: this.artifactState(),
      previews: [...this.previews.values()].sort((left, right) => compareCodeUnits(left.id, right.id)),
    });
  }

  private analyzeArtifact(argumentsValue: JsonObject): DeterministicContractToolResult {
    const artifactId = stringArgument(argumentsValue, "artifactId");
    const mode = stringArgument(argumentsValue, "mode");
    const artifact = this.artifacts.get(artifactId);
    if (artifact === undefined) {
      throw new DeterministicContractToolError("NOT_FOUND", `Artifact '${artifactId}' does not exist in the contract lab.`);
    }
    const observations = mode === "metadata"
      ? [`mimeType=${artifact.mimeType}`, `bytes=${Buffer.byteLength(artifact.content, "utf8")}`, `hash=${artifact.contentHash}`]
      : mode === "ocr"
        ? [artifact.content.slice(0, 256)]
        : [`Deterministic visual observation for ${artifact.name}.`];
    return Object.freeze({
      output: Object.freeze({
        artifactId,
        mode,
        observations: Object.freeze(observations),
        confidence: 1,
        analyzer: "galaxy-code-contract-analyzer/1",
        provenance: provenance(`artifact:${artifactId}`, "untrusted_tool_output", artifact.contentHash),
      }),
      summary: `Analyzed ${artifactId} in deterministic ${mode} mode.`,
      trust: "external",
    });
  }

  private createArtifact(argumentsValue: JsonObject): DeterministicContractToolResult {
    const artifact = this.storeArtifact({
      name: stringArgument(argumentsValue, "name"),
      content: stringArgument(argumentsValue, "content", ""),
      mimeType: stringArgument(argumentsValue, "mimeType"),
      retention: (stringArgument(argumentsValue, "retention", "default")) as ArtifactRecord["retention"],
    });
    return Object.freeze({
      output: Object.freeze({
        id: artifact.id,
        mimeType: artifact.mimeType,
        contentHash: artifact.contentHash,
        bytes: Buffer.byteLength(artifact.content, "utf8"),
      }),
      summary: `Created deterministic artifact ${artifact.id}.`,
      trust: "trusted",
      effects: Object.freeze({ stateVersion: this.artifactStateVersion() }),
    });
  }

  private storeArtifact(input: Readonly<{
    content: string;
    mimeType: string;
    name: string;
    retention: ArtifactRecord["retention"];
  }>): ArtifactRecord {
    this.artifactSequence += 1;
    const artifact: ArtifactRecord = Object.freeze({
      ...input,
      contentHash: sha256Text(input.content),
      createdAt: FIXED_TIME,
      id: `artifact-${String(this.artifactSequence).padStart(4, "0")}`,
      kind: artifactKind(input.mimeType),
    });
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  private artifactState(): readonly ArtifactRecord[] {
    return Object.freeze([...this.artifacts.values()].sort((left, right) => compareCodeUnits(left.id, right.id)));
  }

  private artifactStateVersion(): string {
    return stateVersion(this.artifactState());
  }

  private listArtifacts(argumentsValue: JsonObject): DeterministicContractToolResult {
    const kind = stringArgument(argumentsValue, "kind", "");
    const filtered = this.artifactState().filter((artifact) => kind.length === 0 || artifact.kind === kind);
    const start = parseCursor(argumentsValue.cursor, "offset:", filtered.length);
    const limit = numberArgument(argumentsValue, "limit", 50);
    const page = filtered.slice(start, start + limit);
    const nextOffset = start + page.length;
    return Object.freeze({
      output: Object.freeze({
        artifacts: Object.freeze(page.map((artifact) => Object.freeze({
          id: artifact.id,
          kind: artifact.kind,
          mimeType: artifact.mimeType,
          contentHash: artifact.contentHash,
          createdAt: artifact.createdAt,
        }))),
        ...(nextOffset < filtered.length ? { nextCursor: `offset:${nextOffset}` } : {}),
      }),
      summary: `Listed ${page.length} deterministic artifact(s).`,
      trust: "trusted",
    });
  }

  private readArtifact(argumentsValue: JsonObject): DeterministicContractToolResult {
    const id = stringArgument(argumentsValue, "id");
    const artifact = this.artifacts.get(id);
    if (artifact === undefined) {
      throw new DeterministicContractToolError("NOT_FOUND", `Artifact '${id}' does not exist in the contract lab.`);
    }
    const bytes = Buffer.byteLength(artifact.content, "utf8");
    const start = parseCursor(argumentsValue.cursor, "byte:", bytes);
    const page = textPage(
      artifact.content,
      start,
      numberArgument(argumentsValue, "maxBytes", DEFAULT_ARTIFACT_READ_BYTES),
    );
    return Object.freeze({
      output: Object.freeze({
        id,
        content: page.content,
        mimeType: artifact.mimeType,
        contentHash: artifact.contentHash,
        truncated: page.truncated,
        provenance: provenance(`artifact:${id}`, "untrusted_tool_output", artifact.contentHash),
        ...(page.truncated ? { nextCursor: `byte:${page.end}` } : {}),
      }),
      summary: `Read ${page.content.length} character(s) from deterministic artifact ${id}.`,
      trust: "external",
    });
  }

  private askUser(argumentsValue: JsonObject): DeterministicContractToolResult {
    const questions = argumentsValue.questions;
    if (!Array.isArray(questions)) {
      throw new DeterministicContractToolError("INVALID_INPUT", "questions must be an array.");
    }
    const answers = Object.freeze(questions.map((question) => {
      const item = question as Readonly<Record<string, unknown>>;
      const id = String(item.id ?? "");
      const text = String(item.question ?? "");
      return Object.freeze({ id, answer: `Deterministic contract answer for '${id}': ${text}` });
    }));
    return Object.freeze({
      output: Object.freeze({ answers, cancelled: false }),
      summary: `Answered ${answers.length} deterministic contract question(s).`,
      trust: "trusted",
    });
  }
}
