import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabaseSync } from 'node:sqlite';

export const EVOLVE_DIR = '.evolve';
export const LEGACY_AGENT_MEMORY_DIR = '.agent-memory';

/**
 * 解析项目的 `.evolve` 包裹目录。若目标目录本身已名为 `.evolve`（如全局 `~/.evolve`），则直接返回以避免双重嵌套。
 */
export function evolveDir(root: string): string {
  const resolved = resolve(root);
  return basename(resolved) === EVOLVE_DIR ? resolved : join(resolved, EVOLVE_DIR);
}

/**
 * 拼接项目 `.evolve/` 目录下的子路径。
 */
export function evolvePath(root: string, ...segments: string[]): string {
  return join(evolveDir(root), ...segments);
}

/**
 * 优先使用 `.evolve/` 下的新路径；若新路径尚不存在而旧路径已存在，则兼容回退到旧路径。
 */
export function resolveEvolveStorage(root: string, segments: string[], legacyPath?: string): string {
  const target = evolvePath(root, ...segments);
  if (existsSync(target)) return target;
  if (legacyPath && existsSync(legacyPath)) return legacyPath;
  return target;
}

function loadDatabaseSync(): typeof SqliteDatabaseSync {
  const originalEmitWarning = process.emitWarning;
  // 仅在首次加载 node:sqlite 时屏蔽其 ExperimentalWarning，避免污染 stderr 或外层 JSON 解析。
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning?.message;
    const type = typeof args[0] === 'string'
      ? args[0]
      : (args[0] as { type?: string } | undefined)?.type ?? (warning as { name?: string })?.name;
    if (type === 'ExperimentalWarning' && message?.includes('SQLite')) return;
    return (originalEmitWarning as (...params: unknown[]) => void).apply(process, [warning, ...args]);
  }) as typeof process.emitWarning;
  try {
    const require = createRequire(import.meta.url);
    return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

type BunSqlite = { Database: new (path: string, options: { readonly: boolean; create: boolean; strict: boolean }) => SqliteDatabaseSync };
function loadDatabaseConstructor(): new (path: string, options?: { readOnly?: boolean }) => SqliteDatabaseSync {
  if (!process.versions.bun) return loadDatabaseSync();
  const { Database }: BunSqlite = createRequire(import.meta.url)('bun:sqlite');
  return class extends Database {
    constructor(path: string, { readOnly = false } = {}) {
      super(path, { readonly: readOnly, create: !readOnly, strict: true });
    }
  };
}
export const DatabaseSync = loadDatabaseConstructor();

export class InputError extends Error {}
export class NotFoundError extends Error {}

export function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InputError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function searchLimit(limit = 10): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new InputError('limit must be an integer between 1 and 100');
  }
  return limit;
}

export function pageOffset(page: number, limit: number): number {
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(offset + limit)) {
    throw new InputError('page must be a positive integer with a supported offset');
  }
  return offset;
}

export function pagination(page: number, limit: number, hasNext: boolean) {
  return { page, limit, previousPage: page > 1 ? page - 1 : null, nextPage: hasNext ? page + 1 : null };
}

export function openDb(path: string, readOnly = false): SqliteDatabaseSync {
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (!readOnly) db.exec('PRAGMA journal_mode = WAL');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function transaction<T>(db: SqliteDatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
