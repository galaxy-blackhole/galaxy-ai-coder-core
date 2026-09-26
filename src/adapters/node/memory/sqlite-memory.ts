import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEmbeddingPort, AgentMemoryConsolidation, AgentMemoryPort, MemoryRecord } from "../../../agent/index.js";

function record(row: Record<string, unknown>): MemoryRecord {
  return { id: String(row.id), key: String(row.memory_key), scope: String(row.scope), revision: Number(row.revision), content: String(row.content), source: String(row.source), contentHash: String(row.content_hash), status: row.status as MemoryRecord["status"], trust: row.trust as MemoryRecord["trust"], updatedAt: String(row.updated_at) };
}

function encodeVector(vector: Float32Array | readonly number[]): Buffer {
  const floats = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return Buffer.from(floats.buffer.slice(0, floats.byteLength));
}
function decodeVector(blob: Uint8Array): Float32Array {
  const copy = Uint8Array.from(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}
function cosine(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let dot = 0; let normLeft = 0; let normRight = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index]!; const b = right[index]!;
    dot += a * b; normLeft += a * a; normRight += b * b;
  }
  if (normLeft === 0 || normRight === 0) return 0;
  return dot / Math.sqrt(normLeft * normRight);
}
/** Recency decays over a two-week half-life; listing (no query) leans on it most. */
function recencyScore(updatedAt: string, now: number): number {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return 0;
  const ageDays = Math.max(0, (now - parsed) / 86_400_000);
  return 1 / (1 + ageDays / 14);
}

/**
 * Optional Node >=22.13 adapter. No database or native imports occur from the
 * core root. Ranking is hybrid: lexical (FTS5 bm25) + optional semantic cosine
 * + recency + trust, capability-gated on a host-supplied embedding provider.
 */
export class SqliteAgentMemory implements AgentMemoryPort {
  private readonly db: DatabaseSync;
  private readonly embeddings: AgentEmbeddingPort | undefined;
  constructor(path: string, private readonly scope: string, options: { embeddings?: AgentEmbeddingPort } = {}) {
    if (!scope || scope.length > 1024) throw new Error("A bounded host-owned memory scope is required.");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.embeddings = options.embeddings;
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS agent_memory_schema(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO agent_memory_schema VALUES(1);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, scope TEXT NOT NULL, memory_key TEXT NOT NULL, revision INTEGER NOT NULL,
      content TEXT NOT NULL, source TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL, trust TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(scope,memory_key,revision));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED, content, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS memory_embeddings(memory_id TEXT PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL);
      CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memories BEGIN INSERT INTO memory_search VALUES(new.id,new.content); END;
      CREATE TRIGGER IF NOT EXISTS memory_delete AFTER DELETE ON memories BEGIN DELETE FROM memory_search WHERE id=old.id; END;
      CREATE TRIGGER IF NOT EXISTS memory_delete_embeddings AFTER DELETE ON memories BEGIN DELETE FROM memory_embeddings WHERE memory_id=old.id; END;
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(scope,status,memory_key);`);
  }
  async search(query: string, options: { limit?: number; includeCandidates?: boolean } = {}): Promise<readonly MemoryRecord[]> {
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 8)));
    const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 24) ?? [];
    const trust = options.includeCandidates ? "" : " AND m.trust='confirmed'";
    const pool = Math.max(limit * 8, 64);
    let rows: Record<string, unknown>[] = [];
    if (tokens.length) {
      const match = tokens.map(token => `"${token}"`).join(" OR ");
      rows = this.db.prepare(`SELECT m.*, bm25(memory_search) AS rank FROM memory_search f JOIN memories m ON m.id=f.id WHERE memory_search MATCH ? AND m.scope=? AND m.status='active'${trust} ORDER BY bm25(memory_search),m.updated_at DESC LIMIT ?`)
        .all(match, this.scope, pool) as Record<string, unknown>[];
    }
    // No lexical hits (or a bare listing): fall back to recent active notes so
    // semantic ranking can still surface the right record.
    if (rows.length === 0 && (tokens.length === 0 || this.embeddings !== undefined)) {
      rows = this.db.prepare(`SELECT m.*, 0 AS rank FROM memories m WHERE m.scope=? AND m.status='active'${trust} ORDER BY m.updated_at DESC LIMIT ?`)
        .all(this.scope, pool) as Record<string, unknown>[];
    }
    if (rows.length === 0) return [];
    const now = Date.now();
    const queryVector = this.embeddings && tokens.length ? await this.embedOne(query) : undefined;
    const vectors = this.loadVectors(rows.map(row => String(row.id)));
    const strengths = rows.map(row => Math.max(0, -Number(row.rank ?? 0)));
    const maxStrength = Math.max(0, ...strengths);
    const scored = rows.map((row, index) => {
      const lexical = maxStrength > 0 ? strengths[index]! / maxStrength : 0;
      const vector = vectors.get(String(row.id));
      const semantic = queryVector && vector ? Math.max(0, cosine(queryVector, vector)) : 0;
      const recency = recencyScore(String(row.updated_at), now);
      const trustScore = row.trust === "confirmed" ? 1 : 0.5;
      const score = queryVector
        ? 0.35 * lexical + 0.4 * semantic + 0.15 * recency + 0.1 * trustScore
        : tokens.length
          ? 0.6 * lexical + 0.25 * recency + 0.15 * trustScore
          : 0.7 * recency + 0.3 * trustScore;
      return { row, score };
    });
    scored.sort((left, right) => right.score - left.score
      || String(right.row.updated_at).localeCompare(String(left.row.updated_at))
      || String(left.row.id).localeCompare(String(right.row.id)));
    return scored.slice(0, limit).map(entry => record(entry.row));
  }
  async remember(input: { key: string; content: string; source: string; trust?: "candidate" | "confirmed"; expectedRevision?: number }): Promise<MemoryRecord> {
    if (!input.key.trim() || input.key.length > 256 || !input.content.trim() || input.content.length > 16000 || !input.source.trim() || input.source.length > 2048) throw new Error("Invalid memory key, content, or provenance.");
    const trust = input.trust ?? "candidate";
    if (!["candidate", "confirmed"].includes(trust)) throw new Error("Invalid memory trust.");
    const hash = createHash("sha256").update(input.content).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    let stored: MemoryRecord;
    try {
      const previous = this.db.prepare("SELECT * FROM memories WHERE scope=? AND memory_key=? AND status='active'").get(this.scope, input.key);
      if (input.expectedRevision !== undefined && input.expectedRevision !== Number(previous?.revision ?? 0)) throw new Error("Memory revision conflict.");
      if (previous?.content_hash === hash && previous.source === input.source && previous.trust === trust) {
        this.db.exec("COMMIT");
        stored = record(previous);
      } else {
        // A generated candidate cannot silently supersede an explicitly confirmed note.
        if (previous?.trust === "confirmed" && trust === "candidate") throw new Error("A candidate cannot replace a confirmed memory; choose a new key.");
        this.db.prepare("UPDATE memories SET status='superseded' WHERE scope=? AND memory_key=?").run(this.scope, input.key);
        const id = randomUUID();
        this.db.prepare("INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, this.scope, input.key, Number(previous?.revision ?? 0) + 1, input.content, input.source, hash, "active", trust, new Date().toISOString());
        stored = record(this.db.prepare("SELECT * FROM memories WHERE id=?").get(id)!);
        this.db.exec("COMMIT");
      }
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    await this.storeEmbedding(stored.id, stored.content);
    return stored;
  }
  async history(key: string): Promise<readonly MemoryRecord[]> {
    return this.db.prepare("SELECT * FROM memories WHERE scope=? AND memory_key=? ORDER BY revision").all(this.scope, key).map(record);
  }
  async forget(key: string): Promise<number> {
    const result = this.db.prepare("DELETE FROM memories WHERE scope=? AND memory_key=?").run(this.scope, key);
    // This removes searchable/history data; user backups may still contain earlier copies.
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return Number(result.changes);
  }
  consolidate(options: { keepSupersededRevisions?: number } = {}): AgentMemoryConsolidation {
    const keep = Math.max(0, Math.min(100, Math.floor(options.keepSupersededRevisions ?? 5)));
    const removedSuperseded = Number(this.db.prepare(
      `DELETE FROM memories WHERE status='superseded' AND id NOT IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY scope, memory_key ORDER BY revision DESC) AS position
           FROM memories WHERE status='superseded'
         ) WHERE position <= ?
       )`).run(keep).changes);
    const removedOrphanEmbeddings = Number(this.db.prepare("DELETE FROM memory_embeddings WHERE memory_id NOT IN (SELECT id FROM memories)").run().changes);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return { removedOrphanEmbeddings, removedSuperseded };
  }
  close(): void { this.db.close(); }

  private async embedOne(text: string): Promise<Float32Array | undefined> {
    if (!this.embeddings) return undefined;
    try {
      const [vector] = await this.embeddings.embed([text]);
      return vector && vector.length > 0 ? Float32Array.from(vector) : undefined;
    } catch { return undefined; }
  }
  private async storeEmbedding(memoryId: string, content: string): Promise<void> {
    if (!this.embeddings) return;
    const existing = this.db.prepare("SELECT dims FROM memory_embeddings WHERE memory_id=? AND model=?").get(memoryId, this.embeddings.model);
    if (existing) return;
    const vector = await this.embedOne(content);
    if (!vector) return;
    this.db.prepare("INSERT OR REPLACE INTO memory_embeddings(memory_id, model, dims, vector) VALUES(?,?,?,?)").run(memoryId, this.embeddings.model, vector.length, encodeVector(vector));
  }
  private loadVectors(ids: readonly string[]): Map<string, Float32Array> {
    const vectors = new Map<string, Float32Array>();
    if (!this.embeddings || ids.length === 0) return vectors;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT memory_id, vector FROM memory_embeddings WHERE model=? AND memory_id IN (${placeholders})`)
      .all(this.embeddings.model, ...ids) as Record<string, unknown>[];
    for (const row of rows) vectors.set(String(row.memory_id), decodeVector(row.vector as Uint8Array));
    return vectors;
  }
}
