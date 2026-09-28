import { Pool } from 'pg';
import type { ChatMessage, MemoryRecord, ProviderAttempt, Store, UsageEvent } from './types.js';
import { schemaSql } from './schema.js';
import { id, messageText, normalizeKeywords, sha256, toVectorLiteral } from './utils.js';

function parseEmbedding(value: unknown): number[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string') {
    try {
      return value.replace(/^\[/, '').replace(/\]$/, '').split(',').filter(Boolean).map(Number);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function mapMemory(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    kind: row.kind as MemoryRecord['kind'],
    content: String(row.content),
    keywords: Array.isArray(row.keywords) ? row.keywords.map(String) : [],
    importance: Number(row.importance ?? 0.5),
    sourceMessageIds: Array.isArray(row.source_message_ids) ? row.source_message_ids.map(String) : [],
    embedding: parseEmbedding(row.embedding),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export class InMemoryStore implements Store {
  private readonly sessions = new Map<string, { agentId: string; summary?: string; updatedAt: string }>();
  private readonly messages = new Map<string, ChatMessage[]>();
  private readonly memories = new Map<string, MemoryRecord>();
  private readonly attempts: ProviderAttempt[] = [];
  private readonly usage: UsageEvent[] = [];

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async ensureSession(id: string, agentId: string): Promise<void> {
    const old = this.sessions.get(id);
    if (old && old.agentId !== agentId) throw new Error('session belongs to another agent');
    this.sessions.set(id, { agentId, summary: old?.summary, updatedAt: new Date().toISOString() });
    if (!this.messages.has(id)) this.messages.set(id, []);
  }

  async appendMessages(sessionId: string, agentId: string, messages: ChatMessage[]): Promise<void> {
    await this.ensureSession(sessionId, agentId);
    const existing = this.messages.get(sessionId) ?? [];
    const hashes = new Set(existing.map((message) => sha256(message)));
    for (const message of messages) {
      const hash = sha256(message);
      if (!hashes.has(hash)) {
        existing.push(structuredClone(message));
        hashes.add(hash);
      }
    }
    this.messages.set(sessionId, existing);
  }

  async getMessages(sessionId: string, limit = 1000): Promise<ChatMessage[]> {
    return structuredClone((this.messages.get(sessionId) ?? []).slice(-limit));
  }

  async getSummary(sessionId: string): Promise<string | undefined> {
    return this.sessions.get(sessionId)?.summary;
  }

  async setSummary(sessionId: string, summary: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('session not found');
    session.summary = summary;
    session.updatedAt = new Date().toISOString();
  }

  async upsertMemory(memory: MemoryRecord): Promise<void> {
    const existing = [...this.memories.values()].find((item) => item.agentId === memory.agentId && item.sessionId === memory.sessionId && sha256(item.content) === sha256(memory.content));
    if (existing) {
      this.memories.set(existing.id, { ...existing, ...memory, id: existing.id, updatedAt: new Date().toISOString() });
      return;
    }
    this.memories.set(memory.id, memory);
  }

  async searchMemories(agentId: string, sessionId: string | undefined, query: string, _embedding?: number[], limit = 12): Promise<MemoryRecord[]> {
    const tokens = normalizeKeywords(query);
    const all = [...this.memories.values()].filter((memory) => memory.agentId === agentId && (!memory.sessionId || memory.sessionId === sessionId));
    return all
      .map((memory) => ({ memory, score: tokens.reduce((score, token) => score + (memory.keywords.includes(token) || memory.content.toLowerCase().includes(token) ? 1 : 0), 0) + memory.importance * 0.25 }))
      .filter((item) => tokens.length === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
      .slice(0, limit)
      .map((item) => structuredClone(item.memory));
  }

  async listMemories(agentId: string, sessionId?: string): Promise<MemoryRecord[]> {
    return [...this.memories.values()].filter((memory) => memory.agentId === agentId && (!sessionId || memory.sessionId === sessionId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((memory) => structuredClone(memory));
  }

  async deleteMemory(memoryId: string): Promise<void> {
    this.memories.delete(memoryId);
  }

  async logAttempt(attempt: ProviderAttempt): Promise<void> { this.attempts.push(attempt); }
  async logUsage(event: UsageEvent): Promise<void> { this.usage.push(event); }
}

export class PostgresStore implements Store {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  async init(): Promise<void> {
    await this.pool.query(schemaSql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureSession(idValue: string, agentId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions(id, agent_id) VALUES($1, $2)
       ON CONFLICT(id) DO UPDATE SET updated_at = NOW()
       RETURNING agent_id`,
      [idValue, agentId],
    );
    const row = await this.pool.query<{ agent_id: string }>('SELECT agent_id FROM sessions WHERE id = $1', [idValue]);
    if (row.rows[0]?.agent_id !== agentId) throw new Error('session belongs to another agent');
  }

  async appendMessages(sessionId: string, agentId: string, messages: ChatMessage[]): Promise<void> {
    await this.ensureSession(sessionId, agentId);
    for (const message of messages) {
      await this.pool.query(
        `INSERT INTO messages(id, session_id, agent_id, role, content, message, message_hash)
         VALUES($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
         ON CONFLICT(session_id, message_hash) DO NOTHING`,
        [id(), sessionId, agentId, message.role, JSON.stringify(message.content ?? null), JSON.stringify(message), sha256(message)],
      );
    }
    await this.pool.query('UPDATE sessions SET updated_at = NOW() WHERE id = $1', [sessionId]);
  }

  async getMessages(sessionId: string, limit = 1000): Promise<ChatMessage[]> {
    const result = await this.pool.query<{ message: ChatMessage }>(
      'SELECT message FROM messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT $2',
      [sessionId, limit],
    );
    return result.rows.map((row) => row.message);
  }

  async getSummary(sessionId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ summary?: string }>('SELECT summary FROM sessions WHERE id = $1', [sessionId]);
    return result.rows[0]?.summary;
  }

  async setSummary(sessionId: string, summary: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET summary = $2, updated_at = NOW() WHERE id = $1', [sessionId, summary]);
  }

  async upsertMemory(memory: MemoryRecord): Promise<void> {
    const vector = memory.embedding ? toVectorLiteral(memory.embedding) : null;
    await this.pool.query(
      `INSERT INTO memories(id, agent_id, session_id, kind, content, keywords, importance, source_message_ids, content_hash, embedding)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)
       ON CONFLICT(agent_id, session_id, content_hash) DO UPDATE SET
         importance = EXCLUDED.importance,
         keywords = EXCLUDED.keywords,
         embedding = COALESCE(EXCLUDED.embedding, memories.embedding),
         updated_at = NOW()`,
      [memory.id, memory.agentId, memory.sessionId ?? null, memory.kind, memory.content, memory.keywords, memory.importance, memory.sourceMessageIds, sha256(memory.content), vector],
    );
  }

  async searchMemories(agentId: string, sessionId: string | undefined, query: string, embedding?: number[], limit = 12): Promise<MemoryRecord[]> {
    const tokens = normalizeKeywords(query).slice(0, 8);
    const patterns = tokens.map((token) => `%${token}%`);
    const scope = sessionId ? '(session_id IS NULL OR session_id = $2)' : 'session_id IS NULL';
    if (embedding) {
      try {
        const params: unknown[] = [agentId];
        let scopeParam = '';
        if (sessionId) { params.push(sessionId); scopeParam = '$2'; }
        const vectorParam = `$${params.length + 1}`;
        params.push(toVectorLiteral(embedding));
        params.push(limit);
        const result = await this.pool.query(
          `SELECT * FROM memories WHERE agent_id = $1 AND ${scope}
           ORDER BY CASE WHEN embedding IS NULL THEN 1 ELSE 0 END, embedding <=> ${vectorParam}::vector
           LIMIT $${params.length}`,
          params,
        );
        return result.rows.map((row) => mapMemory(row));
      } catch {
        // Fall back to keyword search if the embedding dimension or extension is unavailable.
      }
    }
    const queryParams: unknown[] = [agentId];
    if (sessionId) queryParams.push(sessionId);
    queryParams.push(tokens);
    queryParams.push(patterns);
    queryParams.push(limit);
    const agentParamCount = sessionId ? 2 : 1;
    const result = await this.pool.query(
      `SELECT * FROM memories
       WHERE agent_id = $1 AND ${scope}
       AND ($${agentParamCount + 1}::text[] = '{}' OR keywords && $${agentParamCount + 1}::text[] OR content ILIKE ANY($${agentParamCount + 2}::text[]))
       ORDER BY importance DESC, updated_at DESC
       LIMIT $${agentParamCount + 3}`,
      queryParams,
    );
    return result.rows.map((row) => mapMemory(row));
  }

  async listMemories(agentId: string, sessionId?: string): Promise<MemoryRecord[]> {
    const result = sessionId
      ? await this.pool.query('SELECT * FROM memories WHERE agent_id = $1 AND (session_id IS NULL OR session_id = $2) ORDER BY updated_at DESC', [agentId, sessionId])
      : await this.pool.query('SELECT * FROM memories WHERE agent_id = $1 ORDER BY updated_at DESC', [agentId]);
    return result.rows.map((row) => mapMemory(row));
  }

  async deleteMemory(memoryId: string): Promise<void> {
    await this.pool.query('DELETE FROM memories WHERE id = $1', [memoryId]);
  }

  async logAttempt(attempt: ProviderAttempt): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_attempts(id, request_id, agent_id, session_id, provider, model, attempt_number, status, error_code, error_message, latency_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [attempt.id, attempt.requestId, attempt.agentId, attempt.sessionId ?? null, attempt.provider, attempt.model, attempt.attemptNumber, attempt.status, attempt.errorCode ?? null, attempt.errorMessage ?? null, attempt.latencyMs ?? null],
    );
  }

  async logUsage(event: UsageEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage_events(id, request_id, agent_id, session_id, provider, model, input_tokens, output_tokens, total_tokens, estimated_cost_usd)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [event.id, event.requestId, event.agentId, event.sessionId ?? null, event.provider, event.model, event.inputTokens ?? null, event.outputTokens ?? null, event.totalTokens ?? null, event.estimatedCostUsd ?? null],
    );
  }
}

export function createStore(databaseUrl?: string): Store {
  return databaseUrl ? new PostgresStore(databaseUrl) : new InMemoryStore();
}
