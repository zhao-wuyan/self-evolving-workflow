// Adapts TencentDB Agent Memory's MemoryKnowledge code graph bridge (MIT).
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, posix, resolve } from 'node:path';
import type { CodeGraph as Graph, Edge, IndexProgress, Node } from '@colbymchenry/codegraph';
import { DatabaseSync, InputError, NotFoundError, requireText, searchLimit } from './common.js';

const require = createRequire(import.meta.url);
const writes = new Map<string, Promise<unknown>>();
const PROGRESS_DELAY_MS = 2_000;
const PROGRESS_INTERVAL_MS = 5_000;
const LOCK_HEARTBEAT_MS = 30_000;
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_EMPTY_GRACE_MS = 1_000;
const WRITE_LOCK_WAIT_MS = 5_000;
const READ_LOCK_WAIT_MS = 200;
const PATH_SEARCH_INITIAL_LIMIT = 500;
export const AUTO_REFRESH_MAX_DB_BYTES = 100 * 1024 * 1024;
export const AUTO_REFRESH_MAX_FILES = 5_000;
export const AUTO_REFRESH_MAX_DIRTY_PATHS = 500;
export const EVOLVE_INTERNAL_CODE_PREFIXES = ['.evolve/', '.agent-memory/', '.workflow/'] as const;
const GIT_EXCLUDE_START = '# evolve:codegraph-ignore:start';
const GIT_EXCLUDE_END = '# evolve:codegraph-ignore:end';
const LOCK_ERROR_PATTERN = /file lock|locked by another|database is locked|SQLITE_BUSY|SQLITE_LOCKED|EBUSY|EPERM|resource busy/i;
const TRANSIENT_DB_PATTERN = /CodeGraph not initialized|Database not found|Invalid CodeGraph directory|unable to open database/i;

export class CodeIndexLockedError extends Error {}

interface ActiveLockHolder {
  pid: number | null;
  emptyFresh: boolean;
}

export function isCodeLockError(error: unknown): boolean {
  if (error instanceof CodeIndexLockedError) return true;
  if (error instanceof Error && error.name === 'LockUnavailableError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return LOCK_ERROR_PATTERN.test(message);
}

function sdk(): typeof import('@colbymchenry/codegraph') {
  return require('@colbymchenry/codegraph');
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function parseLockPid(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { pid?: unknown };
    if (typeof parsed?.pid === 'number' && Number.isInteger(parsed.pid)) return parsed.pid;
  } catch {
    const direct = Number.parseInt(trimmed, 10);
    if (Number.isInteger(direct) && direct > 0) return direct;
  }
  return null;
}

function readActiveLockHolder(lockPath: string, excludeSelf = false): ActiveLockHolder | null {
  if (!existsSync(lockPath)) return null;
  let lockAge: number;
  try {
    lockAge = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
  if (lockAge >= LOCK_STALE_MS) return null;
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  const pid = parseLockPid(raw);
  if (pid === null) {
    // 刚通过 wx 创建锁文件、尚未写入 PID 的极短窗口内，避免误删他人的新锁。
    return lockAge < LOCK_EMPTY_GRACE_MS ? { pid: null, emptyFresh: true } : null;
  }
  if (excludeSelf && pid === process.pid) return null;
  if (!isProcessAlive(pid)) return null;
  return { pid, emptyFresh: false };
}

function toCodeIndexLockedError(error: unknown, dir?: string): CodeIndexLockedError | null {
  if (error instanceof CodeIndexLockedError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (isCodeLockError(error)) return new CodeIndexLockedError(message);
  if (dir && TRANSIENT_DB_PATTERN.test(message)) {
    const active = readActiveLockHolder(join(dir, 'evolve-write.lock'))
      ?? readActiveLockHolder(join(dir, 'codegraph.lock'), true);
    if (active) {
      return new CodeIndexLockedError(
        active.pid
          ? `CodeGraph index is being updated by another process (PID ${active.pid})`
          : 'CodeGraph index is being updated by another process',
      );
    }
  }
  return null;
}

function createStderrProgress(label: string, custom?: (progress: IndexProgress) => void): {
  onProgress: (progress: IndexProgress) => void;
  finish: () => void;
} {
  const startTime = Date.now();
  let active = false;
  let lastPhase = '';
  let lastLogAt = 0;

  const emit = (line: string) => {
    process.stderr.write(`[evolve:code] ${line}\n`);
  };

  return {
    onProgress: (progress: IndexProgress) => {
      custom?.(progress);
      const now = Date.now();
      if (!active && now - startTime < PROGRESS_DELAY_MS) return;
      active = true;
      const phaseChanged = progress.phase !== lastPhase;
      if (!phaseChanged && now - lastLogAt < PROGRESS_INTERVAL_MS) return;
      lastPhase = progress.phase;
      lastLogAt = now;
      if (progress.total > 0) {
        const pct = Math.min(100, Math.floor((progress.current / progress.total) * 100));
        emit(`${label}: ${progress.phase} ${progress.current}/${progress.total} (${pct}%)`);
      } else if (progress.current > 0) {
        emit(`${label}: ${progress.phase} (${progress.current} files)`);
      } else {
        emit(`${label}: ${progress.phase}...`);
      }
    },
    finish: () => {
      if (!active) return;
      emit(`${label}: completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    },
  };
}

export function isInternalEvolveCodePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return EVOLVE_INTERNAL_CODE_PREFIXES.some(prefix =>
    normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
  );
}

function resolveGitDirForExcludes(root: string): string | null {
  const dotGit = join(root, '.git');
  if (!existsSync(dotGit)) return null;
  const stat = statSync(dotGit);
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  const match = /^gitdir:\s*(.+)$/im.exec(readFileSync(dotGit, 'utf8'));
  if (!match) return null;
  const target = match[1].trim();
  const gitDir = isAbsolute(target) ? target : resolve(root, target);
  return existsSync(gitDir) ? gitDir : null;
}

function ensureGitLocalExcludes(root: string): void {
  try {
    const gitDir = resolveGitDirForExcludes(root);
    if (!gitDir) return;
    const infoDir = join(gitDir, 'info');
    mkdirSync(infoDir, { recursive: true });
    const excludePath = join(infoDir, 'exclude');
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    const block = [GIT_EXCLUDE_START, ...EVOLVE_INTERNAL_CODE_PREFIXES, GIT_EXCLUDE_END].join('\n');
    const startIdx = existing.indexOf(GIT_EXCLUDE_START);
    const endIdx = startIdx >= 0 ? existing.indexOf(GIT_EXCLUDE_END, startIdx + GIT_EXCLUDE_START.length) : -1;
    let next: string;
    if (startIdx >= 0 && endIdx >= 0) {
      const currentBlock = existing.slice(startIdx, endIdx + GIT_EXCLUDE_END.length);
      if (currentBlock.replaceAll('\r\n', '\n') === block) return;
      next = `${existing.slice(0, startIdx)}${block}${existing.slice(endIdx + GIT_EXCLUDE_END.length)}`;
      if (!next.endsWith('\n')) next += '\n';
    } else if (existing.length === 0) {
      next = `${block}\n`;
    } else {
      const separator = existing.endsWith('\n') ? '' : '\n';
      next = `${existing}${separator}${block}\n`;
    }
    writeFileSync(excludePath, next, 'utf8');
  } catch {
    /* ignore */
  }
}

export function codeMatchesPaths(path: string, paths?: readonly string[]): boolean {
  if (!paths?.length) return true;
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return paths.some(value => {
    const pattern = requireText(value, 'path').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    return normalized === pattern || normalized.startsWith(`${pattern}/`) || posix.matchesGlob(normalized, pattern);
  });
}

interface BuildStateRecord {
  state: 'building' | 'ready';
  pid?: number;
  startedAt?: number;
  completedAt?: number;
}

interface SyncStateRecord {
  head: string;
  clean: boolean;
  updatedAt: number;
}

interface GitSnapshot {
  head: string;
  clean: boolean;
  dirtyCount: number;
}

export interface CodeGraphOptions {
  autoRefresh?: boolean;
  onProgress?: (progress: IndexProgress) => void;
  autoRefreshMaxDbBytes?: number;
  autoRefreshMaxFiles?: number;
  autoRefreshMaxDirtyPaths?: number;
}

export class CodeGraph {
  readonly root: string;
  private readonly autoRefresh: boolean;
  private readonly onProgress?: (progress: IndexProgress) => void;
  private readonly autoRefreshMaxDbBytes: number;
  private readonly autoRefreshMaxFiles: number;
  private readonly autoRefreshMaxDirtyPaths: number;

  constructor(
    root: string,
    {
      autoRefresh = false,
      onProgress,
      autoRefreshMaxDbBytes = AUTO_REFRESH_MAX_DB_BYTES,
      autoRefreshMaxFiles = AUTO_REFRESH_MAX_FILES,
      autoRefreshMaxDirtyPaths = AUTO_REFRESH_MAX_DIRTY_PATHS,
    }: CodeGraphOptions = {},
  ) {
    this.root = realpathSync(root);
    if (!statSync(this.root).isDirectory()) throw new InputError('Code root must be a directory');
    this.autoRefresh = autoRefresh;
    this.onProgress = onProgress;
    this.autoRefreshMaxDbBytes = autoRefreshMaxDbBytes;
    this.autoRefreshMaxFiles = autoRefreshMaxFiles;
    this.autoRefreshMaxDirtyPaths = autoRefreshMaxDirtyPaths;
  }

  static hasIndex(root: string): boolean {
    const resolved = existsSync(root) ? realpathSync(root) : root;
    return sdk().isInitialized(resolved);
  }

  static hasReadyIndex(root: string): boolean {
    const resolved = existsSync(root) ? realpathSync(root) : root;
    if (!sdk().isInitialized(resolved)) return false;
    const state = readJsonFile<BuildStateRecord>(join(sdk().getCodeGraphDir(resolved), 'evolve-build.json'));
    return state?.state !== 'building';
  }

  static hasActiveLock(root: string): boolean {
    try {
      const resolved = existsSync(root) ? realpathSync(root) : root;
      const dir = sdk().getCodeGraphDir(resolved);
      if (!existsSync(dir)) return false;
      return Boolean(
        readActiveLockHolder(join(dir, 'evolve-write.lock'))
        ?? readActiveLockHolder(join(dir, 'codegraph.lock'), true),
      );
    } catch {
      return false;
    }
  }

  async build() {
    return this.write(() => this.withCrossProcessWriteLock(WRITE_LOCK_WAIT_MS, async () => {
      const { CodeGraph: SdkGraph, isInitialized } = sdk();
      let recreated = false;
      let graph: Graph;
      if (isInitialized(this.root)) {
        try {
          graph = await SdkGraph.recreate(this.root);
          recreated = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/in use|EBUSY|EPERM/i.test(message)) throw error;
          graph = await SdkGraph.open(this.root);
        }
      } else {
        graph = SdkGraph.initSync(this.root);
        recreated = true;
      }
      try {
        const result = await this.completeFullIndex(graph, 'build');
        // Windows 下若因并发只读占用未能重建 DB，回退走增量扫描清理已删除文件。
        if (!recreated) await this.syncGraph(graph, 'sync');
        return { ...graph.getStats(), filesErrored: result.filesErrored, errors: result.errors };
      } finally {
        graph.close();
      }
    }));
  }

  async sync() {
    return this.write(() => this.withCrossProcessWriteLock(WRITE_LOCK_WAIT_MS, async () => {
      const { graph, created } = await this.openOrInitWritable();
      let active = graph;
      try {
        if (created || this.isIncompleteBuild(graph)) {
          if (!created) active = await this.recreateOrKeep(graph);
          const result = await this.completeFullIndex(active, 'build');
          return {
            filesChecked: result.filesIndexed + result.filesSkipped + result.filesErrored,
            filesAdded: result.filesIndexed,
            filesModified: 0,
            filesRemoved: 0,
            nodesUpdated: result.nodesCreated,
            durationMs: result.durationMs,
          };
        }
        return await this.syncGraph(active, 'sync');
      } finally {
        active.close();
      }
    }));
  }

  async refresh() {
    await this.write(() => this.withFreshGraphLocked(() => undefined, { waitMs: WRITE_LOCK_WAIT_MS, allowReadFallback: false }));
  }

  async search(query: string, limit?: number, options: { paths?: readonly string[] } = {}) {
    const text = requireText(query, 'query');
    const maxResults = searchLimit(limit);
    const allowInternal = Boolean(options.paths?.some(path => isInternalEvolveCodePath(path)));
    const keepHit = (filePath: string) =>
      (allowInternal || !isInternalEvolveCodePath(filePath)) && codeMatchesPaths(filePath, options.paths);
    return this.read(graph => {
      if (!options.paths?.length) {
        const batchLimit = Math.min(Math.max(maxResults * 4, 40), PATH_SEARCH_INITIAL_LIMIT);
        const initial = graph.searchNodes(text, { limit: batchLimit });
        return initial.filter(hit => keepHit(hit.node.filePath)).slice(0, maxResults);
      }
      // SDK 在候选截断后才筛路径；先做轻量批量召回，仅在结果被上限截断时按全表规模重召回。
      if (!/\b(?:path|name):/i.test(text)) {
        const batchLimit = Math.max(maxResults * 10, PATH_SEARCH_INITIAL_LIMIT);
        const initial = graph.searchNodes(text, { limit: batchLimit });
        if (initial.length < batchLimit) {
          return initial.filter(hit => keepHit(hit.node.filePath)).slice(0, maxResults);
        }
      }
      const candidates = graph.searchNodes(text, { limit: Math.max(1, this.countNodes()) });
      return candidates.filter(hit => keepHit(hit.node.filePath)).slice(0, maxResults);
    });
  }

  async neighbors(id: string, direction: 'callers' | 'callees', depth = 1) {
    if (direction !== 'callers' && direction !== 'callees') {
      throw new InputError('direction must be callers or callees');
    }
    if (!Number.isInteger(depth) || depth < 1 || depth > 5) {
      throw new InputError('depth must be an integer between 1 and 5');
    }
    return this.read(graph => {
      const resolved = this.resolveNodeId(graph, id);
      return direction === 'callers' ? graph.getCallers(resolved, depth) : graph.getCallees(resolved, depth);
    });
  }

  async trace(from: string, to: string, edgeKinds?: Edge['kind'][]) {
    return this.read(graph => {
      const resolvedFrom = this.resolveNodeId(graph, from);
      const resolvedTo = this.resolveNodeId(graph, to);
      return graph.findPath(resolvedFrom, resolvedTo, edgeKinds);
    });
  }

  async getSymbol(id: string) {
    return this.read(graph => {
      const resolved = this.resolveNodeId(graph, id);
      const node = graph.getNode(resolved)!;
      const file = join(this.root, node.filePath);
      let content = [node.signature, node.docstring].filter(Boolean).join('\n') || node.name;
      if (existsSync(file)) {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        const start = Math.max(0, node.startLine - 1);
        const end = Math.max(start + 1, node.endLine);
        const snippet = lines.slice(start, end).join('\n');
        if (snippet) content = snippet;
      }
      return {
        id: node.id,
        kind: node.kind,
        title: node.qualifiedName || node.name,
        path: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
        ...(node.signature ? { signature: node.signature } : {}),
        content,
      };
    });
  }

  private resolveNodeId(graph: Graph, id: string): string {
    if (graph.getNode(id)) return id;
    const prefix = /^([a-z_]+):([a-f0-9]{8,})$/i.exec(id);
    if (prefix) {
      const matches = this.findNodeIdsByPrefix(prefix[1], id.toLowerCase());
      if (matches.length > 1) throw new InputError(`Ambiguous code symbol ID prefix: ${id}`);
      if (matches.length === 1) return matches[0];
    }
    throw new NotFoundError(`Code symbol not found: ${id}`);
  }

  private findNodeIdsByPrefix(kind: string, lowerPrefix: string): string[] {
    const db = new DatabaseSync(sdk().getDatabasePath(this.root), { readOnly: true });
    try {
      const last = lowerPrefix.charCodeAt(lowerPrefix.length - 1);
      const upper = lowerPrefix.slice(0, -1) + String.fromCharCode(last + 1);
      const rows = db.prepare('SELECT id FROM nodes WHERE id >= ? AND id < ? LIMIT 2')
        .all(lowerPrefix, upper) as Array<{ id: string }>;
      if (rows.length > 0) return rows.map(row => row.id);
      const escaped = lowerPrefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
      const fallback = db.prepare("SELECT id FROM nodes WHERE kind = ? AND lower(id) LIKE ? ESCAPE '\\' LIMIT 2")
        .all(kind, `${escaped}%`) as Array<{ id: string }>;
      return fallback.map(row => row.id);
    } finally {
      db.close();
    }
  }

  private countNodes(): number {
    const db = new DatabaseSync(sdk().getDatabasePath(this.root), { readOnly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count?: number } | undefined;
      return Number(row?.count ?? 0);
    } finally {
      db.close();
    }
  }

  private codeGraphDir(): string {
    return sdk().getCodeGraphDir(this.root);
  }

  private writeBuildState(record: BuildStateRecord) {
    const dir = this.codeGraphDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'evolve-build.json'), JSON.stringify(record));
  }

  private hasIncompleteMarker(): boolean {
    const state = readJsonFile<BuildStateRecord>(join(this.codeGraphDir(), 'evolve-build.json'));
    return state?.state === 'building';
  }

  private isIncompleteBuild(graph: Graph): boolean {
    if (this.hasIncompleteMarker()) return true;
    const { version } = graph.getIndexBuildInfo();
    return version === null && graph.getStats().fileCount > 0;
  }

  private gitSnapshot(): GitSnapshot | null {
    if (!existsSync(join(this.root, '.git'))) return null;
    if (existsSync(join(this.root, 'codegraph.json')) || existsSync(join(this.root, '.gitmodules'))) return null;
    try {
      const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: this.root,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }).trim();
      if (!head) return null;
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: this.root,
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const dirtyCount = status.split(/\r?\n/).filter(line => line.trim().length > 0).length;
      return { head, clean: dirtyCount === 0, dirtyCount };
    } catch {
      return null;
    }
  }

  private gitDirtyPathCount(): number {
    if (!existsSync(join(this.root, '.git'))) return 0;
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: this.root,
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      return status.split(/\r?\n/).filter(line => line.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  private saveSyncState(before: GitSnapshot | null) {
    const after = before ? this.gitSnapshot() : null;
    const clean = Boolean(before?.clean && after?.clean && before.head === after.head);
    const head = after?.head ?? before?.head;
    if (!head) {
      rmSync(join(this.codeGraphDir(), 'evolve-sync.json'), { force: true });
      return;
    }
    const record: SyncStateRecord = { head, clean, updatedAt: Date.now() };
    writeFileSync(join(this.codeGraphDir(), 'evolve-sync.json'), JSON.stringify(record));
  }

  private canSkipCleanSync(): boolean {
    if (this.hasIncompleteMarker()) return false;
    const saved = readJsonFile<SyncStateRecord>(join(this.codeGraphDir(), 'evolve-sync.json'));
    if (!saved?.clean || !saved.head) return false;
    const current = this.gitSnapshot();
    return Boolean(current?.clean && current.head === saved.head);
  }

  private async completeFullIndex(graph: Graph, label: string) {
    ensureGitLocalExcludes(this.root);
    const before = this.gitSnapshot();
    this.writeBuildState({ state: 'building', pid: process.pid, startedAt: Date.now() });
    const result = await this.indexAll(graph, label);
    this.writeBuildState({ state: 'ready', completedAt: Date.now() });
    this.saveSyncState(before);
    return result;
  }

  private async indexAll(graph: Graph, label = 'build') {
    const reporter = createStderrProgress(label, this.onProgress);
    let result;
    try {
      result = await graph.indexAll({ onProgress: reporter.onProgress });
    } finally {
      reporter.finish();
    }
    if (!result.success) {
      const message = result.errors.map(error => error.message).join('\n') || 'Code indexing failed';
      if (/file lock|locked by another/i.test(message)) throw new CodeIndexLockedError(message);
      throw new Error(message);
    }
    return result;
  }

  private async syncGraph(graph: Graph, label = 'sync') {
    ensureGitLocalExcludes(this.root);
    const before = this.gitSnapshot();
    const reporter = createStderrProgress(label, this.onProgress);
    // SDK 拿不到文件锁时会直接返回空结果，扫描回调用于区分正常空项目。
    let started = false;
    let result;
    try {
      result = await graph.sync({
        onProgress: progress => {
          started = true;
          reporter.onProgress(progress);
        },
      });
    } finally {
      reporter.finish();
    }
    if (!started) throw new CodeIndexLockedError('CodeGraph index is locked by another process');
    this.saveSyncState(before);
    return result;
  }

  private isActivelyBuilding(dir: string): boolean {
    const state = readJsonFile<BuildStateRecord>(join(dir, 'evolve-build.json'));
    if (state?.state !== 'building' || typeof state.pid !== 'number' || !isProcessAlive(state.pid)) return false;
    return readActiveLockHolder(join(dir, 'evolve-write.lock')) !== null
      || (typeof state.startedAt === 'number' && Date.now() - state.startedAt < LOCK_STALE_MS);
  }

  private openReadOnlyGraph(): Graph {
    const { CodeGraph: SdkGraph } = sdk();
    try {
      return SdkGraph.openSync(this.root, { readOnly: true });
    } catch (error) {
      if (toCodeIndexLockedError(error, this.codeGraphDir())) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (existsSync(sdk().getDatabasePath(this.root))
        && /SQLITE_CANTOPEN|SQLITE_READONLY|readonly|unable to open database/i.test(message)) {
        return SdkGraph.openSync(this.root);
      }
      throw error;
    }
  }

  private autoRefreshDeferralReason(): string | null {
    try {
      const dbBytes = statSync(sdk().getDatabasePath(this.root)).size;
      if (dbBytes >= this.autoRefreshMaxDbBytes) {
        return `index size ${(dbBytes / (1024 * 1024)).toFixed(0)} MB >= ${(this.autoRefreshMaxDbBytes / (1024 * 1024)).toFixed(0)} MB`;
      }
    } catch { /* ignore */ }
    const dirtyCount = this.gitDirtyPathCount();
    if (dirtyCount > 0 && dirtyCount >= this.autoRefreshMaxDirtyPaths) {
      return `${dirtyCount} uncommitted paths >= ${this.autoRefreshMaxDirtyPaths}`;
    }
    return null;
  }

  private async read<T>(run: (graph: Graph) => T | Promise<T>): Promise<T> {
    if (!this.autoRefresh) return this.withReadOnlyGraph(run);
    if (sdk().isInitialized(this.root) && !this.hasIncompleteMarker()) {
      const cleanSkip = this.canSkipCleanSync();
      let deferReason = cleanSkip ? null : this.autoRefreshDeferralReason();
      if (cleanSkip || deferReason !== null || this.autoRefreshMaxFiles > 0) {
        let graph: Graph | null = null;
        let ready = false;
        try {
          graph = this.openReadOnlyGraph();
          const incomplete = this.isIncompleteBuild(graph);
          const fileCount = incomplete ? 0 : graph.getStats().fileCount;
          if (!incomplete && (cleanSkip || fileCount > 0)) {
            if (!cleanSkip && deferReason === null && fileCount >= this.autoRefreshMaxFiles) {
              deferReason = `${fileCount} indexed files >= ${this.autoRefreshMaxFiles}`;
            }
            ready = cleanSkip || deferReason !== null;
          }
        } catch (error) {
          if (cleanSkip) throw toCodeIndexLockedError(error, this.codeGraphDir()) ?? error;
          // 快路径/降级检查失败时回退到受锁同步路径（含锁冲突快照降级）。
        }
        if (graph && ready) {
          if (!cleanSkip && deferReason) {
            console.warn(`[evolve:code] Skipping auto-refresh (${deferReason}); querying existing snapshot. Run "evolve code sync" to refresh.`);
          }
          try {
            return await run(graph);
          } catch (error) {
            throw toCodeIndexLockedError(error, this.codeGraphDir()) ?? error;
          } finally {
            graph.close();
          }
        }
        graph?.close();
      }
    }
    return this.write(() => this.withFreshGraphLocked(run, { waitMs: READ_LOCK_WAIT_MS, allowReadFallback: true }));
  }

  private async withReadOnlyGraph<T>(run: (graph: Graph) => T | Promise<T>): Promise<T> {
    const { isInitialized } = sdk();
    if (!isInitialized(this.root)) {
      throw new NotFoundError('Code index missing. Run code build first.');
    }
    let graph: Graph;
    try {
      graph = this.openReadOnlyGraph();
    } catch (error) {
      throw toCodeIndexLockedError(error, this.codeGraphDir()) ?? error;
    }
    try {
      return await run(graph);
    } catch (error) {
      throw toCodeIndexLockedError(error, this.codeGraphDir()) ?? error;
    } finally {
      graph.close();
    }
  }

  private async openOrInitWritable(): Promise<{ graph: Graph; created: boolean }> {
    const { CodeGraph: SdkGraph, isInitialized } = sdk();
    if (!isInitialized(this.root)) {
      mkdirSync(this.codeGraphDir(), { recursive: true });
      return { graph: SdkGraph.initSync(this.root), created: true };
    }
    return { graph: await SdkGraph.open(this.root), created: false };
  }

  private async recreateOrKeep(existing: Graph): Promise<Graph> {
    existing.close();
    const { CodeGraph: SdkGraph } = sdk();
    try {
      return await SdkGraph.recreate(this.root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/in use|EBUSY|EPERM/i.test(message)) throw error;
      return await SdkGraph.open(this.root);
    }
  }

  private async withFreshGraphLocked<T>(
    run: (graph: Graph) => T | Promise<T>,
    options: { waitMs: number; allowReadFallback: boolean },
  ): Promise<T> {
    const dir = this.codeGraphDir();
    const fallbackReadOnly = async (reason: CodeIndexLockedError): Promise<T> => {
      if (!options.allowReadFallback || !sdk().isInitialized(this.root)) throw reason;
      let graph: Graph;
      try {
        graph = this.openReadOnlyGraph();
      } catch (error) {
        throw toCodeIndexLockedError(error, dir) ?? error;
      }
      try {
        if (graph.getStats().fileCount <= 0) throw reason;
        console.warn(`[evolve:code] ${reason.message}; querying existing snapshot.`);
        return await run(graph);
      } catch (error) {
        throw toCodeIndexLockedError(error, dir) ?? error;
      } finally {
        graph.close();
      }
    };

    if (options.allowReadFallback && existsSync(dir)) {
      const sdkHolder = readActiveLockHolder(join(dir, 'codegraph.lock'), true);
      if (sdkHolder) {
        return fallbackReadOnly(new CodeIndexLockedError(
          sdkHolder.pid
            ? `CodeGraph index is locked by another process (PID ${sdkHolder.pid})`
            : 'CodeGraph index is locked by another process',
        ));
      }
      if (this.isActivelyBuilding(dir)) {
        const writeHolder = readActiveLockHolder(join(dir, 'evolve-write.lock'));
        return fallbackReadOnly(new CodeIndexLockedError(
          writeHolder?.pid
            ? `CodeGraph index is being built by another process (PID ${writeHolder.pid})`
            : 'CodeGraph index is being built by another process',
        ));
      }
    }

    try {
      return await this.withCrossProcessWriteLock(options.waitMs, async () => {
        const { graph, created } = await this.openOrInitWritable();
        let active = graph;
        try {
          if (created || this.isIncompleteBuild(graph)) {
            if (!created) active = await this.recreateOrKeep(graph);
            await this.completeFullIndex(active, 'build');
          } else {
            await this.syncGraph(active, 'sync');
          }
          return await run(active);
        } catch (error) {
          const lockError = toCodeIndexLockedError(error, dir);
          if (lockError && options.allowReadFallback && active.getStats().fileCount > 0) {
            console.warn(`[evolve:code] ${lockError.message}; querying existing snapshot.`);
            return await run(active);
          }
          throw lockError ?? error;
        } finally {
          active.close();
        }
      });
    } catch (error) {
      const lockError = toCodeIndexLockedError(error, dir);
      if (lockError) return fallbackReadOnly(lockError);
      throw error;
    }
  }

  private async withCrossProcessWriteLock<T>(waitMs: number, run: () => Promise<T>): Promise<T> {
    const dir = this.codeGraphDir();
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, 'evolve-write.lock');
    const sdkLockPath = join(dir, 'codegraph.lock');
    const deadline = Date.now() + waitMs;
    let acquired = false;

    while (!acquired) {
      const sdkHolder = readActiveLockHolder(sdkLockPath, true);
      if (sdkHolder) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new CodeIndexLockedError(
            sdkHolder.pid
              ? `CodeGraph index is locked by another process (PID ${sdkHolder.pid})`
              : 'CodeGraph index is locked by another process',
          );
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
        continue;
      }
      try {
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' });
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
        const writeHolder = readActiveLockHolder(lockPath);
        if (!writeHolder) {
          try {
            rmSync(lockPath, { force: true });
          } catch { /* ignore */ }
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new CodeIndexLockedError(
            writeHolder.pid
              ? `CodeGraph index is locked by another process (PID ${writeHolder.pid})`
              : 'CodeGraph index is locked by another process',
          );
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
      }
    }

    // 长耗时建库期间定期续期锁文件 mtime，避免外部 CodeGraph FileLock 超过 2 分钟误抢锁。
    const heartbeat = setInterval(() => {
      const now = new Date();
      try {
        utimesSync(lockPath, now, now);
      } catch { /* ignore */ }
      try {
        if (existsSync(sdkLockPath) && readFileSync(sdkLockPath, 'utf8').trim() === String(process.pid)) {
          utimesSync(sdkLockPath, now, now);
        }
      } catch { /* ignore */ }
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      const sdkHolder = readActiveLockHolder(sdkLockPath, true);
      if (sdkHolder) {
        throw new CodeIndexLockedError(
          sdkHolder.pid
            ? `CodeGraph index is locked by another process (PID ${sdkHolder.pid})`
            : 'CodeGraph index is locked by another process',
        );
      }
      return await run();
    } finally {
      clearInterval(heartbeat);
      try {
        if (existsSync(lockPath) && parseLockPid(readFileSync(lockPath, 'utf8')) === process.pid) {
          rmSync(lockPath, { force: true });
        }
      } catch { /* ignore */ }
    }
  }

  private async write<T>(run: () => Promise<T>): Promise<T> {
    const previous = writes.get(this.root) ?? Promise.resolve();
    const current = previous.then(run, run);
    writes.set(this.root, current);
    try {
      return await current;
    } finally {
      if (writes.get(this.root) === current) writes.delete(this.root);
    }
  }
}
