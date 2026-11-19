import { createHash } from 'node:crypto';
import { InputError } from '../common.js';
import { isProjectSkillPath, workflowPath, workflowRecord } from '../workflow-skills.js';
import { validateProject } from './config.js';
import { ensureDirectory, isMissing, OpenVikingClient, OpenVikingError } from './client.js';
import type { AssetFile, OpenVikingProject, ProjectHead, ProjectManifest, WriteOperation } from './types.js';

export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, sort(value)])) : item;
  return JSON.stringify(sort(value));
}
export function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new InputError('OPENVIKING_INVALID_SHA256');
  return value;
}
export function assetPath(path: string) {
  workflowPath(path);
  if (!(isProjectSkillPath(path) || /^(?:wiki\/entries\/[a-z0-9][a-z0-9_-]*\.md|memory\/[a-f0-9]{64}\.md)$/.test(path)) ||
      path.split('/').some(part => /^(?:\.git|\.agent-memory|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[. ]$/.test(part))) {
    throw new InputError('OPENVIKING_INVALID_ASSET_PATH');
  }
  return path;
}
export function manifestBytes(manifest: ProjectManifest): Buffer {
  return Buffer.from(stableJson({ ...manifest, files: [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    wiki: [...manifest.wiki].sort((a, b) => a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0),
    memory: [...manifest.memory].sort((a, b) => a.origin_id < b.origin_id ? -1 : a.origin_id > b.origin_id ? 1 : 0) }));
}
export function validateManifest(value: unknown, project: OpenVikingProject): ProjectManifest {
  validateProject(project);
  const item = workflowRecord(value, 'project manifest');
  if (item.schema_version !== 'evolve-project-release/1.0' || item.project_id !== project.project_id ||
      item.account_id !== project.account_id || item.user_id !== project.user_id) throw new InputError('OPENVIKING_IDENTITY_MISMATCH');
  if (item.parent !== null) digest(item.parent);
  if (typeof item.created_at !== 'string' || !Number.isFinite(Date.parse(item.created_at)) ||
      typeof item.source_commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.source_commit) ||
      typeof item.cli_version !== 'string') throw new InputError('OPENVIKING_INVALID_MANIFEST');
  const upstream = workflowRecord(item.upstream, 'upstream');
  digest(upstream.skills_sha256);
  if (typeof upstream.cli_version !== 'string' || !Array.isArray(item.files) || !Array.isArray(item.wiki) || !Array.isArray(item.memory)) {
    throw new InputError('OPENVIKING_INVALID_MANIFEST');
  }
  const paths = new Map<string, AssetFile>();
  for (const input of item.files) {
    const file = workflowRecord(input, 'asset');
    if (typeof file.path !== 'string' || !['100644', '100755'].includes(String(file.mode)) ||
        !Number.isSafeInteger(file.size) || Number(file.size) < 0) throw new InputError('OPENVIKING_INVALID_ASSET');
    assetPath(file.path);
    digest(file.sha256);
    const folded = file.path.toLowerCase();
    if (paths.has(folded)) throw new InputError('OPENVIKING_PATH_COLLISION');
    paths.set(folded, file as unknown as AssetFile);
  }
  for (const path of paths.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) throw new InputError('OPENVIKING_PATH_COLLISION');
  }
  const knowledge = new Set<string>();
  const entries = new Set<string>();
  for (const input of item.wiki) {
    const wiki = workflowRecord(input, 'Wiki asset');
    if (typeof wiki.entry !== 'string' || wiki.path !== `wiki/${wiki.entry}.md` || !/^entries\/[a-z0-9][a-z0-9_-]*$/.test(wiki.entry) ||
        entries.has(wiki.entry)) throw new InputError('OPENVIKING_INVALID_WIKI');
    entries.add(wiki.entry);
    const approval = workflowRecord(wiki.approval, 'Wiki approval');
    if (typeof approval.payload_json !== 'string' || sha256(approval.payload_json) !== digest(approval.id)) throw new InputError('OPENVIKING_WIKI_UNAPPROVED');
    const payload = workflowRecord(JSON.parse(approval.payload_json), 'Wiki approval payload');
    const file = paths.get(String(wiki.path).toLowerCase());
    if (!file || typeof payload.after !== 'string' || payload.entry !== wiki.entry || sha256(payload.after) !== file.sha256 ||
        !['create', 'update', 'promote', 'retire'].includes(String(payload.operation)) || !Array.isArray(payload.sources) || !payload.sources.length) {
      throw new InputError('OPENVIKING_WIKI_UNAPPROVED');
    }
    knowledge.add(file.path);
  }
  const origins = new Set<string>();
  for (const input of item.memory) {
    const memory = workflowRecord(input, 'shared memory');
    if (typeof memory.origin_id !== 'string' || !memory.origin_id || origins.has(memory.origin_id) || memory.path !== `memory/${sha256(memory.origin_id)}.md`) {
      throw new InputError('OPENVIKING_INVALID_MEMORY');
    }
    origins.add(memory.origin_id);
    const file = paths.get(String(memory.path));
    const meta = workflowRecord(memory.metadata, 'memory metadata');
    if (!file || !Number.isSafeInteger(meta.version) || Number(meta.version) < 1 || !Number.isInteger(meta.priority) ||
        Number(meta.priority) < -1 || Number(meta.priority) > 100 || ['type', 'scene', 'session', 'createdAt', 'updatedAt'].some(key => typeof meta[key] !== 'string') ||
        !Array.isArray(meta.sourceMessageIds) || meta.sourceMessageIds.some(id => typeof id !== 'string') ||
        meta.exactValues !== undefined && (!Array.isArray(meta.exactValues) || meta.exactValues.some(id => typeof id !== 'string'))) {
      throw new InputError('OPENVIKING_INVALID_MEMORY');
    }
    knowledge.add(file.path);
  }
  if ([...paths.values()].some(file => !isProjectSkillPath(file.path) && !knowledge.has(file.path))) throw new InputError('OPENVIKING_UNLISTED_KNOWLEDGE');
  const proof = workflowRecord(item.verification, 'release verification');
  if (!['bootstrap', 'evolved', 'knowledge'].includes(String(proof.kind)) || !Array.isArray(proof.replay_ids) ||
      proof.replay_ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
      proof.kind === 'bootstrap' && (proof.session_id !== null || proof.validation_id !== null || proof.replay_ids.length !== 0) ||
      proof.kind !== 'bootstrap' && typeof proof.session_id !== 'string') throw new InputError('OPENVIKING_INVALID_VERIFICATION');
  if (proof.validation_id !== null) digest(proof.validation_id);
  if (proof.kind === 'evolved' && (!proof.validation_id || !proof.replay_ids.length)) throw new InputError('OPENVIKING_INVALID_VERIFICATION');
  return item as unknown as ProjectManifest;
}
export async function readProjectHead(client: OpenVikingClient, project: OpenVikingProject): Promise<{ head: ProjectHead; raw: Buffer }> {
  validateProject(project);
  await client.identity(project);
  const raw = await client.download(project.root_uri + '/current.json');
  const value = workflowRecord(JSON.parse(raw.toString('utf8')), 'project head');
  if (value.schema_version !== 'evolve-project-head/1.0' || value.project_id !== project.project_id || digest(value.release_id) !== digest(value.manifest_sha256)) {
    throw new InputError('OPENVIKING_INVALID_HEAD');
  }
  return { head: value as unknown as ProjectHead, raw };
}
export async function loadRelease(client: OpenVikingClient, project: OpenVikingProject, releaseId: string): Promise<ProjectManifest> {
  digest(releaseId);
  const raw = await client.download(`${project.root_uri}/releases/${releaseId}/manifest.json`);
  if (sha256(raw) !== releaseId) throw new InputError('OPENVIKING_MANIFEST_HASH_MISMATCH');
  return validateManifest(JSON.parse(raw.toString('utf8')), project);
}
export async function releaseIsAncestor(client: OpenVikingClient, project: OpenVikingProject, release: string, current: string) {
  const seen = new Set<string>();
  let cursor: string | null = current;
  while (cursor && !seen.has(cursor)) {
    if (cursor === release) return true;
    seen.add(cursor);
    cursor = (await loadRelease(client, project, cursor)).parent;
  }
  if (cursor) throw new InputError('OPENVIKING_RELEASE_CYCLE');
  return false;
}
export async function downloadAsset(client: OpenVikingClient, project: OpenVikingProject, file: AssetFile): Promise<Buffer> {
  const bytes = await client.download(`${project.root_uri}/blobs/${digest(file.sha256)}.bin`);
  if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new InputError('OPENVIKING_ASSET_HASH_MISMATCH');
  return bytes;
}
async function existingBytes(client: OpenVikingClient, uri: string) {
  try { return await client.download(uri); } catch (error) { if (!isMissing(error)) throw error; }
}
export async function publishRelease(client: OpenVikingClient, project: OpenVikingProject, manifest: ProjectManifest,
  bytes: ReadonlyMap<string, Buffer>, expectedHead: Buffer | null): Promise<ProjectHead> {
  validateManifest(manifest, project);
  await client.identity(project);
  await client.assertCapabilities();
  const raw = manifestBytes(manifest);
  const release = sha256(raw);
  const root = project.root_uri;
  if (expectedHead === null ? manifest.parent !== null : manifest.parent !== JSON.parse(expectedHead.toString('utf8')).release_id) {
    throw new InputError('OPENVIKING_PARENT_MISMATCH');
  }
  const unique = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const body = bytes.get(file.path);
    if (!body || body.length !== file.size || sha256(body) !== file.sha256) throw new InputError('OPENVIKING_ASSET_HASH_MISMATCH');
    unique.set(`${root}/blobs/${file.sha256}.bin`, body);
  }
  await ensureDirectory(client, root + '/blobs');
  await ensureDirectory(client, `${root}/releases/${release}`);
  let operations: WriteOperation[] = [];
  let size = 0;
  const flush = async () => {
    if (!operations.length) return;
    const batch = operations;
    operations = []; size = 0;
    try { await client.batchWrite(root, batch, true); }
    catch (error) {
      if (!(error instanceof OpenVikingError) || error.status !== 409 && error.code !== 'OPENVIKING_RESULT_UNKNOWN') throw error;
      for (const operation of batch) {
        const existing = await existingBytes(client, operation.uri);
        if (!existing) throw error;
        if (!existing.equals(Buffer.from(operation.content_base64, 'base64'))) throw new InputError('OPENVIKING_IMMUTABLE_CONFLICT');
      }
    }
  };
  for (const [uri, body] of unique) {
    const existing = await existingBytes(client, uri);
    if (existing) { if (!existing.equals(body)) throw new InputError('OPENVIKING_IMMUTABLE_CONFLICT'); continue; }
    if (size + body.length > 4 * 1024 * 1024) await flush();
    operations.push({ uri, mode: 'replace', if_absent: true, content_base64: body.toString('base64') }); size += body.length;
    if (size >= 4 * 1024 * 1024) await flush();
  }
  await flush();
  const uri = `${root}/releases/${release}/manifest.json`;
  const prior = await existingBytes(client, uri);
  if (prior) { if (!prior.equals(raw)) throw new InputError('OPENVIKING_IMMUTABLE_CONFLICT'); }
  else {
    try { await client.batchWrite(root, [{ uri, mode: 'replace', content_base64: raw.toString('base64'), if_absent: true }], true); }
    catch (error) {
      if (!(error instanceof OpenVikingError) || error.status !== 409 && error.code !== 'OPENVIKING_RESULT_UNKNOWN') throw error;
      const existing = await existingBytes(client, uri);
      if (!existing) throw error;
      if (!existing.equals(raw)) throw new InputError('OPENVIKING_IMMUTABLE_CONFLICT');
    }
  }
  for (const [downloadUri, body] of [...unique, [uri, raw] as const]) {
    if (!(await client.download(downloadUri)).equals(body)) throw new InputError('OPENVIKING_ASSET_HASH_MISMATCH');
  }
  if (manifest.memory.length) await ensureDirectory(client, `${root}/releases/${release}/memory`);
  for (const memory of manifest.memory) {
    const body = bytes.get(memory.path)!;
    const uri = `${root}/releases/${release}/${memory.path}`;
    const existing = await existingBytes(client, uri);
    if (existing && !existing.equals(body)) throw new InputError('OPENVIKING_IMMUTABLE_CONFLICT');
    await client.batchWrite(root, [{ uri, mode: 'replace', content_base64: body.toString('base64'),
      ...(existing ? { expected_sha256: sha256(existing) } : { if_absent: true as const }) }], false);
    if (!(await client.download(uri)).equals(body)) throw new InputError('OPENVIKING_ASSET_HASH_MISMATCH');
  }
  const head: ProjectHead = { schema_version: 'evolve-project-head/1.0', project_id: project.project_id, release_id: release, manifest_sha256: release };
  const pointer = Buffer.from(stableJson(head));
  try {
    await client.batchWrite(root, [{ uri: root + '/current.json', mode: 'replace', content_base64: pointer.toString('base64'),
      ...(expectedHead ? { expected_sha256: sha256(expectedHead) } : { if_absent: true as const }) }], true);
    return head;
  } catch (error) {
    if (!(error instanceof OpenVikingError) || error.code !== 'OPENVIKING_RESULT_UNKNOWN' && !(error.status === 409 && error.code === 'CONFLICT')) throw error;
    const latest = await readProjectHead(client, project);
    if (latest.raw.equals(pointer)) return latest.head;
    if (await releaseIsAncestor(client, project, release, latest.head.release_id)) return latest.head;
    throw new OpenVikingError('OPENVIKING_PUBLICATION_CONFLICT', 409);
  }
}
