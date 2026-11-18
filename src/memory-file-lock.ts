import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { InputError, openDb, transaction } from './common.js';

export interface MemoryFileLock { path: string; contents: string }

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    if (errorCode(error) === 'EPERM') return true;
    throw error;
  }
}

/** 仅保护短同步文件操作；action 不得返回 Promise，也不能跨越模型或网络等待。 */
export function withMemoryFileTransaction<T>(path: string, action: () => T): T {
  const directory = dirname(resolve(path));
  mkdirSync(directory, { recursive: true });
  const db = openDb(join(realpathSync(directory), '.memory-file-locks.db'));
  try { return transaction(db, action); }
  finally { db.close(); }
}

export function tryMemoryFileLock(path: string): MemoryFileLock | undefined {
  path = resolve(path);
  return withMemoryFileTransaction(path, () => {
    const contents = JSON.stringify({ pid: process.pid, token: randomUUID() });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(path, 'wx');
        try { writeFileSync(fd, contents); } finally { closeSync(fd); }
        return { path, contents };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      const previous = readText(path);
      if (previous === undefined) continue;
      let pid: unknown;
      try { pid = (JSON.parse(previous) as { pid?: unknown }).pid; }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
        if (processExists(pid)) return;
      } else {
        // 兼容旧版进程尚未写完或已遗留的空锁。
        const info = statSync(path, { throwIfNoEntry: false });
        if (!info) continue;
        if (Date.now() - info.mtimeMs < 5_000) return;
      }
      // 比较、回收和下一次创建始终处于同一个跨进程事务中。
      if (readText(path) === previous) rmSync(path, { force: true });
    }
  });
}

export function releaseMemoryFileLock(lock: MemoryFileLock): void {
  withMemoryFileTransaction(lock.path, () => {
    if (readText(lock.path) !== lock.contents) throw new InputError(`Hook lock ownership changed: ${lock.path}`);
    rmSync(lock.path);
  });
}
