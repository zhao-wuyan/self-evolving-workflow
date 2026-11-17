import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InputError, pageOffset, pagination, requireText, searchLimit } from '../common.js';
import type { KnowledgeReads } from '../knowledge-reads.js';
import type { MemorySearchOptions } from '../memory.js';
import { exactMemoryValues } from '../memory-evidence.js';
import type { MemoryReader, MemorySearchResult } from '../memory-reader.js';
import { digest, downloadAsset, loadRelease, sha256 } from './assets.js';
import type { OpenVikingClient } from './client.js';
import type { OpenVikingProject, OpenVikingReadEvidence, ProjectManifest, SharedMemory } from './types.js';

export function remoteMemoryId(release: string, origin: string) { return `ov:${digest(release)}:${Buffer.from(origin).toString('base64url')}`; }
export function parseRemoteMemoryId(id: string) {
  const match = /^ov:([a-f0-9]{64}):([a-zA-Z0-9_-]+)$/.exec(id);
  if (!match) throw new InputError('OPENVIKING_MEMORY_ID_INVALID');
  const origin = Buffer.from(match[2], 'base64url').toString('utf8');
  if (remoteMemoryId(match[1], origin) !== id) throw new InputError('OPENVIKING_MEMORY_ID_INVALID');
  return { release: match[1], origin };
}
export class OpenVikingMemoryReader implements MemoryReader {
  private readonly reads: OpenVikingReadEvidence[] = [];
  constructor(private readonly root: string, private readonly client: OpenVikingClient, private readonly project: OpenVikingProject,
    readonly release: string, private readonly manifest: ProjectManifest, private readonly pinned: boolean) {}

  private async record(release: string, manifest: ProjectManifest, item: SharedMemory) {
    const file = manifest.files.find(file => file.path === item.path)!;
    const path = join(this.root, '.agent-memory', 'openviking', 'memory-cache', release, sha256(item.origin_id));
    let body: Buffer;
    let fetched: string;
    let via: 'network' | 'cache';
    if (existsSync(path)) {
      body = readFileSync(path);
      fetched = JSON.parse(readFileSync(path + '.json', 'utf8')).fetched_at;
      if (typeof fetched !== 'string' || !Number.isFinite(Date.parse(fetched))) throw new InputError('OPENVIKING_CACHE_CHANGED');
      via = 'cache';
    } else {
      await this.client.identity(this.project);
      body = await downloadAsset(this.client, this.project, file);
      fetched = new Date().toISOString(); via = 'network';
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path + '.json', JSON.stringify({ fetched_at: fetched })); writeFileSync(path, body);
    }
    if (body.length !== file.size || sha256(body) !== file.sha256 || !Buffer.from(body.toString('utf8')).equals(body)) {
      throw new InputError('OPENVIKING_ASSET_HASH_MISMATCH');
    }
    const id = remoteMemoryId(release, item.origin_id);
    this.reads.push({ record_id: id, origin_id: item.origin_id, release_id: release,
      uri: `${this.project.root_uri}/releases/${release}/${item.path}`, content_sha256: file.sha256, fetched_at: fetched, via });
    return { ...item.metadata, id, content: body.toString('utf8') };
  }
  async get(id: string, options: { knowledgeReads?: KnowledgeReads; fromSearchId?: string } = {}) {
    const parsed = parseRemoteMemoryId(id);
    if (this.pinned && parsed.release !== this.release) throw new InputError('OPENVIKING_READ_BINDING_MISMATCH');
    if (parsed.release !== this.release) await this.client.identity(this.project);
    const manifest = parsed.release === this.release ? this.manifest : await loadRelease(this.client, this.project, parsed.release);
    const entry = manifest.memory.find(item => item.origin_id === parsed.origin);
    if (!entry) return;
    const record = await this.record(parsed.release, manifest, entry);
    options.knowledgeReads?.recordRead({ kind: 'memory', id: record.id, content: record.content, version: record.version, fromSearchId: options.fromSearchId });
    return record;
  }
  async search(query: string, options: MemorySearchOptions = {}): Promise<MemorySearchResult> {
    const text = requireText(query, 'query');
    const limit = searchLimit(options.limit);
    const page = options.page ?? 1;
    const offset = pageOffset(page, limit);
    const filtered = this.manifest.memory.filter(item => (['type', 'scene', 'session'] as const).every(key =>
      options[key] === undefined || item.metadata[key] === options[key]));
    const exact = exactMemoryValues(text).includes(text);
    let candidates: Array<{ item: SharedMemory; score: number }>;
    if (exact) candidates = filtered.filter(item => item.metadata.exactValues?.includes(text)).sort((a, b) => a.origin_id.localeCompare(b.origin_id))
      .map(item => ({ item, score: 1 }));
    else {
      const target = `${this.project.root_uri}/releases/${this.release}/memory`;
      if (!this.manifest.memory.length) candidates = [];
      else {
        await this.client.identity(this.project);
        const allowed = new Map(filtered.map(item => [`${this.project.root_uri}/releases/${this.release}/${item.path}`, item]));
        const found = await this.client.find(text, target, Math.max(100, this.manifest.memory.length * 3));
        const seen = new Set<string>();
        candidates = found.flatMap(hit => {
          const item = allowed.get(hit.uri);
          if (!item || seen.has(hit.uri)) return [];
          seen.add(hit.uri); return [{ item, score: hit.score }];
        }).sort((a, b) => b.score - a.score || a.item.origin_id.localeCompare(b.item.origin_id));
      }
    }
    const hits: MemorySearchResult['results'] = [];
    let matched = 0;
    let hasNext = false;
    for (const candidate of candidates) {
      if (!exact && matched++ < offset) continue;
      if (!exact && hits.length === limit) { hasNext = true; break; }
      const evidenceOffset = this.reads.length;
      const record = await this.record(this.release, this.manifest, candidate.item);
      if (exact && (!exactMemoryValues(record.content).includes(text) || matched++ < offset)) {
        this.reads.length = evidenceOffset; continue;
      }
      if (hits.length === limit) { this.reads.length = evidenceOffset; hasNext = true; break; }
      hits.push({ ...record, score: candidate.score });
    }
    return { strategy: exact ? 'exact' : 'openviking', results: hits,
      ...(options.page === undefined ? {} : { pagination: pagination(page, limit, hasNext) }) };
  }
  drainRemoteReads() { return this.reads.splice(0); }
}
