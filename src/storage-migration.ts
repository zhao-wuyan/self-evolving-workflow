import { existsSync, mkdirSync, rmSync, linkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { evolveDir, InputError, LEGACY_AGENT_MEMORY_DIR, openDb, transaction } from './common.js';

const names = ['workflow.db', 'memory.db', 'closeout.db', 'orchestrator.db'] as const;
type DatabaseName = typeof names[number];
const workflowTables = [
  { name: 'sessions', keys: ['id'], columns: ['id', 'body'] },
  { name: 'requests', keys: ['session', 'id'], columns: ['session', 'id', 'fingerprint', 'receipt'] },
  { name: 'artifacts', keys: ['session', 'id'], columns: ['session', 'id', 'body'] },
  { name: 'native_closeouts', keys: ['receipt_id'], columns: ['receipt_id', 'session_id', 'project', 'receipt', 'state', 'attempts', 'last_error', 'updated_at'] },
] as const;

function tableExists(db: ReturnType<typeof openDb>, table: string, schema = 'main') {
  return Boolean(db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(table));
}

function checkDb(db: ReturnType<typeof openDb>, schema = 'main') {
  const rows = db.prepare(`PRAGMA ${schema}.quick_check`).all();
  if (rows.some(row => Object.values(row)[0] !== 'ok')) throw new InputError('SQLite integrity check failed: ' + schema);
}

function workflowMerge(target: string, legacy: string, apply: boolean) {
  const db = openDb(target, !apply);
  try {
    db.prepare('ATTACH DATABASE ? AS legacy').run(legacy);
    checkDb(db, 'main');
    checkDb(db, 'legacy');
    const merge = () => {
      const tables: Array<{ table: string; missing: number; conflicts: number }> = [];
      for (const table of workflowTables) {
        if (!tableExists(db, table.name, 'legacy')) continue;
        if (!tableExists(db, table.name)) throw new InputError('Target workflow schema lacks ' + table.name);
        const sameKey = table.keys.map(key => `a.${key} = b.${key}`).join(' AND ');
        const sameRow = table.columns.map(column => `a.${column} IS b.${column}`).join(' AND ');
        const conflicts = Number(db.prepare(`SELECT count(*) n FROM legacy.${table.name} b JOIN main.${table.name} a ON ${sameKey} WHERE NOT (${sameRow})`).get()?.n);
        const missing = Number(db.prepare(`SELECT count(*) n FROM legacy.${table.name} b WHERE NOT EXISTS (SELECT 1 FROM main.${table.name} a WHERE ${sameKey})`).get()?.n);
        tables.push({ table: table.name, missing, conflicts });
      }
      if (tables.some(table => table.conflicts)) {
        if (apply) throw new InputError('Conflicting workflow identities; no records merged');
        return { state: 'conflict', tables };
      }
      if (apply) {
        for (const table of workflowTables) {
          if (!tableExists(db, table.name, 'legacy')) continue;
          const columns = table.columns.join(', ');
          const sameKey = table.keys.map(key => `a.${key} = b.${key}`).join(' AND ');
          db.exec(`INSERT INTO main.${table.name} (${columns}) SELECT ${table.columns.map(column => 'b.' + column).join(', ')} FROM legacy.${table.name} b WHERE NOT EXISTS (SELECT 1 FROM main.${table.name} a WHERE ${sameKey})`);
        }
        if (db.prepare('PRAGMA main.foreign_key_check').all().length) throw new InputError('Workflow migration foreign-key check failed');
      }
      return { state: apply ? 'merged' : 'mergeable', tables };
    };
    return apply ? transaction(db, merge) : merge();
  } finally { db.close(); }
}

/** SQLite-native snapshot includes committed WAL data; publish only a complete checked copy.
 * The original legacy database is deliberately retained. */
function snapshot(legacy: string, target: string) {
  const tmp = target + '.' + randomUUID() + '.tmp';
  const db = openDb(legacy, true);
  try {
    checkDb(db);
    db.prepare('VACUUM INTO ?').run(tmp);
    const copy = openDb(tmp, true);
    try { checkDb(copy); } finally { copy.close(); }
    // Atomic creation without clobbering a concurrently created canonical DB.
    linkSync(tmp, target);
  } finally {
    db.close();
    rmSync(tmp, { force: true });
  }
}

/** Preview by default. Never merge incompatible memory keys or closeout ledgers blindly. */
export function migrateKnowledgeStorage(root: string, apply = false) {
  const canonical = evolveDir(root);
  const legacyDir = join(resolve(root), LEGACY_AGENT_MEMORY_DIR);
  const entries = names.map(name => ({
    name, legacy: join(legacyDir, name), target: join(canonical, name),
  })).filter(entry => entry.legacy !== entry.target && existsSync(entry.legacy));
  const inspect = (entry: { name: DatabaseName; legacy: string; target: string }, write: boolean) => {
    if (!existsSync(entry.target)) {
      if (write) snapshot(entry.legacy, entry.target);
      return { ...entry, state: write ? 'copied' : 'copyable' };
    }
    if (entry.name === 'workflow.db') return { ...entry, ...workflowMerge(entry.target, entry.legacy, write) };
    // Dual stores other than workflow have surrogate-key/ledger semantics. Verify the
    // canonical DB already contains the same legacy rows, or require a reviewed merge.
    return { ...entry, state: 'both-present', reason: 'Legacy retained; reconcile explicitly if canonical and legacy diverged' };
  };
  const preview = entries.map(entry => inspect(entry, false));
  if (!apply) return { applied: false, entries: preview };
  if (preview.some(entry => entry.state === 'conflict')) throw new InputError('Resolve workflow identity conflicts before applying storage migration');
  mkdirSync(canonical, { recursive: true });
  return { applied: true, entries: entries.map(entry => inspect(entry, true)) };
}
