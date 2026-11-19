import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InputError } from '../common.js';
import { Wiki, readWikiPages } from '../wiki.js';
import { listWikiChanges } from '../wiki-change.js';
import { workflowRecord } from '../workflow-skills.js';
import { OpenVikingClient } from './client.js';
import { connectionConfig, readProject, replaceJson, validateProject } from './config.js';
import { digest, downloadAsset, loadRelease, manifestBytes, publishRelease, readProjectHead, releaseIsAncestor, sha256, stableJson } from './assets.js';
import { acknowledgeKnowledge, exportWiki, fileRecord } from './knowledge.js';
import type { OpenVikingProject, ProjectManifest, WikiApproval } from './types.js';

type SelectedWiki = { entry: string; approval: WikiApproval; before: string | null };
interface Preview {
  schema_version: 'openviking-wiki-preview/1.0';
  destination: { url: string; project: OpenVikingProject };
  base_release: string;
  expected_head: string;
  created_at: string;
  wiki: SelectedWiki[];
}

function approvalPayload(approval: WikiApproval, entry: string) {
  if (sha256(approval.payload_json) !== digest(approval.id)) throw new InputError('OPENVIKING_WIKI_UNAPPROVED');
  const payload = workflowRecord(JSON.parse(approval.payload_json), 'Wiki publication approval');
  if (payload.entry !== entry || typeof payload.after !== 'string' || payload.before !== null && typeof payload.before !== 'string') {
    throw new InputError('OPENVIKING_WIKI_UNAPPROVED');
  }
  return { after: payload.after, before: payload.before };
}

function readPreview(path: string): Preview {
  const value = workflowRecord(JSON.parse(readFileSync(path, 'utf8')), 'Wiki publication preview');
  const destination = workflowRecord(value.destination, 'Wiki publication destination');
  if (value.schema_version !== 'openviking-wiki-preview/1.0' || typeof destination.url !== 'string' ||
      typeof value.expected_head !== 'string' || typeof value.created_at !== 'string' ||
      !Number.isFinite(Date.parse(value.created_at)) || !Array.isArray(value.wiki) || !value.wiki.length) {
    throw new InputError('OPENVIKING_PREVIEW_STALE');
  }
  const wiki = value.wiki.map(raw => {
    const item = workflowRecord(raw, 'Wiki publication entry');
    const proof = workflowRecord(item.approval, 'Wiki publication approval');
    if (typeof item.entry !== 'string' || item.before !== null && typeof item.before !== 'string' ||
        typeof proof.id !== 'string' || typeof proof.payload_json !== 'string') throw new InputError('OPENVIKING_PREVIEW_STALE');
    const approval = { id: digest(proof.id), payload_json: proof.payload_json };
    approvalPayload(approval, item.entry);
    return { entry: item.entry, before: item.before, approval };
  });
  if (entryIds(wiki.map(item => item.entry)).length !== wiki.length) throw new InputError('OPENVIKING_PREVIEW_STALE');
  return { schema_version: value.schema_version, destination: { url: destination.url, project: validateProject(destination.project) },
    base_release: digest(value.base_release), expected_head: value.expected_head, created_at: value.created_at, wiki };
}
function projectForPublication(root: string) {
  const project = readProject(root);
  if (!project) throw new InputError('OPENVIKING_PROJECT_REQUIRED: run openviking init first');
  if (project.enabled === false) throw new InputError('OPENVIKING_DISABLED');
  return project;
}


function entryIds(entries: readonly string[]) {
  for (const entry of entries) {
    if (!/^entries\/[a-z0-9][a-z0-9_-]*$/.test(entry)) throw new InputError('Expected an exact Wiki entry ID');
  }
  return [...new Set(entries)].sort();
}

function currentWiki(root: string, entries: readonly string[]) {
  const pages = new Set(readWikiPages(root, true).map(page => page.id));
  for (const entry of entries) if (!pages.has(entry)) throw new InputError('OPENVIKING_WIKI_UNAPPROVED: ' + entry);
  return exportWiki(root, undefined, undefined, entries);
}

function approvedEntries(root: string) {
  const wiki = new Wiki(root);
  return readWikiPages(root, true).filter(page => {
    const content = readFileSync(join(root, page.path), 'utf8');
    return listWikiChanges(wiki, { entry: page.id }).some(change => change.state === 'applied' && change.after === content);
  }).map(page => page.id).sort();
}

function checkBaseline(root: string, selected: SelectedWiki) {
  const payload = approvalPayload(selected.approval, selected.entry);
  if (selected.before === null || selected.before === payload.after) return;
  // 本地可能连续批准多次更新，沿真实审批链追溯远端基线，不能只比较最后一次 before。
  const changes = listWikiChanges(new Wiki(root), { entry: selected.entry }).filter(change => change.state === 'applied');
  const pending: Array<string | null> = [payload.before];
  const seen = new Set<string | null>();
  while (pending.length) {
    const content = pending.pop()!;
    if (content === selected.before) return;
    if (seen.has(content)) continue;
    seen.add(content);
    for (const change of changes) if (change.after === content) pending.push(change.before);
  }
  throw new InputError('OPENVIKING_PUBLICATION_CONFLICT: ' + selected.entry + '; preview after reviewing the remote Wiki');
}

function candidate(base: ProjectManifest, plan: Preview, approval: string) {
  const wiki = new Map(base.wiki.map(item => [item.entry, item]));
  const files = new Map(base.files.map(item => [item.path, item]));
  const bodies = new Map<string, Buffer>();
  for (const selected of plan.wiki) {
    const path = 'wiki/' + selected.entry + '.md';
    const body = Buffer.from(approvalPayload(selected.approval, selected.entry).after);
    files.set(path, fileRecord(path, body));
    wiki.set(selected.entry, { entry: selected.entry, path, approval: selected.approval });
    bodies.set(path, body);
  }
  const manifest: ProjectManifest = {
    ...base, parent: plan.base_release, created_at: plan.created_at,
    files: [...files.values()], wiki: [...wiki.values()],
    verification: { kind: 'knowledge', session_id: null, replay_ids: [], validation_id: null, approval },
  };
  return { manifest, bodies };
}

function confirmation(root: string, plan: Preview) {
  const changes = Object.fromEntries(plan.wiki.map(item => [item.entry, {
    change_id: item.approval.id, result_sha256: sha256(approvalPayload(item.approval, item.entry).after),
  }]));
  acknowledgeKnowledge(root, changes, {});
}

export async function previewWikiPublication(root: string, entries: readonly string[] = []) {
  const project = projectForPublication(root);
  const destination = { url: connectionConfig().url, project };
  const selection = entryIds(entries.length ? entries : approvedEntries(root));
  const localOnly = entries.length ? [] : readWikiPages(root, true).map(page => page.id).filter(entry => !selection.includes(entry));
  const local = currentWiki(root, selection);
  const client = new OpenVikingClient();
  const { head, raw } = await readProjectHead(client, project);
  const base = await loadRelease(client, project, head.release_id);
  const selected: SelectedWiki[] = [];
  for (const entry of selection) {
    const item = local.wiki.find(item => item.entry === entry)!;
    const original = base.wiki.find(item => item.entry === entry);
    const file = base.files.find(file => file.path === original?.path);
    const body = local.bodies.get(item.path)!;
    if (file?.sha256 === sha256(body) && original?.approval.id === item.approval.id) continue;
    const before = file ? (await downloadAsset(client, project, file)).toString('utf8') : null;
    const change = { entry, approval: item.approval, before };
    checkBaseline(root, change);
    selected.push(change);
  }
  if (!selected.length) return { state: 'no_change', base_release: head.release_id, wiki: [], remote_checked: true, local_only_wiki: localOnly };
  const plan: Preview = {
    schema_version: 'openviking-wiki-preview/1.0', destination, base_release: head.release_id,
    expected_head: raw.toString('base64'), created_at: new Date().toISOString(), wiki: selected,
  };
  const approval = sha256(stableJson(plan));
  const path = join(root, '.agent-memory', 'openviking', 'wiki-publications', approval + '.json');
  replaceJson(path, existsSync(path) ? readFileSync(path) : undefined, plan);
  return {
    state: 'preview', approval, base_release: plan.base_release, destination, remote_checked: true, local_only_wiki: localOnly,
    wiki: selected.map(item => ({ entry: item.entry, change_id: item.approval.id, before: item.before,
      after: approvalPayload(item.approval, item.entry).after })),
    requires_confirmation: true,
    guidance: 'Present this exact Wiki content and destination. Publish only when the user has authorized this upload; an existing request to sync these entries is sufficient. Local Wiki approval alone is not upload approval.',
    next_action: { argv: ['evolve', 'openviking', 'knowledge', 'publish', '--root', root, '--approval', approval] },
  };
}

export async function publishWikiPublication(root: string, approval: string) {
  const project = projectForPublication(root);
  const path = join(root, '.agent-memory', 'openviking', 'wiki-publications', digest(approval) + '.json');
  if (!existsSync(path)) throw new InputError('OPENVIKING_PREVIEW_REQUIRED: preview Wiki publication first');
  const plan = readPreview(path);
  if (sha256(stableJson(plan)) !== approval ||
      stableJson(plan.destination) !== stableJson({ url: connectionConfig().url, project })) {
    throw new InputError('OPENVIKING_PREVIEW_STALE: preview the exact destination again');
  }
  const local = currentWiki(root, entryIds(plan.wiki.map(item => item.entry)));
  for (const selected of plan.wiki) {
    const item = local.wiki.find(item => item.entry === selected.entry);
    if (!item || stableJson(item.approval) !== stableJson(selected.approval)) {
      throw new InputError('OPENVIKING_LOCAL_CHANGED: preview the Wiki content again');
    }
  }
  const client = new OpenVikingClient();
  const base = await loadRelease(client, project, plan.base_release);
  const { manifest, bodies } = candidate(base, plan, approval);
  const release = sha256(manifestBytes(manifest));
  const latest = await readProjectHead(client, project);
  if (await releaseIsAncestor(client, project, release, latest.head.release_id)) {
    await loadRelease(client, project, release);
    confirmation(root, plan);
    return { state: 'published', release_id: release, current_head: latest.head, replayed: true };
  }
  if (latest.raw.toString('base64') !== plan.expected_head) {
    throw new InputError('OPENVIKING_PUBLICATION_CONFLICT: remote head changed; preview again');
  }
  for (const file of manifest.files) {
    if (!bodies.has(file.path)) bodies.set(file.path, await downloadAsset(client, project, file));
  }
  // 所有检查后再读取本地审批，防止下载远端资产期间本地正文变化。
  const checked = currentWiki(root, plan.wiki.map(item => item.entry));
  if (stableJson(checked.wiki) !== stableJson(local.wiki)) throw new InputError('OPENVIKING_LOCAL_CHANGED: preview again');
  const head = await publishRelease(client, project, manifest, bodies, latest.raw);
  await loadRelease(client, project, release);
  confirmation(root, plan);
  return { state: 'published', release_id: release, current_head: head, replayed: false };
}
