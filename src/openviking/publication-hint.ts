import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { listWikiChanges } from '../wiki-change.js';
import type { Wiki } from '../wiki.js';
import { projectFile, readProject } from './config.js';
import type { OpenVikingProject } from './types.js';

export interface OpenVikingSyncOptions {
  command?: string;
  action?: string;
  args: readonly string[];
  apply?: boolean;
  root: string;
  writeScope: string;
  wiki: Wiki;
  frozen: boolean;
}

interface AppliedChange {
  id: string;
  entry: string;
}

export interface OpenVikingSyncTracker {
  kind: 'apply' | 'publish' | 'mutation' | 'harvest';
  root: string;
  wiki: Wiki;
  appliedBefore: ReadonlySet<string>;
}

interface OpenVikingSyncHint {
  state: 'local_only' | 'disabled' | 'unchecked' | 'blocked';
  configured: boolean;
  requires_confirmation: true;
  entries: string[];
  change_ids: string[];
  preview?: string[];
  replayed?: true;
  code?: string;
  note: string;
}

const NOTE_LOCAL_ONLY = 'OpenViking is not configured for this project; local Wiki changes remain local only. Local applied is not remote synced.';
const NOTE_DISABLED = 'OpenViking is disabled for this project; local Wiki changes remain local only. Local applied is not remote synced.';
const NOTE_UNCHECKED = 'Local applied is not remote synced; remote state was not checked. Run the preview command. If the user already authorized syncing these entries, publish that exact preview; otherwise present it for upload approval.';
const NOTE_BLOCKED = 'OpenViking project configuration is invalid; local Wiki changes were applied. Local applied is not remote synced.';
const NOTE_REPLAYED = 'The already-applied local change was replayed; remote state was not checked. Local applied is not remote synced.';

/**
 * 只在真实的项目正式 Wiki 写入候选路径记录 applied 变更快照。
 * 只读、pending 提案、episodic、import/ingest 不做任何工作。
 */
export function createOpenVikingSyncTracker(options: OpenVikingSyncOptions): OpenVikingSyncTracker | undefined {
  if (options.command !== 'kb') return undefined;
  const kind = candidateKind(options);
  if (!kind) return undefined;
  if (options.frozen || options.writeScope !== 'project' || resolve(options.wiki.root) !== resolve(options.root)) return undefined;
  const appliedBefore = new Set(listWikiChanges(options.wiki)
    .filter(change => change.state === 'applied').map(change => change.id));
  return { kind, root: resolve(options.root), wiki: options.wiki, appliedBefore };
}

function candidateKind(options: OpenVikingSyncOptions): OpenVikingSyncTracker['kind'] | undefined {
  if (options.action === 'apply') return 'apply';
  if (options.action === 'harvest') return 'harvest';
  if (options.action === 'candidates' && options.args[0] === 'publish') return 'publish';
  if (options.action === 'add' || options.action === 'update' || options.action === 'delete') {
    return options.apply === true ? 'mutation' : undefined;
  }
  return undefined;
}

/**
 * 以命令前后 applied wiki_changes ID 差分为准附加离线同步提示。
 * 显式 apply/publish replay 没有新 ID，但仍按结果中的 change ID 给出检查指引。
 */
export function withOpenVikingSync(result: unknown, tracker?: OpenVikingSyncTracker): unknown {
  if (!tracker) return result;
  const changes: AppliedChange[] = listWikiChanges(tracker.wiki)
    .filter(change => change.state === 'applied' && !tracker.appliedBefore.has(change.id))
    .map(change => ({ id: change.id, entry: change.entry }));
  const replay = changes.length ? undefined : replayChange(result, tracker);
  const applied = changes.length ? changes : replay ? [replay] : [];
  if (!applied.length) return result;
  const entries = [...new Set(applied.map(change => change.entry))].sort();
  if (!entries.length) return result;
  const changeIds = [...new Set(applied.map(change => change.id))].sort();
  const hint = describeSync(tracker.root, entries, changeIds, changes.length === 0);
  return result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result, openviking_sync: hint }
    : { result, openviking_sync: hint };
}

function replayChange(result: unknown, tracker: OpenVikingSyncTracker): AppliedChange | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  // CLI 处理器在进程内构造的结果对象；只读取明确的 optional 字段。
  const item = result as Record<string, unknown>;
  if (item.replayed !== true) return undefined;
  if (tracker.kind === 'apply' || tracker.kind === 'mutation') {
    if (!isChangeId(item.id) || typeof item.entry !== 'string') return undefined;
    return { id: item.id, entry: item.entry };
  }
  if (tracker.kind !== 'publish' || typeof item.id !== 'string') return undefined;
  const entry = typeof item.entry === 'string' ? item.entry : item.id;
  if (isChangeId(item.change_id)) return { id: item.change_id, entry };
  const applied = listWikiChanges(tracker.wiki, { entry }).filter(change => change.state === 'applied').at(-1);
  return applied ? { id: applied.id, entry: applied.entry } : undefined;
}

function isChangeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function describeSync(root: string, entries: string[], changeIds: string[], replayed: boolean): OpenVikingSyncHint {
  const shared = {
    requires_confirmation: true as const,
    entries,
    change_ids: changeIds,
    ...(replayed ? { replayed: true as const } : {}),
  };
  let project: OpenVikingProject | undefined;
  try {
    project = readProject(root);
  } catch (error) {
    return {
      state: 'blocked', configured: existsSync(projectFile(root)), ...shared,
      code: sanitizedConfigCode(error), note: NOTE_BLOCKED,
    };
  }
  if (!project) return { state: 'local_only', configured: false, ...shared, note: NOTE_LOCAL_ONLY };
  if (project.enabled === false) return { state: 'disabled', configured: true, ...shared, note: NOTE_DISABLED };
  return {
    state: 'unchecked', configured: true, ...shared,
    preview: ['evolve', 'openviking', 'knowledge', 'preview', ...entries, '--root', root],
    note: replayed ? NOTE_REPLAYED : NOTE_UNCHECKED,
  };
}

function sanitizedConfigCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const code = message.split(':', 1)[0].trim();
  return /^OPENVIKING_[A-Z0-9_]+$/.test(code) ? code : 'OPENVIKING_PROJECT_INVALID';
}
