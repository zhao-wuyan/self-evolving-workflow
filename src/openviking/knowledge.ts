import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InputError } from '../common.js';
import { MemoryStore, defaultMemoryDbPath } from '../memory.js';
import { exactMemoryValues } from '../memory-evidence.js';
import { applyWikiChange, listWikiChanges, proposeWikiSnapshot } from '../wiki-change.js';
import { Wiki, readWikiPages } from '../wiki.js';
import { replaceJson } from './config.js';
import { downloadAsset, manifestBytes, sha256, stableJson, validateManifest } from './assets.js';
import type { OpenVikingClient } from './client.js';
import type { AssetFile, OpenVikingProject, ProjectManifest, SharedMemory, WikiApproval } from './types.js';

interface Share { operation: 'share'; version: number; content_sha256: string; metadata: SharedMemory['metadata'] }
export type MemorySelection = Share | { operation: 'unshare' };
type Selection = MemorySelection;
interface SelectionFile { schema_version: 'openviking-memory-selection/1.0'; changes: Record<string, Selection> }
export interface WikiPublicationChanges { [entry: string]: { change_id: string; result_sha256: string } }
interface WikiPublication { schema_version: 'openviking-local-publication/1.0'; changes: WikiPublicationChanges }

export function fileRecord(path: string, body: Buffer, mode: AssetFile['mode'] = '100644'): AssetFile {
  return { path, mode, size: body.length, sha256: sha256(body) };
}
export function selectMemory(root: string, id: string, operation: 'share' | 'unshare') {
  const path = join(root, '.agent-memory', 'openviking', 'share.json');
  const raw = existsSync(path) ? readFileSync(path) : undefined;
  const selection: SelectionFile = raw ? JSON.parse(raw.toString('utf8')) : { schema_version: 'openviking-memory-selection/1.0', changes: {} };
  if (selection.schema_version !== 'openviking-memory-selection/1.0') throw new InputError('OPENVIKING_MEMORY_SELECTION_INVALID');
  if (operation === 'unshare') selection.changes[id] = { operation };
  else {
    const store = new MemoryStore(defaultMemoryDbPath(root));
    try {
      const record = store.get(id);
      if (!record) throw new InputError('Memory not found');
      const { id: _id, content, ...metadata } = record;
      metadata.exactValues = [...new Set([...(metadata.exactValues ?? []), ...exactMemoryValues(content)])].sort();
      selection.changes[id] = { operation, version: record.version, content_sha256: sha256(content), metadata };
    } finally { store.close(); }
  }
  replaceJson(path, raw, selection);
  return { origin_id: id, selection: selection.changes[id], publication: 'pending' };
}

export function sourceWikiHashes(root: string) {
  return Object.fromEntries(readWikiPages(root, true).map(page => [page.id, sha256(readFileSync(join(root, page.path)))]));
}
export function exportWiki(root: string, base?: ProjectManifest, initial?: Record<string, string>, selection?: readonly string[]) {
  const wiki = new Wiki(root);
  const path = join(root, '.agent-memory', 'openviking', 'published-wiki.json');
  const publication: WikiPublication = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8'))
    : { schema_version: 'openviking-local-publication/1.0', changes: {} };
  const entries = new Map((base?.wiki ?? []).map(item => [item.entry, item]));
  const bodies = new Map<string, Buffer>();
  const consumed: WikiPublication['changes'] = {};
  const localOnly: string[] = [];
  for (const page of readWikiPages(root, true)) {
    if (selection && !selection.includes(page.id)) continue;
    const bytes = readFileSync(join(root, page.path));
    const content = bytes.toString('utf8');
    const hash = sha256(bytes);
    const applied = listWikiChanges(wiki, { entry: page.id }).filter(change => change.state === 'applied' && change.after === content).at(-1);
    // 首次发布只纳入已审批的条目；本地迁移并不授权上传。
    if (selection && !applied) throw new InputError('OPENVIKING_WIKI_UNAPPROVED: ' + page.id);
    if (!base && !applied) {
      localOnly.push(page.id);
      continue;
    }
    const original = base?.wiki.find(item => item.entry === page.id);
    const originalFile = base?.files.find(item => item.path === original?.path);
    if (applied && originalFile?.sha256 === hash && original?.approval.id === applied.id) {
      consumed[page.id] = { change_id: applied.id, result_sha256: hash }; continue;
    }
    if (base && initial?.[page.id] === hash && (!applied || publication.changes[page.id]?.change_id === applied.id)) continue;
    if (!applied || base && initial?.[page.id] !== hash && publication.changes[page.id]?.change_id === applied.id) {
      throw new InputError('OPENVIKING_WIKI_UNAPPROVED: ' + page.id);
    }
    const payload = { operation: applied.operation, entry: applied.entry, before: applied.before, after: applied.after, sources: applied.sources,
      ...(applied.candidate ? { candidate: applied.candidate } : {}), ...(applied.review ? { review: applied.review } : {}) };
    const payload_json = JSON.stringify(payload);
    if (sha256(payload_json) !== applied.id) throw new InputError('OPENVIKING_WIKI_UNAPPROVED');
    const approval: WikiApproval = { id: applied.id, payload_json };
    entries.set(page.id, { entry: page.id, path: page.path, approval }); bodies.set(page.path, bytes);
    consumed[page.id] = { change_id: applied.id, result_sha256: hash };
  }
  if (base && initial) {
    for (const entry of Object.keys(initial)) {
      if (!existsSync(join(root, 'wiki', entry + '.md'))) throw new InputError('OPENVIKING_WIKI_UNAPPROVED: use retire, not physical deletion');
    }
  }
  return { wiki: [...entries.values()], bodies, consumed, localOnly };
}
export function exportMemory(root: string, base?: ProjectManifest) {
  const path = join(root, '.agent-memory', 'openviking', 'share.json');
  const raw = existsSync(path) ? readFileSync(path) : undefined;
  const selection: SelectionFile = raw ? JSON.parse(raw.toString('utf8')) : { schema_version: 'openviking-memory-selection/1.0', changes: {} };
  if (selection.schema_version !== 'openviking-memory-selection/1.0') throw new InputError('OPENVIKING_MEMORY_SELECTION_INVALID');
  const memory = new Map((base?.memory ?? []).map(item => [item.origin_id, item]));
  const bodies = new Map<string, Buffer>();
  if (Object.keys(selection.changes).length) {
    const store = new MemoryStore(defaultMemoryDbPath(root));
    try {
      for (const [id, choice] of Object.entries(selection.changes)) {
        if (choice.operation === 'unshare') { memory.delete(id); continue; }
        const record = store.get(id);
        if (!record || record.version !== choice.version || sha256(record.content) !== choice.content_sha256) {
          throw new InputError('OPENVIKING_MEMORY_APPROVAL_CHANGED');
        }
        const { id: _id, content, ...metadata } = record;
        metadata.exactValues = [...new Set([...(metadata.exactValues ?? []), ...exactMemoryValues(content)])].sort();
        if (stableJson(metadata) !== stableJson(choice.metadata)) throw new InputError('OPENVIKING_MEMORY_APPROVAL_CHANGED');
        const path = `memory/${sha256(id)}.md`;
        memory.set(id, { origin_id: id, path, metadata }); bodies.set(path, Buffer.from(content));
      }
    } finally { store.close(); }
  }
  return { memory: [...memory.values()], bodies, consumed: selection.changes };
}
export function acknowledgeKnowledge(root: string, wiki: WikiPublication['changes'], memory: Record<string, Selection>) {
  const folder = join(root, '.agent-memory', 'openviking');
  const wikiPath = join(folder, 'published-wiki.json');
  const raw = existsSync(wikiPath) ? readFileSync(wikiPath) : undefined;
  const previous: WikiPublication = raw ? JSON.parse(raw.toString('utf8')) : { schema_version: 'openviking-local-publication/1.0', changes: {} };
  replaceJson(wikiPath, raw, { ...previous, changes: { ...previous.changes, ...wiki } });
  const path = join(folder, 'share.json');
  if (!Object.keys(memory).length || !existsSync(path)) return;
  const shareRaw = readFileSync(path);
  const selection: SelectionFile = JSON.parse(shareRaw.toString('utf8'));
  for (const [id, consumed] of Object.entries(memory)) {
    if (stableJson(selection.changes[id]) === stableJson(consumed)) delete selection.changes[id];
  }
  replaceJson(path, shareRaw, selection);
}

export async function cacheRelease(root: string, client: OpenVikingClient, project: OpenVikingProject, release: string, manifest: ProjectManifest, scope: 'all' | 'wiki' = 'all') {
  validateManifest(manifest, project);
  if (sha256(manifestBytes(manifest)) !== release) throw new InputError('OPENVIKING_MANIFEST_HASH_MISMATCH');
  const folder = join(root, '.agent-memory', 'openviking', scope === 'all' ? 'releases' : 'wiki-releases');
  const target = join(folder, release);
  const verify = () => {
    if (!readFileSync(join(target, 'manifest.json')).equals(manifestBytes(manifest))) throw new InputError('OPENVIKING_CACHE_CHANGED');
    for (const file of manifest.files.filter(file => scope === 'all' ? !file.path.startsWith('memory/') : file.path.startsWith('wiki/'))) {
      const body = readFileSync(join(target, 'assets', file.path));
      if (body.length !== file.size || sha256(body) !== file.sha256) throw new InputError('OPENVIKING_CACHE_CHANGED');
    }
    for (const entry of manifest.wiki) {
      const body = readFileSync(join(target, 'wiki', entry.path));
      if (sha256(body) !== manifest.files.find(file => file.path === entry.path)!.sha256) throw new InputError('OPENVIKING_CACHE_CHANGED');
    }
  };
  if (existsSync(target)) { verify(); return target; }
  mkdirSync(folder, { recursive: true });
  const temporary = mkdtempSync(join(folder, '.release-'));
  try {
    for (const file of manifest.files.filter(file => scope === 'all' ? !file.path.startsWith('memory/') : file.path.startsWith('wiki/'))) {
      const bytes = await downloadAsset(client, project, file);
      const path = join(temporary, 'assets', file.path);
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes, { flag: 'wx' });
    }
    const wikiRoot = join(temporary, 'wiki');
    mkdirSync(join(wikiRoot, 'wiki'), { recursive: true });
    const wiki = new Wiki(wikiRoot);
    for (const entry of manifest.wiki) {
      const bytes = readFileSync(join(temporary, 'assets', entry.path));
      if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new InputError('OPENVIKING_WIKI_INVALID_UTF8');
      const proposal = proposeWikiSnapshot(wiki, { entry: entry.entry, content: bytes.toString('utf8'), approval: entry.approval },
        [`${project.root_uri}/releases/${release}/manifest.json`, `sha256:${release}`]);
      applyWikiChange(wiki, proposal.id);
    }
    wiki.build();
    writeFileSync(join(temporary, 'manifest.json'), manifestBytes(manifest));
    try { renameSync(temporary, target); }
    catch (error) { if (!existsSync(target)) throw error; verify(); }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return target;
}
