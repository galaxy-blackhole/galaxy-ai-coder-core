import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMemoryPort, MemoryRecord } from "../../../agent/index.js";

function record(row: Record<string, unknown>): MemoryRecord {
  return { id: String(row.id), key: String(row.memory_key), scope: String(row.scope), revision: Number(row.revision), content: String(row.content), source: String(row.source), contentHash: String(row.content_hash), status: row.status as MemoryRecord["status"], trust: row.trust as MemoryRecord["trust"], updatedAt: String(row.updated_at) };
}
/** Optional Node >=22.13 adapter. No database or native imports occur from the core root. */
export class SqliteAgentMemory implements AgentMemoryPort {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly scope: string) {
    if (!scope || scope.length > 1024) throw new Error("A bounded host-owned memory scope is required.");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS agent_memory_schema(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO agent_memory_schema VALUES(1);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, scope TEXT NOT NULL, memory_key TEXT NOT NULL, revision INTEGER NOT NULL,
      content TEXT NOT NULL, source TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL, trust TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(scope,memory_key,revision));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED, content, tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memories BEGIN INSERT INTO memory_search VALUES(new.id,new.content); END;
      CREATE TRIGGER IF NOT EXISTS memory_delete AFTER DELETE ON memories BEGIN DELETE FROM memory_search WHERE id=old.id; END;
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(scope,status,memory_key);`);
  }
  async search(query: string, options: { limit?: number; includeCandidates?: boolean } = {}): Promise<readonly MemoryRecord[]> {
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 8)));
    const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 24) ?? [];
    const trust = options.includeCandidates ? "" : " AND m.trust='confirmed'";
    if (!tokens.length) return (this.db.prepare(`SELECT m.* FROM memories m WHERE m.scope=? AND m.status='active'${trust} ORDER BY updated_at DESC LIMIT ?`).all(this.scope, limit) as Record<string, unknown>[]).map(record);
    const match = tokens.map(t => `"${t}"`).join(" OR ");
    return (this.db.prepare(`SELECT m.* FROM memory_search f JOIN memories m ON m.id=f.id WHERE memory_search MATCH ? AND m.scope=? AND m.status='active'${trust} ORDER BY bm25(memory_search),m.updated_at DESC LIMIT ?`).all(match, this.scope, limit) as Record<string, unknown>[]).map(record);
  }
  async remember(input: { key: string; content: string; source: string; trust?: "candidate" | "confirmed"; expectedRevision?: number }): Promise<MemoryRecord> {
    if (!input.key.trim() || input.key.length > 256 || !input.content.trim() || input.content.length > 16000 || !input.source.trim() || input.source.length > 2048) throw new Error("Invalid memory key, content, or provenance.");
    const trust = input.trust ?? "candidate";
    if (!["candidate", "confirmed"].includes(trust)) throw new Error("Invalid memory trust.");
    const hash = createHash("sha256").update(input.content).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT * FROM memories WHERE scope=? AND memory_key=? AND status='active'").get(this.scope, input.key);
      if (input.expectedRevision !== undefined && input.expectedRevision !== Number(previous?.revision ?? 0)) throw new Error("Memory revision conflict.");
      if (previous?.content_hash === hash && previous.source === input.source && previous.trust === trust) { this.db.exec("COMMIT"); return record(previous); }
      // A generated candidate cannot silently supersede an explicitly confirmed note.
      if (previous?.trust === "confirmed" && trust === "candidate") throw new Error("A candidate cannot replace a confirmed memory; choose a new key.");
      this.db.prepare("UPDATE memories SET status='superseded' WHERE scope=? AND memory_key=?").run(this.scope, input.key);
      const id = randomUUID();
      this.db.prepare("INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, this.scope, input.key, Number(previous?.revision ?? 0) + 1, input.content, input.source, hash, "active", trust, new Date().toISOString());
      const next = record(this.db.prepare("SELECT * FROM memories WHERE id=?").get(id)!);
      this.db.exec("COMMIT"); return next;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
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
  close(): void { this.db.close(); }
}
