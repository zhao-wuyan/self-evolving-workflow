import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { stringify } from 'yaml';
import {
  InputError, LEGACY_AGENT_MEMORY_DIR, NotFoundError, openDb,
  requireText, resolveEvolveStorage, transaction,
} from './common.js';
import { parseFrontmatter } from './upstream/frontmatter.js';
import { unionSources } from './upstream/merge.js';
import { readWikiEntryMetadata } from './wiki-entry.js';
import type { Wiki } from './wiki.js';
import type { WikiApproval } from './openviking/types.js';

type Operation = 'create' | 'update' | 'promote' | 'retire';
type State = 'pending' | 'applying' | 'applied';

interface Change {
  operation: Operation;
  entry: string;
  before: string | null;
  after: string;
  sources: string[];
  candidate?: { closeout: string; id: string };
  review?: { relationship: 'overlap' | 'conflict' | 'independent'; rationale: string; related: string[] };
}

interface StoredChange {
  payload?: unknown;
  state?: unknown;
  entry?: unknown;
  applied_at?: unknown;
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`Invalid ${name}`);
  return value as Record<string, unknown>;
}

function entryPath(wiki: Wiki, id: string): string {
  if (!/^entries\/[a-z0-9][a-z0-9_-]*$/.test(id) || /^entries\/(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) {
    throw new InputError('Expected an exact portable Wiki entry ID such as entries/preflight');
  }
  const folder = join(wiki.root, 'wiki', 'entries');
  for (const directory of [join(wiki.root, 'wiki'), folder]) {
    const info = lstatSync(directory, { throwIfNoEntry: false });
    if (info && !info.isDirectory()) throw new InputError(`Invalid Wiki directory: ${directory}`);
  }
  return join(wiki.root, 'wiki', id + '.md');
}

function readEntry(path: string): string | null {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile()) throw new InputError(`Invalid Wiki entry file: ${path}`);
  return readFileSync(path, 'utf8');
}

function exactChangeId(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new InputError('Expected an exact Wiki change ID');
  return id;
}

export function closeoutDbPath(root: string): string {
  return resolveEvolveStorage(root, ['closeout.db'], join(resolve(root), LEGACY_AGENT_MEMORY_DIR, 'closeout.db'));
}

function openChanges(wiki: Wiki) {
  const path = closeoutDbPath(wiki.root);
  mkdirSync(dirname(path), { recursive: true });
  const db = openDb(path);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS wiki_changes (
      id TEXT PRIMARY KEY, entry TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL, applied_at TEXT
    )`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function preview(id: string, change: Change, state: State, appliedAt?: unknown) {
  return {
    id, entry: change.entry, operation: change.operation, state, sources: change.sources,
    baseline_sha256: change.before === null ? null : hash(change.before),
    result_sha256: hash(change.after), before: change.before, after: change.after,
    ...(change.candidate ? { candidate: change.candidate } : {}),
    ...(change.review ? { review: change.review } : {}),
    ...(typeof appliedAt === 'string' ? { applied_at: appliedAt } : {}),
  };
}

function readChange(id: string, row: StoredChange): { change: Change; state: State; appliedAt: unknown } {
  const payload = requireText(row.payload, 'Wiki change payload');
  if (hash(payload) !== id) throw new InputError(`Wiki change payload did not match its ID: ${id}`);
  const change = object(JSON.parse(payload), 'Wiki change') as unknown as Change;
  if (change.entry !== row.entry || !['create', 'update', 'promote', 'retire'].includes(change.operation) ||
      (change.before !== null && typeof change.before !== 'string') || typeof change.after !== 'string' ||
      !Array.isArray(change.sources) || !change.sources.length ||
      change.sources.some(source => typeof source !== 'string')) {
    throw new InputError(`Invalid stored Wiki change: ${id}`);
  }
  const state = row.state;
  if (state !== 'pending' && state !== 'applying' && state !== 'applied') {
    throw new InputError(`Invalid Wiki change state: ${id}`);
  }
  return { change, state, appliedAt: row.applied_at };
}

interface ChangeDraft {
  operation: Operation;
  entry: string;
  title?: string;
  mode?: 'constraint' | 'reference';
  scope?: unknown;
  categories?: unknown;
  repositories?: unknown;
  keywords?: unknown;
  body?: string;
}

function parseDraft(value: unknown): ChangeDraft {
  const draft = object(value, 'Wiki change request');
  const unknown = Object.keys(draft).filter(key => !['operation', 'entry', 'title', 'mode', 'scope', 'categories', 'repositories', 'keywords', 'body', 'review'].includes(key));
  if (unknown.length) throw new InputError(`Unknown Wiki change field: ${unknown[0]}`);
  const { operation, mode } = draft;
  if (operation !== 'create' && operation !== 'update' && operation !== 'promote' && operation !== 'retire') {
    throw new InputError('Expected Wiki operation create, update, promote, or retire');
  }
  if (mode !== undefined && mode !== 'constraint' && mode !== 'reference') throw new InputError('Invalid Wiki entry mode');
  if (mode !== undefined && operation !== 'create') throw new InputError('Use promote to change a reference into a constraint');
  if (operation === 'retire' && ['title', 'scope', 'body', 'categories', 'repositories', 'keywords'].some(key => draft[key] !== undefined)) {
    throw new InputError('A retirement changes status and evidence only');
  }
  if (draft.scope !== undefined && !Array.isArray(draft.scope)) throw new InputError('Wiki scope must be a list');
  if (draft.scope?.some(item => typeof item === 'string' && item.trim().startsWith('skill:'))) {
    throw new InputError('Use project, task:<kind>, or path:<glob> for Wiki scope');
  }
  return {
    operation, mode, entry: requireText(draft.entry, 'Wiki entry ID'),
    ...(draft.title !== undefined ? { title: requireText(draft.title, 'Wiki entry title') } : {}),
    ...(draft.body !== undefined ? { body: requireText(draft.body, 'Wiki entry body') } : {}),
    ...(draft.scope !== undefined ? { scope: draft.scope } : {}),
    ...(draft.categories !== undefined ? { categories: draft.categories } : {}),
    ...(draft.repositories !== undefined ? { repositories: draft.repositories } : {}),
    ...(draft.keywords !== undefined ? { keywords: draft.keywords } : {}),
  };
}

export function proposeWikiChange(wiki: Wiki, value: unknown, evidence: readonly string[], candidate?: {
  closeout: string; id: string; sources: readonly string[]; related: string[];
}) {
  const draft = parseDraft(value);
  const related = candidate?.related ?? [];
  const request = object(value, 'Wiki change request');
  const review = request.review === undefined ? undefined : object(request.review, 'Wiki relationship decision');
  const relationship = review?.relationship;
  if (review && relationship !== 'overlap' && relationship !== 'conflict' && relationship !== 'independent') {
    throw new InputError('Expected Wiki relationship overlap, conflict, or independent');
  }
  if (related.length && !review) throw new InputError('A linked candidate with related entries requires a recorded relationship decision');
  if (related.length && relationship !== 'independent' && !related.includes(draft.entry)) {
    throw new InputError('Choose a related entry as the target, or resolve it as independent');
  }
  const decision: Change['review'] = relationship === 'overlap' || relationship === 'conflict' || relationship === 'independent' ? {
    relationship,
    rationale: requireText(review?.rationale, 'Wiki relationship rationale'),
    related: [...new Set(related)].sort(),
  } : undefined;
  if (evidence.some(source => source.trim().startsWith('receipt:'))) {
    throw new InputError('Use --closeout and --candidate for completion receipt evidence');
  }
  const sources = [...new Set([...evidence, ...(candidate?.sources ?? [])]
    .map(source => requireText(source, 'evidence reference')))].sort();
  if (!sources.length || sources.some(source => /[\r\n]/.test(source))) {
    throw new InputError('At least one single-line evidence reference is required');
  }
  const db = openChanges(wiki);
  try {
    return transaction(db, () => {
      const path = entryPath(wiki, draft.entry);
      const before = readEntry(path);
      const original = parseFrontmatter((before ?? '').replace(/^\uFEFF/, ''));
      if (draft.operation !== 'create' && before === null) throw new NotFoundError(`Wiki entry not found: ${draft.entry}`);
      if (original.frontmatter.locked === true) throw new InputError(`Wiki entry is locked: ${draft.entry}`);
      const rel = `wiki/${draft.entry}.md`;
      const current = before === null || draft.operation === 'create' ? undefined : readWikiEntryMetadata(rel, original.frontmatter, original.body);
      if (draft.operation === 'promote' && current?.mode !== 'reference') {
        throw new InputError('Only a reference can be promoted to a constraint');
      }
      if (current?.status === 'deprecated') {
        throw new InputError('A retired entry is immutable');
      }
      const scope = draft.operation === 'retire' ? current?.scope : current?.scope.filter(item => !item.startsWith('skill:'));
      if ((current?.status === 'needs_review' || scope?.length === 0) && draft.operation !== 'retire' && draft.scope === undefined) {
        throw new InputError('Set the reviewed scope explicitly before activating this entry');
      }
      const { operation } = draft;
      const body = draft.body !== undefined || operation === 'create'
        ? `\n${requireText(draft.body, 'Wiki entry body')}\n`
        : original.body;
      const metadata = {
        ...(operation === 'create' ? {} : original.frontmatter),
        title: draft.title ?? (operation === 'create' ? undefined : original.frontmatter.title),
        mode: operation === 'promote' ? 'constraint' : draft.mode ?? current?.mode,
        status: operation === 'retire' ? 'deprecated' : 'active',
        scope: draft.scope ?? scope ?? ['project'],
        ...(draft.categories !== undefined ? { categories: draft.categories } : {}),
        ...(draft.repositories !== undefined ? { repositories: draft.repositories } : {}),
        ...(draft.keywords !== undefined ? { keywords: draft.keywords } : {}),
        sources: unionSources(operation === 'create' ? [] : original.frontmatter.sources ?? [], sources),
      };
      readWikiEntryMetadata(rel, { type: 'other', ...metadata }, body);
      const after = `---\n${stringify(metadata)}---\n${body}`;
      const change: Change = {
        operation, entry: draft.entry, before: operation === 'create' ? null : before, after, sources,
        ...(candidate ? { candidate: { closeout: candidate.closeout, id: candidate.id } } : {}),
        ...(decision ? { review: decision } : {}),
      };
      return saveChange(wiki, db, change, before);
    });
  } finally {
    db.close();
  }
}

function saveChange(wiki: Wiki, db: DatabaseSync, change: Change, before: string | null) {
  const payload = JSON.stringify(change);
  const id = hash(payload);
  const previous = db.prepare('SELECT * FROM wiki_changes WHERE id = ?').get(id);
  if (previous) {
    const existing = readChange(id, previous);
    return preview(id, existing.change, existing.state, existing.appliedAt);
  }
  if (change.operation === 'create' && before !== null && before !== change.after) {
    throw new InputError(`Wiki entry already exists: ${change.entry}`);
  }
  if (change.operation !== 'create' && before === change.after) throw new InputError('Wiki change has no effect');
  if (change.operation !== 'retire') assertUniqueContent(wiki, change.entry, change.after);
  db.prepare('INSERT INTO wiki_changes VALUES (?, ?, ?, ?, ?, NULL)').run(id, change.entry, payload, 'pending', new Date().toISOString());
  return preview(id, change, 'pending');
}

export function proposeWikiSnapshot(wiki: Wiki, input: { entry: string; content: string; approval: WikiApproval }, evidence: readonly string[]) {
  if (hash(input.approval.payload_json) !== exactChangeId(input.approval.id)) throw new InputError('OPENVIKING_WIKI_UNAPPROVED');
  const approval = object(JSON.parse(input.approval.payload_json), 'Wiki snapshot approval');
  if (approval.entry !== input.entry || approval.after !== input.content || !['create', 'update', 'promote', 'retire'].includes(String(approval.operation)) ||
      !Array.isArray(approval.sources) || !approval.sources.length || approval.sources.some(source => typeof source !== 'string' || !source.trim())) {
    throw new InputError('OPENVIKING_WIKI_UNAPPROVED');
  }
  const parsed = parseFrontmatter(input.content.replace(/^\uFEFF/, ''));
  readWikiEntryMetadata(`wiki/${input.entry}.md`, parsed.frontmatter, parsed.body);
  const sources = [...new Set(evidence.map(source => requireText(source, 'release evidence')))].sort();
  if (!sources.length || sources.some(source => /[\r\n]/.test(source))) throw new InputError('Missing release evidence');
  const db = openChanges(wiki);
  try {
    return transaction(db, () => saveChange(wiki, db, {
      operation: 'create', entry: input.entry, before: null, after: input.content, sources,
    }, readEntry(entryPath(wiki, input.entry))));
  } finally { db.close(); }
}

function assertUniqueContent(wiki: Wiki, entry: string, after: string): void {
  const matches = wiki.getEntriesByExactBody(parseFrontmatter(after).body).filter(page => page.id !== entry);
  if (matches.length > 0) {
    throw new InputError(`Wiki content already matches ${matches.map(page => page.id).join(', ')}; review the existing entries`);
  }
}

function writeChange(path: string, change: Change): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, change.after, { encoding: 'utf8', flag: 'wx' });
    if (change.before === null) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function applyWikiChange(wiki: Wiki, id: string) {
  exactChangeId(id);
  const db = openChanges(wiki);
  try {
    return transaction(db, () => {
      const row = db.prepare('SELECT * FROM wiki_changes WHERE id = ?').get(id);
      if (!row) throw new NotFoundError(`Wiki change not found: ${id}`);
      const { change, state, appliedAt } = readChange(id, row);
      if (state === 'applied') return { ...preview(id, change, state, appliedAt), replayed: true };
      const path = entryPath(wiki, change.entry);
      const current = readEntry(path);
      if (change.operation !== 'retire') assertUniqueContent(wiki, change.entry, change.after);
      if (current !== change.after) {
        if (current !== change.before) throw new InputError(`Wiki entry changed since review: ${change.entry}`);
        writeChange(path, change);
      }
      wiki.build();
      const time = new Date().toISOString();
      db.prepare("UPDATE wiki_changes SET state = 'applied', applied_at = ? WHERE id = ?").run(time, id);
      return { ...preview(id, change, 'applied', time), replayed: false };
    });
  } finally {
    db.close();
  }
}

export function listWikiChanges(wiki: Wiki, selection?: { id?: string; entry?: string }) {
  if (selection?.id) exactChangeId(selection.id);
  if (selection?.entry) entryPath(wiki, selection.entry);
  const path = closeoutDbPath(wiki.root);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return [];
  const db = openDb(path, true);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'wiki_changes' AND type = 'table'").get()) return [];
    return db.prepare(`SELECT * FROM wiki_changes
      WHERE (? IS NULL OR id = ?) AND (? IS NULL OR entry = ?) ORDER BY created_at, id`)
      .all(selection?.id ?? null, selection?.id ?? null, selection?.entry ?? null, selection?.entry ?? null).map(row => {
        const id = requireText(row.id, 'Wiki change ID');
        const { change, state, appliedAt } = readChange(id, row);
        return preview(id, change, state, appliedAt);
      });
  } finally {
    db.close();
  }
}

/**
 * 删除受管 Wiki 条目文件并刷新索引；受锁保护条目拒绝删除。
 */
export function deleteWikiEntry(wiki: Wiki, entryId: string): { deleted: boolean; id: string; path?: string } {
  const path = entryPath(wiki, entryId);
  const content = readEntry(path);
  if (content === null) return { deleted: false, id: entryId };
  const parsed = parseFrontmatter(content.replace(/^\uFEFF/, ''));
  if (parsed.frontmatter.locked === true) {
    throw new InputError(`Wiki entry is locked: ${entryId}`);
  }
  rmSync(path, { force: true });
  if (existsSync(join(wiki.root, 'wiki'))) {
    wiki.build();
  }
  return { deleted: true, id: entryId, path: `wiki/${entryId}.md` };
}
