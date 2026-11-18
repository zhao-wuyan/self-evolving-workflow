import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { LEGACY_AGENT_MEMORY_DIR, openDb, resolveEvolveStorage, transaction } from '../common.js';
import type { AgentSessionRecord, AgentSessionStatus } from './types.js';

export function orchestratorDbPath(root: string): string {
  return resolveEvolveStorage(root, ['orchestrator.db'], join(resolve(root), LEGACY_AGENT_MEMORY_DIR, 'orchestrator.db'));
}

export class AgentSessionStore {
  private db?: DatabaseSync;
  readonly dbPath: string;

  constructor(rootOrDbPath: string, options: { isFilePath?: boolean } = {}) {
    this.dbPath = options.isFilePath || rootOrDbPath === ':memory:'
      ? rootOrDbPath
      : orchestratorDbPath(rootOrDbPath);
  }

  private ensureDb(): DatabaseSync {
    if (this.db) return this.db;
    if (this.dbPath !== ':memory:') {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    const db = openDb(this.dbPath);
    db.exec([
      'CREATE TABLE IF NOT EXISTS agent_sessions (',
      '  id TEXT PRIMARY KEY,',
      '  provider TEXT NOT NULL,',
      '  status TEXT NOT NULL,',
      '  cwd TEXT NOT NULL,',
      '  body TEXT NOT NULL,',
      '  updated_at TEXT NOT NULL',
      ') STRICT;',
    ].join('\n'));
    this.db = db;
    return db;
  }

  private tryOpenReadOnly(): DatabaseSync | undefined {
    if (this.db) return this.db;
    if (this.dbPath === ':memory:' || !existsSync(this.dbPath)) return undefined;
    return this.ensureDb();
  }

  save(record: AgentSessionRecord): AgentSessionRecord {
    const db = this.ensureDb();
    transaction(db, () => {
      db.prepare([
        'INSERT INTO agent_sessions (id, provider, status, cwd, body, updated_at)',
        'VALUES (?, ?, ?, ?, ?, ?)',
        'ON CONFLICT(id) DO UPDATE SET',
        '  provider = excluded.provider,',
        '  status = excluded.status,',
        '  cwd = excluded.cwd,',
        '  body = excluded.body,',
        '  updated_at = excluded.updated_at',
      ].join(' ')).run(
        record.id,
        record.provider,
        record.status,
        record.cwd,
        JSON.stringify(record),
        record.updatedAt,
      );
    });
    return record;
  }

  get(id: string): AgentSessionRecord | undefined {
    const db = this.tryOpenReadOnly();
    if (!db) return undefined;
    const row = db.prepare('SELECT body FROM agent_sessions WHERE id = ?').get(id) as { body?: string } | undefined;
    return row?.body ? JSON.parse(row.body) as AgentSessionRecord : undefined;
  }

  list(filter: { provider?: string; status?: AgentSessionStatus } = {}): AgentSessionRecord[] {
    const db = this.tryOpenReadOnly();
    if (!db) return [];
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.provider) {
      clauses.push('provider = ?');
      params.push(filter.provider);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = db.prepare(`SELECT body FROM agent_sessions${where} ORDER BY updated_at DESC, id ASC`).all(...params) as Array<{ body: string }>;
    return rows.map(row => JSON.parse(row.body) as AgentSessionRecord);
  }

  delete(id: string): boolean {
    const db = this.tryOpenReadOnly();
    if (!db) return false;
    return transaction(db, () => {
      const result = db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }
}
