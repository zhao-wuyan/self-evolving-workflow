// Adapts TencentDB Agent Memory's MemoryKnowledge code graph bridge (MIT).
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';
import type { CodeGraph as Graph, Edge } from '@colbymchenry/codegraph';
import { InputError, NotFoundError, requireText, searchLimit } from './common.js';

const require = createRequire(import.meta.url);
const writes = new Map<string, Promise<unknown>>();

function sdk(): typeof import('@colbymchenry/codegraph') {
  return require('@colbymchenry/codegraph');
}

export function codeMatchesPaths(path: string, paths?: readonly string[]): boolean {
  if (!paths?.length) return true;
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return paths.some(value => {
    const pattern = requireText(value, 'path').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    return normalized === pattern || normalized.startsWith(`${pattern}/`) || posix.matchesGlob(normalized, pattern);
  });
}

export class CodeGraph {
  readonly root: string;
  private readonly autoRefresh: boolean;

  constructor(root: string, { autoRefresh = false }: { autoRefresh?: boolean } = {}) {
    this.root = realpathSync(root);
    if (!statSync(this.root).isDirectory()) throw new InputError('Code root must be a directory');
    this.autoRefresh = autoRefresh;
  }

  static hasIndex(root: string): boolean {
    return sdk().isInitialized(root);
  }

  async build() {
    return this.write(() => this.withGraph(async (graph, created) => {
      const result = await this.indexAll(graph);
      // SDK 全量索引会保留已删除文件的节点，复用增量扫描对齐文件系统。
      if (!created) await this.syncGraph(graph);
      return { ...graph.getStats(), filesErrored: result.filesErrored, errors: result.errors };
    }, true));
  }

  async sync() {
    return this.write(() => this.withGraph(graph => this.syncGraph(graph)));
  }

  async refresh() {
    await this.withFreshGraph(() => undefined);
  }

  async search(query: string, limit?: number, options: { paths?: readonly string[] } = {}) {
    const text = requireText(query, 'query');
    const maxResults = searchLimit(limit);
    return this.read(graph => {
      if (!options.paths?.length) return graph.searchNodes(text, { limit: maxResults });
      // SDK 在候选截断后才筛路径，需召回完整候选后再应用路径与数量限制。
      const candidates = graph.searchNodes(text, { limit: Math.max(1, graph.getStats().nodeCount) });
      return candidates.filter(hit => codeMatchesPaths(hit.node.filePath, options.paths)).slice(0, maxResults);
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
      this.requireNode(graph, id);
      return direction === 'callers' ? graph.getCallers(id, depth) : graph.getCallees(id, depth);
    });
  }

  async trace(from: string, to: string, edgeKinds?: Edge['kind'][]) {
    return this.read(graph => {
      this.requireNode(graph, from);
      this.requireNode(graph, to);
      return graph.findPath(from, to, edgeKinds);
    });
  }

  private requireNode(graph: Graph, id: string) {
    if (!graph.getNode(id)) throw new NotFoundError(`Code symbol not found: ${id}`);
  }

  private async indexAll(graph: Graph) {
    const result = await graph.indexAll();
    if (!result.success) throw new Error(result.errors.map(error => error.message).join('\n') || 'Code indexing failed');
    return result;
  }

  private async syncGraph(graph: Graph) {
    // SDK 拿不到文件锁时会直接返回空结果，扫描回调用于区分正常空项目。
    let started = false;
    const result = await graph.sync({ onProgress: () => { started = true; } });
    if (!started) throw new Error('CodeGraph index is locked by another process');
    return result;
  }

  private read<T>(run: (graph: Graph) => T | Promise<T>): Promise<T> {
    return this.autoRefresh ? this.withFreshGraph(run) : this.withGraph(run);
  }

  private withFreshGraph<T>(run: (graph: Graph) => T | Promise<T>): Promise<T> {
    return this.write(() => this.withGraph(async (graph, created) => {
      if (created) await this.indexAll(graph);
      else await this.syncGraph(graph);
      return run(graph);
    }, true));
  }

  private async withGraph<T>(run: (graph: Graph, created: boolean) => T | Promise<T>, initialize = false): Promise<T> {
    const { CodeGraph, FileLock, getCodeGraphDir, isInitialized } = sdk();
    let created: Graph | undefined;
    if (initialize) {
      const dir = getCodeGraphDir(this.root);
      mkdirSync(dir, { recursive: true });
      // 数据库创建用独立短锁，索引和增量同步由 SDK 自己加锁。
      created = new FileLock(join(dir, 'evolve-init.lock')).withLock(() =>
        isInitialized(this.root) ? undefined : CodeGraph.initSync(this.root));
    } else if (!isInitialized(this.root)) {
      throw new NotFoundError('Code index missing. Run code build first.');
    }
    const graph = created ?? await CodeGraph.open(this.root);
    try {
      return await run(graph, created !== undefined);
    } finally {
      graph.close();
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
