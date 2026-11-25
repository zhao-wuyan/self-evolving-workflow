import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { evolvePath, InputError } from './common.js';
import type { MemoryHost } from './memory-config.js';
import { releaseMemoryFileLock, tryMemoryFileLock, type MemoryFileLock } from './memory-file-lock.js';

export interface MemoryHookJob {
  schema_version: 'memory-hook-job/1.0';
  id: string;
  root: string;
  host: MemoryHost;
  session: string;
  transcript_path: string;
  event: unknown;
  fingerprint: string;
  generation: number;
  state: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  created_at: string;
  updated_at: string;
  last_error?: string;
  db?: string;
  namespace?: string;
}

interface HookTarget { session: string; path: string }
interface HookStorage { db?: string; namespace?: string }

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

/** 单个完整 JSON 对象足够确认输入边界，不等待宿主关闭管道。 */
export function readMemoryHookInput(
  input: Readable = process.stdin, options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<unknown> {
  const { timeoutMs = 5_000, maxBytes = 4 * 1024 * 1024 } = options;
  return new Promise((accept, reject) => {
    const decoder = new StringDecoder('utf8');
    let text = '';
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.pause();
      // 每次 hook 仅消费一个事件；关闭本进程读端，释放宿主仍开启的管道句柄。
      input.destroy();
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const parse = (ended: boolean) => {
      let value: unknown;
      try {
        value = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch (error) {
        if (!(error instanceof SyntaxError)) { fail(error instanceof Error ? error : new Error(String(error))); return; }
        if (ended) fail(new InputError('Hook stdin must contain one complete JSON object'));
        return;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(new InputError('Hook stdin must contain a JSON object'));
        return;
      }
      cleanup();
      accept(value);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      if (size > maxBytes) { fail(new InputError(`Hook input exceeds ${maxBytes} bytes`)); return; }
      text += decoder.write(bytes);
      parse(false);
    };
    const onEnd = () => { text += decoder.end(); parse(true); };
    const onError = (error: Error) => fail(error);
    const timer = setTimeout(() => fail(new InputError(`Hook input did not contain complete JSON within ${timeoutMs} ms`)), timeoutMs);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.resume();
  });
}

export function memoryHookJobsPath(root: string): string {
  return evolvePath(root, 'hook-jobs');
}

function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
}

function readJob(path: string): MemoryHookJob | undefined {
  const text = readText(path);
  if (text === undefined) return;
  let job: MemoryHookJob;
  try { job = JSON.parse(text) as MemoryHookJob; }
  catch (error) { throw new InputError(`Invalid hook job ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (job?.schema_version !== 'memory-hook-job/1.0' || !/^[a-f0-9]{64}$/.test(job.id) ||
      !['pending', 'running', 'done', 'failed'].includes(job.state) ||
      !['codex', 'claude', 'agy'].includes(job.host) || typeof job.session !== 'string' ||
      !Number.isSafeInteger(job.generation) || job.generation < 1) {
    throw new InputError(`Invalid hook job metadata: ${path}`);
  }
  return job;
}

export function readMemoryHookJobs(root: string): MemoryHookJob[] {
  const directory = memoryHookJobsPath(root);
  let names: string[];
  try { names = readdirSync(directory); }
  catch (error) { if (errorCode(error) === 'ENOENT') return []; throw error; }
  return names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
    const job = readJob(join(directory, name));
    return job ? [job] : [];
  }).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export function hasPendingMemoryHookJobs(root: string): boolean {
  return readMemoryHookJobs(root).some(job => job.state === 'pending' || job.state === 'running');
}

function writeJob(root: string, job: MemoryHookJob): void {
  const directory = memoryHookJobsPath(root);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(job, null, 2) + '\n', { flag: 'wx' });
    renameSync(temporary, join(directory, `${job.id}.json`));
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function withJobLock<T>(root: string, id: string, action: () => T): Promise<T> {
  const path = join(memoryHookJobsPath(root), `${id}.lock`);
  const deadline = Date.now() + 2_000;
  let lock: MemoryFileLock | undefined;
  while (!(lock = tryMemoryFileLock(path))) {
    if (Date.now() >= deadline) throw new InputError(`Hook job is busy: ${id}`);
    await delay(10);
  }
  try { return action(); } finally { releaseMemoryFileLock(lock); }
}

export async function enqueueMemoryHook(
  root: string, host: MemoryHost, event: unknown, target: HookTarget, storage: HookStorage = {},
): Promise<{ job: MemoryHookJob; queued: boolean }> {
  root = realpathSync(root);
  const id = createHash('sha256').update(JSON.stringify([root, host, target.session])).digest('hex');
  const info = statSync(target.path, { throwIfNoEntry: false });
  const fingerprint = createHash('sha256').update(JSON.stringify({
    event, path: target.path, size: info?.size, mtime: info?.mtimeMs, ...storage,
  })).digest('hex');
  return withJobLock(root, id, () => {
    const previous = readJob(join(memoryHookJobsPath(root), `${id}.json`));
    if (previous?.fingerprint === fingerprint && previous.state !== 'failed') return { job: previous, queued: false };
    const now = new Date().toISOString();
    const job: MemoryHookJob = {
      schema_version: 'memory-hook-job/1.0', id, root, host, session: target.session,
      transcript_path: target.path, event, fingerprint, generation: (previous?.generation ?? 0) + 1,
      state: 'pending', attempts: previous?.attempts ?? 0,
      created_at: previous?.created_at ?? now, updated_at: now, ...storage,
    };
    writeJob(root, job);
    return { job, queued: true };
  });
}

export async function retryMemoryHookJobs(root: string, id?: string): Promise<number> {
  if (id !== undefined && !/^[a-f0-9]{64}$/.test(id)) throw new InputError('Expected an exact hook job ID');
  const jobs = readMemoryHookJobs(root).filter(job => job.state === 'failed' && (id === undefined || job.id === id));
  let retried = 0;
  for (const job of jobs) await withJobLock(root, job.id, () => {
    const current = readJob(join(memoryHookJobsPath(root), `${job.id}.json`));
    if (current?.state !== 'failed') return;
    writeJob(root, { ...current, state: 'pending', generation: current.generation + 1, updated_at: new Date().toISOString() });
    retried++;
  });
  return retried;
}

export async function startMemoryHookWorker(root: string, hasCloseouts = false): Promise<{ started: boolean; pid?: number }> {
  if (!hasPendingMemoryHookJobs(root) && !hasCloseouts) return { started: false };
  const child = spawn(process.execPath, [fileURLToPath(new URL('./workflow-cli.js', import.meta.url)),
    'kb', 'hook-worker', '--root', realpathSync(root)], {
    cwd: root, detached: true, windowsHide: true, stdio: 'ignore',
  });
  await once(child, 'spawn');
  child.unref();
  return { started: true, pid: child.pid };
}

export async function drainMemoryHookJobs(root: string, processJob: (job: MemoryHookJob) => Promise<unknown>) {
  root = realpathSync(root);
  let processed = 0;
  let failed = 0;
  const lockPath = join(memoryHookJobsPath(root), 'worker.lock');
  do {
    const lock = tryMemoryFileLock(lockPath);
    if (!lock) return { processed, failed, already_running: true };
    try {
      let pending = readMemoryHookJobs(root).filter(job => job.state === 'pending' || job.state === 'running');
      while (pending.length) {
        for (const entry of pending) {
          const job = await withJobLock(root, entry.id, () => {
            const current = readJob(join(memoryHookJobsPath(root), `${entry.id}.json`));
            if (!current || (current.state !== 'pending' && current.state !== 'running')) return;
            const next: MemoryHookJob = { ...current, state: 'running', attempts: current.attempts + 1, updated_at: new Date().toISOString() };
            writeJob(root, next);
            return next;
          });
          if (!job) continue;
          let lastError: string | undefined;
          try { await processJob(job); processed++; }
          catch (error) { lastError = error instanceof Error ? error.message : String(error); failed++; }
          await withJobLock(root, job.id, () => {
            const current = readJob(join(memoryHookJobsPath(root), `${job.id}.json`));
            if (!current || current.generation !== job.generation) return;
            const { last_error: previousError, ...rest } = current;
            writeJob(root, { ...rest, state: lastError === undefined ? 'done' : 'failed',
              ...(lastError === undefined ? {} : { last_error: lastError }), updated_at: new Date().toISOString() });
          });
        }
        pending = readMemoryHookJobs(root).filter(job => job.state === 'pending' || job.state === 'running');
      }
    } finally {
      releaseMemoryFileLock(lock);
    }
    // 新事件可能在最后一次扫描与释放锁之间到达，释放后必须再检查一次。
  } while (hasPendingMemoryHookJobs(root));
  return { processed, failed, already_running: false };
}
