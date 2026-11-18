import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { AgentMemoryPrompt } from './agent-memory-prompts.js';
import {
  InputError, LEGACY_AGENT_MEMORY_DIR, openDb, pageOffset, pagination,
  requireText, resolveEvolveStorage, searchLimit, transaction,
} from './common.js';
import { exactMemoryValues, extractedMemoryId, groundMemories, type GroundedMemory, type MemorySource } from './memory-evidence.js';
import { formatEvidencePrompt, formatExtractionPrompt, getExtractMemoriesAgentPrompt } from './upstream/l1-extraction.js';
import { chatWithFormatRetry, extractJsonArray, type LlmClient } from './upstream/llm.js';
import { rrfMerge } from './upstream/search-utils.js';
import { bm25RankToScore, buildFtsQuery, tokenizeForFts } from './upstream/tokenize.js';
import type { KnowledgeReads } from './knowledge-reads.js';

export type { MemorySource } from './memory-evidence.js';

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  timestamp: number | string;
  content: string;
  location?: { path: string; byteOffset: number };
}

export interface MemoryInput {
  id?: string;
  content: string;
  type?: string;
  scene?: string;
  session?: string;
  priority?: number;
  sourceMessageIds?: string[];
  embedding?: ArrayLike<number>;
}

export interface MemoryRecord {
  id: string;
  content: string;
  type: string;
  scene: string;
  session: string;
  priority: number;
  sourceMessageIds: string[];
  exactValues?: string[];
  sourceMessageScope?: 'messages' | 'turn';
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** memory_history 中被覆盖或删除前的旧版本。 */
export interface MemoryHistoryRecord {
  id: string;
  version: number;
  content: string;
  type: string;
  scene: string;
  session: string;
  priority: number;
  sourceMessageIds: string[];
  updatedAt: string;
  archivedAt: string;
  reason: 'update' | 'delete';
}

export interface MemorySearchOptions {
  limit?: number;
  page?: number;
  type?: string;
  scene?: string;
  session?: string;
  embedding?: ArrayLike<number>;
}

export type MemoryListOptions = Pick<MemorySearchOptions, 'limit' | 'page' | 'type' | 'scene' | 'session'>;

export interface MemoryStoreOptions {
  namespace?: string;
  embed?: (text: string) => Promise<ArrayLike<number>>;
  readOnly?: boolean;
}

interface ExtractionOptions {
  llm: LlmClient;
  session: string;
  mode?: 'chat' | 'code';
  agentMemoryPrompt?: AgentMemoryPrompt;
  systemPrompt?: string;
}

type Row = Omit<MemoryRecord, 'sourceMessageIds' | 'exactValues' | 'sourceMessageScope'> & {
  sourceMessageIds: string;
  exactValues: string;
  sourceMessageScope: MemoryRecord['sourceMessageScope'] | null;
  vector: string | null;
};
type Hit = MemoryRecord & { score: number };
type StoredMemoryInput = MemoryInput & { evidence?: GroundedMemory['evidence']; exactValues?: string[] };

const recordFields = `m.id, m.content, m.type, m.scene, m.session, m.priority,
  m.source_ids AS sourceMessageIds, m.created_at AS createdAt, m.updated_at AS updatedAt, m.version,
  (SELECT json_group_array(value) FROM (SELECT value FROM memory_literals WHERE memory_key = m.key ORDER BY value)) AS exactValues,
  (SELECT scope FROM memory_sources WHERE memory_key = m.key) AS sourceMessageScope`;

function record(row: Row): MemoryRecord {
  const { vector, sourceMessageIds, exactValues, sourceMessageScope, ...fields } = row;
  const values = JSON.parse(exactValues) as string[];
  return { ...fields, sourceMessageIds: JSON.parse(sourceMessageIds),
    ...(values.length ? { exactValues: values } : {}), ...(sourceMessageScope ? { sourceMessageScope } : {}),
  };
}

function normalized(values: ArrayLike<number>): number[] {
  const vector = Array.from(values);
  let scale = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new InputError('embedding must contain finite numbers');
    scale = Math.max(scale, Math.abs(value));
  }
  if (scale === 0) {
    throw new InputError('embedding must be a non-zero vector of finite numbers');
  }
  const scaled = vector.map(value => value / scale);
  const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value ** 2, 0));
  return scaled.map(value => value / norm);
}

export function defaultMemoryDbPath(root: string): string {
  return resolveEvolveStorage(root, ['memory.db'], join(resolve(root), LEGACY_AGENT_MEMORY_DIR, 'memory.db'));
}

export class MemoryStore {
  private readonly db?: DatabaseSync;
  private readonly namespace: string;
  private readonly embed?: MemoryStoreOptions['embed'];
  private readonly readOnly: boolean;
  private tableNames?: Set<string>;

  constructor(path: string, options: MemoryStoreOptions = {}) {
    this.namespace = requireText(options.namespace ?? 'default', 'namespace');
    this.embed = options.embed;
    this.readOnly = Boolean(options.readOnly);
    const file = path === ':memory:' ? path : resolve(path);
    if (this.readOnly && file !== ':memory:') {
      if (!existsSync(file)) return;
      this.db = openDb(file, true);
      return;
    }
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = openDb(file);
    try {
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS memory_records (
          key INTEGER PRIMARY KEY,
          namespace TEXT NOT NULL,
          id TEXT NOT NULL,
          content TEXT NOT NULL,
          type TEXT NOT NULL,
          scene TEXT NOT NULL,
          session TEXT NOT NULL,
          priority INTEGER NOT NULL,
          source_ids TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          version INTEGER NOT NULL,
          vector TEXT,
          dimensions INTEGER,
          UNIQUE (namespace, id)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(tokens, tokenize='unicode61');
        CREATE TABLE IF NOT EXISTS memory_sources (
          memory_key INTEGER PRIMARY KEY REFERENCES memory_records(key) ON DELETE CASCADE,
          messages TEXT NOT NULL,
          scope TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_literals (
          memory_key INTEGER NOT NULL REFERENCES memory_records(key) ON DELETE CASCADE,
          value TEXT NOT NULL,
          PRIMARY KEY (memory_key, value)
        );
        CREATE INDEX IF NOT EXISTS memory_literals_value ON memory_literals (value, memory_key);
        CREATE TABLE IF NOT EXISTS memory_extraction_offsets (
          namespace TEXT NOT NULL,
          source TEXT NOT NULL,
          session TEXT NOT NULL,
          offset INTEGER NOT NULL,
          PRIMARY KEY (namespace, source, session)
        );
        CREATE TABLE IF NOT EXISTS memory_history (
          key INTEGER PRIMARY KEY,
          namespace TEXT NOT NULL,
          id TEXT NOT NULL,
          version INTEGER NOT NULL,
          content TEXT NOT NULL,
          type TEXT NOT NULL,
          scene TEXT NOT NULL,
          session TEXT NOT NULL,
          priority INTEGER NOT NULL,
          source_ids TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT NOT NULL,
          reason TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_history_record ON memory_history (namespace, id, key);
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private writableDb(): DatabaseSync {
    if (this.readOnly || !this.db) throw new InputError('Memory store is opened read-only');
    return this.db;
  }

  private hasTables(...names: string[]): boolean {
    if (!this.db) return false;
    if (!this.readOnly) return true;
    if (!this.tableNames) {
      const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      this.tableNames = new Set(rows.map(row => row.name));
    }
    return names.every(name => this.tableNames!.has(name));
  }

  close(): void {
    this.db?.close();
  }

  async put(input: MemoryInput): Promise<MemoryRecord> {
    return (await this.putMany([input]))[0];
  }

  async create(input: MemoryInput): Promise<MemoryRecord> {
    const id = requireText(input.id ?? randomUUID(), 'id');
    const db = this.writableDb();
    return (await this.writeMany([{ ...input, id }], () => {
      if (db.prepare('SELECT 1 FROM memory_records WHERE namespace = ? AND id = ?').get(this.namespace, id)) {
        throw new InputError(`Knowledge record already exists: ${id}`);
      }
      return true;
    }))![0];
  }

  async update(id: string, patch: Partial<Omit<MemoryInput, 'id'>>): Promise<MemoryRecord | undefined> {
    id = requireText(id, 'id');
    const db = this.writableDb();
    const select = db.prepare(`SELECT ${recordFields}, m.vector, m.key AS memoryKey, s.messages AS sourceMessages
      FROM memory_records m LEFT JOIN memory_sources s ON m.key = s.memory_key WHERE m.namespace = ? AND m.id = ?`);
    const stored = select.get(this.namespace, id) as (Row & { memoryKey: number; sourceMessages: string | null }) | undefined;
    if (!stored) return undefined;
    const snapshot = JSON.stringify(stored);
    const { memoryKey, sourceMessages, ...row } = stored;
    const current = record(row);
    const preserveSources = patch.sourceMessageIds === undefined;
    const evidence: GroundedMemory['evidence'] | undefined = preserveSources && sourceMessages !== null && current.sourceMessageScope
      ? { messages: JSON.parse(sourceMessages) as ConversationMessage[], scope: current.sourceMessageScope }
      : undefined;
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<Omit<MemoryInput, 'id'>>;
    const contentChanged = definedPatch.content !== undefined && definedPatch.content !== current.content;
    const embedding = definedPatch.embedding ?? (!contentChanged && typeof stored.vector === 'string'
      ? JSON.parse(stored.vector) as number[] : undefined);
    const exactValues = contentChanged || !preserveSources
      ? exactMemoryValues(definedPatch.content ?? current.content)
      : current.exactValues ?? exactMemoryValues(current.content);
    const updated = await this.writeMany([{
      ...current, ...definedPatch, id, embedding, exactValues, ...(evidence ? { evidence } : {}),
    }], () => {
      // 异步 embedding 期间，其他连接可能更新、删除或重建这条记录。
      const latest = select.get(this.namespace, id);
      if (!latest) return false;
      if (JSON.stringify(latest) !== snapshot) throw new InputError(`Memory record changed during update; retry: ${id}`);
      return true;
    });
    return updated?.[0];
  }

  async putMany(inputs: MemoryInput[]): Promise<MemoryRecord[]> {
    return (await this.writeMany(inputs))!;
  }

  private async writeMany(inputs: StoredMemoryInput[], advance?: () => boolean): Promise<MemoryRecord[] | undefined> {
    const db = this.writableDb();
    const prepared = await Promise.all(inputs.map(async input => {
      const content = requireText(input.content, 'content');
      const priority = input.priority ?? 50;
      if (!Number.isInteger(priority) || priority < -1 || priority > 100) {
        throw new InputError('priority must be an integer between -1 and 100');
      }
      const embedding = input.embedding ?? await this.embed?.(content);
      return {
        id: requireText(input.id ?? randomUUID(), 'id'), content, priority,
        type: requireText(input.type ?? 'episodic', 'type'),
        scene: input.scene ?? '', session: input.session ?? '',
        sourceIds: JSON.stringify(input.sourceMessageIds ?? []),
        evidence: input.evidence,
        exactValues: new Set(input.exactValues ?? (input.evidence?.messages ?? [{ content }]).flatMap(message => exactMemoryValues(message.content))),
        vector: embedding === undefined ? null : normalized(embedding),
      };
    }));
    const now = new Date().toISOString();
    return transaction(db, () => advance && !advance() ? undefined : prepared.map(input => {
      // 覆盖前保留旧版本正文，仅在内容性字段变化时归档（重新嵌入不产生历史）。
      this.archive(db, input.id, now, 'update', `AND (content, type, scene, session, priority, source_ids) IS NOT (?, ?, ?, ?, ?, ?)`,
        [input.content, input.type, input.scene, input.session, input.priority, input.sourceIds]);
      const row = db.prepare(`
        INSERT INTO memory_records (
          namespace, id, content, type, scene, session, priority, source_ids, created_at, updated_at, version, vector, dimensions
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (namespace, id) DO UPDATE SET
          content=excluded.content, type=excluded.type, scene=excluded.scene, session=excluded.session,
          priority=excluded.priority, source_ids=excluded.source_ids, updated_at=excluded.updated_at,
          version=memory_records.version+1, vector=excluded.vector, dimensions=excluded.dimensions
        WHERE (memory_records.content, memory_records.type, memory_records.scene, memory_records.session,
          memory_records.priority, memory_records.source_ids, memory_records.vector)
          IS NOT (excluded.content, excluded.type, excluded.scene, excluded.session,
          excluded.priority, excluded.source_ids, excluded.vector)
        RETURNING key
      `).get(this.namespace, input.id, input.content, input.type, input.scene, input.session,
        input.priority, input.sourceIds, now, now,
        input.vector && JSON.stringify(input.vector), input.vector?.length ?? null);
      const key = row?.key ?? (input.evidence && db.prepare('SELECT key FROM memory_records WHERE namespace = ? AND id = ?')
        .get(this.namespace, input.id)?.key);
      if (typeof key === 'number' && input.evidence) {
        const snapshots = input.evidence.messages.map(({ id, role, timestamp, content, location }) => ({
          id, role, timestamp, content, ...(location && { location }),
        }));
        db.prepare(`INSERT INTO memory_sources (memory_key, messages, scope) VALUES (?, ?, ?)
          ON CONFLICT (memory_key) DO UPDATE SET messages = excluded.messages, scope = excluded.scope`)
          .run(key, JSON.stringify(snapshots), input.evidence.scope);
      } else if (row) {
        db.prepare('DELETE FROM memory_sources WHERE memory_key = ?').run(Number(row.key));
      }
      if (typeof key === 'number') {
        db.prepare('DELETE FROM memory_literals WHERE memory_key = ?').run(key);
        const insert = db.prepare('INSERT INTO memory_literals (memory_key, value) VALUES (?, ?)');
        for (const value of input.exactValues) insert.run(key, value);
        db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(key);
        db.prepare('INSERT INTO memory_fts(rowid, tokens) VALUES (?, ?)').run(key, tokenizeForFts(input.content));
      }
      return this.get(input.id)!;
    }));
  }

  get(id: string, options: { knowledgeReads?: KnowledgeReads; fromSearchId?: string } = {}): MemoryRecord | undefined {
    if (!this.hasTables('memory_records', 'memory_literals', 'memory_sources')) return undefined;
    const row = this.db!.prepare(`SELECT ${recordFields} FROM memory_records m WHERE namespace = ? AND id = ?`)
      .get(this.namespace, id) as Row | undefined;
    const result = row && record(row);
    if (result && options.knowledgeReads) {
      options.knowledgeReads.recordRead({
        kind: 'memory', id: result.id, fromSearchId: options.fromSearchId,
        content: result.content, version: result.version,
      });
    }
    return result;
  }

  sources(id: string): MemorySource[] {
    if (!this.hasTables('memory_records', 'memory_sources')) return [];
    const row = this.db!.prepare(`SELECT m.session, s.messages FROM memory_records m
      JOIN memory_sources s ON m.key = s.memory_key WHERE m.namespace = ? AND m.id = ?`).get(this.namespace, id);
    if (!row) return [];
    return (JSON.parse(String(row.messages)) as ConversationMessage[]).map(message => ({ ...message, session: String(row.session) }));
  }

  delete(id: string): boolean {
    const db = this.writableDb();
    return transaction(db, () => {
      this.archive(db, id, new Date().toISOString(), 'delete');
      const row = db.prepare('DELETE FROM memory_records WHERE namespace = ? AND id = ? RETURNING key')
        .get(this.namespace, id);
      if (!row) return false;
      db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(Number(row.key));
      return true;
    });
  }

  /** 把当前版本复制到 memory_history（自增键，重建后的同号版本也不会互相覆盖）。 */
  private archive(db: DatabaseSync, id: string, archivedAt: string, reason: 'update' | 'delete', condition = '', args: SQLInputValue[] = []) {
    db.prepare(`INSERT INTO memory_history (
        namespace, id, version, content, type, scene, session, priority, source_ids, updated_at, archived_at, reason
      ) SELECT namespace, id, version, content, type, scene, session, priority, source_ids, updated_at, ?, ?
      FROM memory_records WHERE namespace = ? AND id = ? ${condition}`)
      .run(archivedAt, reason, this.namespace, id, ...args);
  }

  /** 按归档时间倒序返回旧版本（含已删除记录）。 */
  history(id: string): MemoryHistoryRecord[] {
    if (!this.hasTables('memory_history')) return [];
    const rows = this.db!.prepare(`SELECT id, version, content, type, scene, session, priority, source_ids, updated_at, archived_at, reason
      FROM memory_history WHERE namespace = ? AND id = ? ORDER BY key DESC`).all(this.namespace, id);
    return rows.map(row => ({
      id: String(row.id), version: Number(row.version), content: String(row.content), type: String(row.type),
      scene: String(row.scene), session: String(row.session), priority: Number(row.priority),
      sourceMessageIds: JSON.parse(String(row.source_ids)) as string[], updatedAt: String(row.updated_at),
      archivedAt: String(row.archived_at), reason: row.reason === 'delete' ? 'delete' : 'update',
    }));
  }

  private filterWhere(options: Pick<MemorySearchOptions, 'type' | 'scene' | 'session'>): {
    where: string;
    args: SQLInputValue[];
  } {
    const clauses = ['m.namespace = ?'];
    const args: SQLInputValue[] = [this.namespace];
    for (const field of ['type', 'scene', 'session'] as const) {
      if (options[field] !== undefined) {
        clauses.push(`m.${field} = ?`);
        args.push(options[field]);
      }
    }
    return { where: clauses.join(' AND '), args };
  }

  /**
   * 列出当前命名空间下满足过滤条件的工作记忆，按优先级和更新时间倒序排列。
   */
  list(options: Omit<MemorySearchOptions, 'embedding'> = {}) {
    const limit = searchLimit(options.limit);
    const page = options.page ?? 1;
    const offset = pageOffset(page, limit);
    const take = options.page === undefined ? limit : limit + 1;
    if (!this.hasTables('memory_records', 'memory_literals', 'memory_sources')) {
      return {
        results: [] as MemoryRecord[],
        ...(options.page !== undefined && { pagination: pagination(page, limit, false) }),
      };
    }
    const { where, args } = this.filterWhere(options);
    const rows = this.db!.prepare(`SELECT ${recordFields} FROM memory_records m WHERE ${where}
      ORDER BY m.priority DESC, m.updated_at DESC, m.id ASC LIMIT ? OFFSET ?`)
      .all(...args, take, offset) as Row[];
    return {
      results: rows.slice(0, limit).map(record),
      ...(options.page !== undefined && { pagination: pagination(page, limit, rows.length > limit) }),
    };
  }

  async search(query: string, options: MemorySearchOptions = {}) {
    const text = requireText(query, 'query');
    const limit = searchLimit(options.limit);
    const page = options.page ?? 1;
    const offset = pageOffset(page, limit);
    const take = options.page === undefined ? limit : limit + 1;
    const result = (strategy: 'exact' | 'fts' | 'embedding' | 'hybrid', hits: Hit[]) => ({
      strategy, results: hits.slice(0, limit),
      ...(options.page !== undefined && { pagination: pagination(page, limit, hits.length > limit) }),
    });
    const isExact = exactMemoryValues(text).includes(text);
    if (!this.hasTables('memory_records', 'memory_literals', 'memory_sources', 'memory_fts')) {
      return result(isExact ? 'exact' : 'fts', []);
    }
    const db = this.db!;
    const { where, args } = this.filterWhere(options);
    if (isExact) {
      const indexed = `FROM memory_literals l JOIN memory_records m ON m.key = l.memory_key WHERE l.value = ? AND ${where}`;
      const rows = db.prepare(`SELECT ${recordFields} ${indexed} ORDER BY m.id LIMIT ? OFFSET ?`)
        .all(text, ...args, take, offset) as Row[];
      const results = rows.map(row => ({ ...record(row), score: 1 }));
      // 旧条目仍可按其实际存储内容精确检索。
      if (results.length < take) {
        const indexedCount = offset && !rows.length
          ? Number(db.prepare(`SELECT count(*) AS count ${indexed}`).get(text, ...args)?.count) : offset;
        let skip = Math.max(0, offset - indexedCount);
        const legacy = db.prepare(`SELECT ${recordFields} FROM memory_records m
          WHERE ${where} AND instr(m.content, ?) > 0 AND NOT EXISTS
          (SELECT 1 FROM memory_sources WHERE memory_key = m.key) AND NOT EXISTS
          (SELECT 1 FROM memory_literals WHERE memory_key = m.key AND value = ?) ORDER BY m.id`).iterate(...args, text, text) as Iterable<Row>;
        for (const row of legacy) {
          if (!exactMemoryValues(row.content).includes(text)) continue;
          if (skip) { skip--; continue; }
          results.push({ ...record(row), score: 1 });
          if (results.length === take) break;
        }
      }
      return result('exact', results);
    }
    const embedding = options.embedding ?? await this.embed?.(text);
    const vector = embedding === undefined ? undefined : normalized(embedding);
    const expression = buildFtsQuery(text);
    // 分页时用完整候选集融合排名，页码改变时保持相同顺序。
    const candidates = vector ? options.page === undefined ? limit * 3 : -1 : take;
    const keyword: Hit[] = expression ? (db.prepare(`
      SELECT ${recordFields}, bm25(memory_fts) AS rank FROM memory_fts
      JOIN memory_records m ON m.key = memory_fts.rowid
      WHERE memory_fts MATCH ? AND ${where} ORDER BY rank, m.id LIMIT ? OFFSET ?
    `).all(expression, ...args, candidates, vector ? 0 : offset) as (Row & { rank: number })[]).map(({ rank, ...row }) => ({
      ...record(row), score: bm25RankToScore(rank),
    })) : [];
    const semantic: Hit[] = [];
    if (vector) {
      const statement = db.prepare(`
        SELECT ${recordFields}, m.vector FROM memory_records m WHERE ${where} AND m.dimensions = ? ORDER BY m.id
      `);
      for (const row of statement.iterate(...args, vector.length) as Iterable<Row>) {
        const other: number[] = JSON.parse(row.vector!);
        const score = vector.reduce((sum, value, i) => sum + value * other[i], 0);
        if (score > 0) semantic.push({ ...record(row), score });
      }
      semantic.sort((a, b) => b.score - a.score);
      if (candidates >= 0) semantic.length = Math.min(candidates, semantic.length);
    }
    if (keyword.length && semantic.length) {
      return result('hybrid', rrfMerge([keyword, semantic], item => item.id)
        .slice(offset, offset + take).map(({ rrfScore, ...item }) => ({ ...item, score: rrfScore })));
    }
    if (semantic.length) return result('embedding', semantic.slice(offset, offset + take));
    return result('fts', vector ? keyword.slice(offset, offset + take) : keyword);
  }

  async extract(messages: ConversationMessage[], options: ExtractionOptions): Promise<MemoryRecord[]> {
    if (this.readOnly) throw new InputError('Frozen knowledge is read-only');
    return (await this.writeMany(groundMemories(await extractMemoryInputs(messages, options), messages)))!;
  }

  extractionOffset(source: string, session: string): number {
    if (!this.hasTables('memory_extraction_offsets')) return 0;
    const row = this.db!.prepare(`SELECT offset FROM memory_extraction_offsets
      WHERE namespace = ? AND source = ? AND session = ?`).get(this.namespace, source, session);
    return Number(row?.offset ?? 0);
  }

  async extractIncremental(messages: ConversationMessage[], options: ExtractionOptions & {
    source: string;
    from: number;
    to: number;
  }): Promise<MemoryRecord[] | undefined> {
    const db = this.writableDb();
    const { source, session, from, to } = options;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
      throw new InputError('Invalid memory extraction offsets');
    }
    if (this.extractionOffset(source, session) !== from) return;
    const inputs = groundMemories(await extractMemoryInputs(messages, options), messages);
    return this.writeMany(inputs, () => {
      if (this.extractionOffset(source, session) !== from) return false;
      db.prepare(`INSERT INTO memory_extraction_offsets (namespace, source, session, offset) VALUES (?, ?, ?, ?)
        ON CONFLICT (namespace, source, session) DO UPDATE SET offset = excluded.offset`)
        .run(this.namespace, source, session, to);
      return true;
    });
  }
}

export async function extractMemoryInputs(messages: ConversationMessage[], options: ExtractionOptions): Promise<MemoryInput[]> {
  const session = requireText(options.session, 'session');
  if (!messages.length) return [];
  const ids = validateConversationMessages(messages);
  const agentMemoryPrompt = options.agentMemoryPrompt ?? getExtractMemoriesAgentPrompt(options.mode);
  const useL1Prompt = !options.systemPrompt && agentMemoryPrompt.kind === 'memory-extract';
  const prompt = useL1Prompt ? formatExtractionPrompt({ newMessages: messages }) : formatEvidencePrompt(messages);
  const formatHint = agentMemoryPrompt.kind === 'closeout-harvest'
    ? 'Return ONLY a JSON array shaped like [{"memories":[{"type":"work_method","content":"...","source_message_ids":["exact supplied ID"]}]}] or [].'
    : agentMemoryPrompt.kind === 'session-signal'
      ? 'Return ONLY a JSON array shaped like [{"memories":[{"type":"correction","content":"...","source_message_ids":["exact supplied ID"]}]}] or [].'
      : 'Return ONLY a JSON array shaped like [{"scene_name":"...","message_ids":["..."],"memories":[{"content":"...","type":"work_fact","source_message_ids":["..."]}]}].';
  return chatWithFormatRetry(
    options.llm,
    { system: options.systemPrompt ?? agentMemoryPrompt.system, prompt, label: agentMemoryPrompt.label },
    raw => parseExtraction(raw, session, ids),
    formatHint,
  );
}

export function validateConversationMessages(messages: readonly ConversationMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const id = requireText(message?.id, 'message id');
    if (ids.has(id)) throw new InputError(`Duplicate message id: ${id}`);
    if (!['user', 'assistant', 'system', 'tool'].includes(message.role) ||
        (typeof message.timestamp !== 'number' && typeof message.timestamp !== 'string') ||
        !Number.isFinite(new Date(message.timestamp).getTime())) {
      throw new InputError(`Invalid role or timestamp for message: ${id}`);
    }
    requireText(message.content, 'message content');
    if (id !== message.id) throw new InputError('message id cannot have surrounding whitespace');
    ids.add(id);
  }
  return ids;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label} in memory extraction response`);
  }
  return value as Record<string, unknown>;
}

function parseExtraction(raw: string, session: string, messageIds: Set<string>): MemoryInput[] {
  const items = extractJsonArray(raw, ['scenes', 'memories', 'items', 'results', 'data']);
  if (!items) throw new Error('Memory extraction response must contain a JSON array');
  // 小模型在 closeout/signal 场景可能省略外层 scene 包装而直接返回扁平记忆数组，这里统一归一。
  const scenes = items.length > 0 && items.every(item => {
    const record = object(item, 'scene');
    return record.memories === undefined && typeof record.content === 'string';
  }) ? [{ memories: items }] : items;
  const knownIds = (ids: unknown) => Array.isArray(ids)
    ? [...new Set(ids.map(String).filter(id => messageIds.has(id)))].sort()
    : [];
  return scenes.flatMap(value => {
    const scene = object(value, 'scene');
    if (!Array.isArray(scene.memories)) throw new Error('Memory extraction scene requires a memories array');
    return scene.memories.map(value => {
      const memory = object(value, 'memory');
      const content = requireText(memory.content, 'memory content');
      const type = requireText(memory.type ?? 'episodic', 'memory type');
      const cited = knownIds(memory.source_message_ids);
      const sourceMessageIds = cited.length ? cited : knownIds(scene.message_ids);
      const id = extractedMemoryId(session, type, content, sourceMessageIds);
      return {
        id, content, type, session, sourceMessageIds,
        scene: typeof scene.scene_name === 'string' ? scene.scene_name : '',
        priority: typeof memory.priority === 'number' ? memory.priority : undefined,
      };
    });
  });
}
