import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InputError } from '../common.js';
import { MemoryStore, type MemoryRecord, type MemorySearchOptions } from '../memory.js';
import { Wiki, readWikiPages } from '../wiki.js';
import { downloadAsset, manifestBytes, sha256, stableJson } from './assets.js';
import type { OpenVikingClient } from './client.js';
import type { OpenVikingProject, ProjectManifest } from './types.js';
import type { KnowledgeReads } from '../knowledge-reads.js';
import type { MemoryReader } from '../memory-reader.js';
import { remoteMemoryId } from './memory.js';

export function frozenKnowledgeHash(snapshot: string) {
  const input = JSON.parse(readFileSync(join(snapshot, 'snapshot.json'), 'utf8')) as { ids: string[]; source_records: unknown[]; repository_id: string };
  const memory = new MemoryStore(join(snapshot, 'memory.db'), { readOnly: true });
  try {
    const records = input.ids.map(id => {
      const record = memory.get(id);
      if (!record) throw new InputError('OPENVIKING_FROZEN_KNOWLEDGE_CHANGED');
      return record;
    }).sort((a, b) => a.id.localeCompare(b.id));
    const wiki = readWikiPages(snapshot, true).map(page => [page.path, readFileSync(join(snapshot, page.path)).toString('base64')]).sort(([a], [b]) => a.localeCompare(b));
    return sha256(stableJson({ records, wiki, source_records: input.source_records, repository_id: input.repository_id }));
  } finally { memory.close(); }
}
export async function freezeKnowledge(destination: string, cache: string, client: OpenVikingClient, project: OpenVikingProject, manifest: ProjectManifest) {
  const receipt = join(destination, 'sha256');
  if (existsSync(receipt)) {
    const hash = readFileSync(receipt, 'utf8');
    if (frozenKnowledgeHash(destination) !== hash) throw new InputError('OPENVIKING_FROZEN_KNOWLEDGE_CHANGED');
    return { path: destination, hash };
  }
  const temporary = destination + '.preparing';
  if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  cpSync(join(cache, 'wiki', 'wiki'), join(temporary, 'wiki'), { recursive: true });
  new Wiki(temporary).build();
  const records = [];
  const release = sha256(manifestBytes(manifest));
  const store = new MemoryStore(join(temporary, 'memory.db'));
  try {
    for (const item of manifest.memory) {
      const file = manifest.files.find(file => file.path === item.path)!;
      const body = await downloadAsset(client, project, file);
      if (!Buffer.from(body.toString('utf8')).equals(body)) throw new InputError('OPENVIKING_MEMORY_INVALID_UTF8');
      records.push({ ...item.metadata, id: remoteMemoryId(release, item.origin_id), content: body.toString('utf8') });
    }
    await store.putMany(records);
  } finally { store.close(); }
  writeFileSync(join(temporary, 'snapshot.json'), stableJson({ ids: records.map(record => record.id), source_records: records, repository_id: project.project_id }));
  const hash = frozenKnowledgeHash(temporary);
  writeFileSync(join(temporary, 'sha256'), hash);
  mkdirSync(dirname(destination), { recursive: true }); renameSync(temporary, destination);
  return { path: destination, hash };
}

export class FrozenMemoryReader implements MemoryReader {
  private readonly store: MemoryStore;
  private readonly originals: Map<string, MemoryRecord>;
  constructor(snapshot: string, db?: string, namespace?: string) {
    if (frozenKnowledgeHash(snapshot) !== readFileSync(join(snapshot, 'sha256'), 'utf8')) throw new InputError('OPENVIKING_FROZEN_KNOWLEDGE_CHANGED');
    const input = JSON.parse(readFileSync(join(snapshot, 'snapshot.json'), 'utf8')) as { source_records: MemoryRecord[] };
    this.originals = new Map(input.source_records.map(record => [record.id, record]));
    this.store = new MemoryStore(db ?? join(snapshot, 'memory.db'), { namespace, readOnly: true });
  }
  get(id: string, options: { knowledgeReads?: KnowledgeReads; fromSearchId?: string } = {}) {
    const original = this.originals.get(id);
    if (!original) return;
    const stored = this.store.get(id);
    if (!stored || stored.content !== original.content) throw new InputError('OPENVIKING_FROZEN_KNOWLEDGE_CHANGED');
    options.knowledgeReads?.recordRead({ kind: 'memory', id, content: original.content, version: original.version, fromSearchId: options.fromSearchId });
    return { ...original };
  }
  async search(query: string, options?: MemorySearchOptions) {
    const result = await this.store.search(query, options);
    return { ...result, results: result.results.map(hit => ({ ...this.get(hit.id)!, score: hit.score })) };
  }
  close() { this.store.close(); }
}
