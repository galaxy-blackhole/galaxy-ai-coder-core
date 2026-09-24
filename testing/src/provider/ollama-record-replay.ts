import type { FetchLike } from "./ollama-coding-model.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Keyless session recording for the Ollama coding model. The recorder wraps the
 * provider fetch, clones every `/api/show` and `/api/chat` response, and stores
 * the raw request/response bodies as a replay fixture. Recording never reads
 * the API key into the fixture: credentials are redacted from every stored
 * body before the file is written.
 */
export interface RecordedRound {
  readonly request: unknown;
  readonly body: string;
}

export interface RecordedSession {
  readonly schemaVersion: 1;
  readonly recordedAt: string;
  /**
   * The recording contract: prompt version plus a fingerprint of the scenario
   * inputs. Replay must reject a fixture whose contract no longer matches the
   * current code and scenario, pointing at a re-record instead of diverging.
   */
  readonly contract: Readonly<{
    promptVersion: string;
    scenarioFingerprint: string;
  }>;
  readonly connection: Readonly<{
    baseUrl: string;
    model: string;
    provider: "ollama";
    runtimeVersion: "ollama-api-chat-v1";
  }>;
  readonly capabilities: unknown;
  readonly rounds: readonly RecordedRound[];
}

export interface RecordingFetch {
  readonly fetch: FetchLike;
  /** Writes the accumulated fixture once the run has finished. */
  readonly flush: () => Promise<void>;
}

function endpointKind(url: string): "capabilities" | "chat" | null {
  if (url.endsWith("/api/show")) return "capabilities";
  if (url.endsWith("/api/chat")) return "chat";
  return null;
}

function redact(text: string, apiKey: string | undefined): string {
  return apiKey === undefined || apiKey.length === 0 ? text : text.replaceAll(apiKey, "[REDACTED]");
}

export function createRecordingFetch(options: Readonly<{
  apiKey?: string;
  baseUrl: string;
  model: string;
  output: string;
  promptVersion: string;
  scenarioFingerprint: string;
}>): RecordingFetch {
  const rounds: RecordedRound[] = [];
  let capabilities: unknown = null;
  let flushed = false;
  const fetch: FetchLike = async (input, init) => {
    const kind = endpointKind(String(input));
    const response = await globalThis.fetch(input, init);
    if (kind === null) return response;
    const body = redact(await response.clone().text(), options.apiKey);
    if (kind === "capabilities") {
      capabilities = JSON.parse(body) as unknown;
    } else {
      rounds.push(Object.freeze({
        request: JSON.parse(redact(String(init?.body ?? "{}"), options.apiKey)) as unknown,
        body,
      }));
    }
    return response;
  };
  const flush = async (): Promise<void> => {
    if (flushed) return;
    flushed = true;
    const session: RecordedSession = Object.freeze({
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      contract: Object.freeze({
        promptVersion: options.promptVersion,
        scenarioFingerprint: options.scenarioFingerprint,
      }),
      connection: { baseUrl: options.baseUrl, model: options.model, provider: "ollama", runtimeVersion: "ollama-api-chat-v1" },
      capabilities,
      rounds: Object.freeze(rounds),
    });
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  };
  return Object.freeze({ fetch, flush });
}

export function createReplayFetch(session: RecordedSession): FetchLike {
  let nextRound = 0;
  return async (input) => {
    const kind = endpointKind(String(input));
    if (kind === "capabilities") {
      if (session.capabilities === null) throw new Error("Replay fixture has no recorded capabilities response.");
      return new Response(JSON.stringify(session.capabilities), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (kind === "chat") {
      if (nextRound >= session.rounds.length) {
        throw new Error(`Replay fixture exhausted: the model requested round ${nextRound + 1} but only ${session.rounds.length} rounds were recorded.`);
      }
      const round = session.rounds[nextRound]!;
      nextRound += 1;
      return new Response(round.body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    }
    throw new Error(`Replay fixture received an unexpected provider URL: ${String(input)}`);
  };
}
