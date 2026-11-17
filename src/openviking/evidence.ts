import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InputError } from '../common.js';
import type { KnowledgeReadsReceipt } from '../knowledge-reads.js';
import { workflowRecord } from '../workflow-skills.js';
import { readProject, replaceJson } from './config.js';
import { digest, sha256, validateManifest } from './assets.js';
import { parseRemoteMemoryId } from './memory.js';
import type { OpenVikingReadEvidence, RemoteReadReceipt } from './types.js';

export function readRemoteReceipt(path: string): RemoteReadReceipt | undefined {
  if (!existsSync(path)) return;
  const item = workflowRecord(JSON.parse(readFileSync(path, 'utf8')), 'remote reads');
  if (item.schema_version !== 'openviking-reads/1.0' || typeof item.project_id !== 'string' || !Array.isArray(item.reads)) {
    throw new InputError('OPENVIKING_READ_RECEIPT_INVALID');
  }
  digest(item.release_id);
  for (const input of item.reads) {
    const evidence = workflowRecord(input, 'remote read evidence');
    if (typeof evidence.record_id !== 'string' || typeof evidence.origin_id !== 'string' || typeof evidence.uri !== 'string' ||
        typeof evidence.fetched_at !== 'string' || !Number.isFinite(Date.parse(evidence.fetched_at)) || !['network', 'cache'].includes(String(evidence.via))) {
      throw new InputError('OPENVIKING_READ_RECEIPT_INVALID');
    }
    const parsed = parseRemoteMemoryId(evidence.record_id);
    if (parsed.release !== item.release_id || parsed.origin !== evidence.origin_id || evidence.release_id !== item.release_id) {
      throw new InputError('OPENVIKING_READ_BINDING_MISMATCH');
    }
    digest(evidence.content_sha256);
  }
  return item as unknown as RemoteReadReceipt;
}
export function appendRemoteReads(path: string, project: string, release: string, reads: OpenVikingReadEvidence[] = []) {
  const raw = existsSync(path) ? readFileSync(path) : undefined;
  const previous = readRemoteReceipt(path);
  if (previous && (previous.project_id !== project || previous.release_id !== release)) throw new InputError('OPENVIKING_READ_BINDING_MISMATCH');
  const receipt: RemoteReadReceipt = { schema_version: 'openviking-reads/1.0', project_id: project, release_id: release, reads: [...previous?.reads ?? [], ...reads] };
  replaceJson(path, raw, receipt);
  return receipt;
}
export function validateRemoteReads(reads: OpenVikingReadEvidence[], release: string, knowledge: KnowledgeReadsReceipt | undefined, root?: string) {
  const project = root ? readProject(root) : undefined;
  const raw = root ? readFileSync(join(root, '.agent-memory', 'openviking', 'releases', release, 'manifest.json')) : undefined;
  if (raw && sha256(raw) !== release) throw new InputError('OPENVIKING_CACHE_CHANGED');
  const manifest = raw && project ? validateManifest(JSON.parse(raw.toString('utf8')), project) : undefined;
  for (const evidence of reads) {
    const parsed = parseRemoteMemoryId(evidence.record_id);
    if (parsed.release !== release || evidence.release_id !== release || parsed.origin !== evidence.origin_id ||
        !knowledge?.searches.some(search => search.source === 'memory' && search.returned_ids.includes(evidence.record_id)) &&
        !knowledge?.reads.some(read => read.kind === 'memory' && read.id === evidence.record_id)) throw new InputError('OPENVIKING_READ_BINDING_MISMATCH');
    const read = knowledge?.reads.find(item => item.id === evidence.record_id && item.kind === 'memory');
    if (read && read.content_sha256 !== 'sha256:' + evidence.content_sha256) throw new InputError('OPENVIKING_READ_HASH_MISMATCH');
    if (manifest && project) {
      const item = manifest.memory.find(item => item.origin_id === evidence.origin_id);
      const file = manifest.files.find(file => file.path === item?.path);
      if (!item || evidence.uri !== `${project.root_uri}/releases/${release}/${item.path}` || file?.sha256 !== evidence.content_sha256) {
        throw new InputError('OPENVIKING_READ_HASH_MISMATCH');
      }
    }
  }
}
