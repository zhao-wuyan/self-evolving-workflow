import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InputError } from './common.js';
import { MemoryStore } from './memory.js';
import type { MemoryReader } from './memory-reader.js';
import { Wiki } from './wiki.js';
import { readEvolveSessions } from './workflow-runtime.js';
import { readProject } from './openviking/config.js';
import { isUnavailable, OpenVikingClient } from './openviking/client.js';
import { loadRelease, readProjectHead, sha256, validateManifest } from './openviking/assets.js';
import { cacheRelease } from './openviking/knowledge.js';
import { OpenVikingMemoryReader } from './openviking/memory.js';
import { appendRemoteReads, readRemoteReceipt } from './openviking/evidence.js';
import { FrozenMemoryReader } from './openviking/frozen.js';
import type { MemorySearchOptions } from './memory.js';
import type { KnowledgeReads } from './knowledge-reads.js';
import { contentSha256 } from './knowledge-reads.js';

export function knowledgeSourceFingerprint(root: string) {
  const config = process.env.EVOLVE_OPENVIKING_CONFIG;
  return contentSha256(JSON.stringify([resolve(root), readProject(root), process.env.AGENT_MEMORY_DB,
    process.env.EVOLVE_KNOWLEDGE_SNAPSHOT, config, config && existsSync(config) ? readFileSync(config, 'utf8') : undefined]));
}

export interface KnowledgeBackend { configured: 'local' | 'openviking'; active: 'local' | 'openviking' | 'cache'; fallback_reason?: string }

class FallbackMemoryReader implements MemoryReader {
  private local?: MemoryStore;
  constructor(private readonly remote: MemoryReader, private readonly openLocal: () => MemoryStore, private readonly backend: KnowledgeBackend) {}
  async search(query: string, options?: MemorySearchOptions) {
    if (this.local) return this.local.search(query, options);
    try { return await this.remote.search(query, options); }
    catch (error) {
      if (!isUnavailable(error)) throw error;
      this.backend.active = 'local'; this.backend.fallback_reason = error instanceof Error ? error.message : 'OPENVIKING_UNAVAILABLE';
      console.warn('OpenViking unavailable; using local Memory: ' + this.backend.fallback_reason);
      return (this.local ??= this.openLocal()).search(query, options);
    }
  }
  async get(id: string, options?: { knowledgeReads?: KnowledgeReads; fromSearchId?: string }) {
    // 远端 ID 绝不映射到本地同名正文；只允许已验证缓存或明确失败。
    if (id.startsWith('ov:')) return this.remote.get(id, options);
    this.backend.active = 'local';
    return (this.local ??= this.openLocal()).get(id, options);
  }
  close() { this.local?.close(); this.remote.close?.(); }
  drainRemoteReads() { return this.remote.drainRemoteReads?.() ?? []; }
}

export interface KnowledgeSources {
  wiki: Wiki; memory?: MemoryReader; releaseId?: string; repositoryId?: string; backend?: KnowledgeBackend;
}
export async function openKnowledgeSources(root: string, options: {
  session?: string; db?: string; namespace?: string; wikiRoot?: string; traceFile?: string;
  memoryBackend?: 'local' | 'openviking'; includeMemory: boolean; releaseId?: string; pinMemory?: boolean;
}): Promise<KnowledgeSources> {
  const frozen = process.env.EVOLVE_KNOWLEDGE_SNAPSHOT;
  if (frozen) return { wiki: new Wiki(frozen), repositoryId: JSON.parse(readFileSync(join(frozen, 'snapshot.json'), 'utf8')).repository_id,
    ...(options.includeMemory ? { memory: new FrozenMemoryReader(frozen, process.env.AGENT_MEMORY_DB, options.namespace) } : {}) };
  const project = readProject(root);
  const session = options.session ? readEvolveSessions(root, options.session)[0] : undefined;
  if (project && project.enabled !== false && options.session && !session) throw new InputError('Evolve Session not found: ' + options.session);
  const sidecar = options.traceFile ? options.traceFile + '.openviking.json' : undefined;
  const receipt = sidecar ? readRemoteReceipt(sidecar) : undefined;
  const local = (fallback?: string): KnowledgeSources => ({
    wiki: new Wiki(options.wikiRoot ?? root),
    ...(options.includeMemory ? { memory: new MemoryStore(options.db ?? join(root, '.agent-memory', 'memory.db'), { namespace: options.namespace }) } : {}),
    backend: { configured: project?.enabled === false || !project ? 'local' : 'openviking', active: 'local', ...(fallback ? { fallback_reason: fallback } : {}) },
  });
  if (session && !session.openviking) return local();
  if (!project || project.enabled === false && !session?.openviking && !receipt || options.memoryBackend === 'local' && !session?.openviking && !receipt) {
    if (options.memoryBackend === 'openviking' && !project) throw new InputError('OPENVIKING_PROJECT_REQUIRED');
    return local();
  }
  if (session?.openviking && (session.openviking.phase !== 'ready' || session.openviking.project_id !== project.project_id)) {
    throw new InputError('OPENVIKING_ASSETS_NOT_READY');
  }
  if (receipt && (receipt.project_id !== project.project_id || session?.openviking && receipt.release_id !== session.openviking.release_id)) {
    throw new InputError('OPENVIKING_READ_BINDING_MISMATCH');
  }
  if (options.releaseId && session?.openviking && options.releaseId !== session.openviking.release_id) {
    throw new InputError('OPENVIKING_READ_BINDING_MISMATCH');
  }
  const pinnedRelease = session?.openviking?.release_id ?? receipt?.release_id ?? options.releaseId;
  try {
    const client = new OpenVikingClient(project.enabled === false);
    const release = pinnedRelease ?? (await readProjectHead(client, project)).head.release_id;
    const cacheScope = session?.openviking || options.pinMemory ? 'all' : 'wiki';
    const cached = join(root, '.agent-memory', 'openviking', cacheScope === 'all' ? 'releases' : 'wiki-releases', release, 'manifest.json');
    let manifest;
    if (pinnedRelease && existsSync(cached)) {
      const raw = readFileSync(cached);
      if (sha256(raw) !== release) throw new InputError('OPENVIKING_CACHE_CHANGED');
      manifest = validateManifest(JSON.parse(raw.toString('utf8')), project);
    } else {
      if (pinnedRelease) await client.identity(project);
      manifest = await loadRelease(client, project, release);
    }
    const cache = await cacheRelease(root, client, project, release, manifest, cacheScope);
    if (sidecar && !receipt) appendRemoteReads(sidecar, project.project_id, release);
    const wikiRoot = join(cache, 'wiki');
    if (options.wikiRoot && resolve(options.wikiRoot) !== resolve(wikiRoot)) throw new InputError('OPENVIKING_WIKI_ROOT_PINNED');
    const backend: KnowledgeBackend = { configured: 'openviking', active: pinnedRelease && existsSync(cached) ? 'cache' : 'openviking' };
    const openLocal = () => new MemoryStore(options.db ?? join(root, '.agent-memory', 'memory.db'), { namespace: options.namespace });
    let memory: MemoryReader | undefined;
    if (options.includeMemory) {
      memory = options.memoryBackend === 'local' ? openLocal() : new OpenVikingMemoryReader(root, client, project, release, manifest, Boolean(options.session || sidecar || options.pinMemory));
      if (options.memoryBackend !== 'local' && (project.enabled === false || project.failure_policy !== 'fail')) memory = new FallbackMemoryReader(memory, openLocal, backend);
    }
    return { wiki: new Wiki(wikiRoot), ...(memory ? { memory } : {}), releaseId: release, repositoryId: project.project_id, backend };
  } catch (error) {
    if (pinnedRelease || project.failure_policy === 'fail' || options.memoryBackend === 'openviking' || !isUnavailable(error)) throw error;
    const reason = error instanceof Error ? error.message : 'OPENVIKING_UNAVAILABLE';
    console.warn('OpenViking unavailable; using local knowledge: ' + reason);
    return local(reason);
  }
}
