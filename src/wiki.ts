// Adapts the TencentDB Agent Memory Wiki manager and per-wiki index (MIT).
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { UndirectedGraph } from 'graphology';
import { InputError, NotFoundError, evolvePath, openDb, requireText, searchLimit, transaction } from './common.js';
import { parseFrontmatter, readSources } from './upstream/frontmatter.js';
import { graphMultiHopSearch } from './upstream/graph-search.js';
import { slugify } from './upstream/slug.js';
import { DEFAULT_PURPOSE, DEFAULT_SCHEMA } from './upstream/template.js';
import { tokenizeWiki } from './wiki-tokens.js';
import { appliesToContext, contextSpecificity, readWikiEntryMetadata, type WikiContext, type WikiEntryMetadata } from './wiki-entry.js';
import type { WikiIngestOptions } from './wiki-ingest.js';
import type { KnowledgeReads } from './knowledge-reads.js';
import {
  computeDecayFactor,
  computeUsageContentHash,
  type KnowledgeDecayKind,
  type KnowledgeUsageRecord,
} from './knowledge-decay.js';

interface Page {
  id: string;
  title: string;
  type: string;
  path: string;
  snippet: string;
  sources: string[];
  entry?: WikiEntryMetadata;
}

interface PageFile extends Page {
  body: string;
  tags: string[];
  links: string[];
  updatedAt: string;
  hasExplicitTimestamp: boolean;
}

export interface WikiSearchOptions {
  limit?: number;
  hop?: number;
  decay?: number;
  includeHistory?: boolean;
  entryMode?: 'constraint' | 'reference';
  nowMs?: number;
  applyDecay?: boolean;
  trackUsage?: boolean;
}

export interface WikiReadOptions {
  knowledgeReads?: KnowledgeReads;
  fromSearchId?: string;
  trackUsage?: boolean;
}

export interface WikiHit extends Page {
  score: number;
  hop: number;
  via?: string;
  related: Array<{ id: string; title: string; path: string; direction: 'in' | 'out' | 'both' }>;
}

export const structuralPages = new Set(['wiki/index.md', 'wiki/schema.md', 'wiki/purpose.md', 'wiki/log.md', 'wiki/overview.md']);

function resolvePageUpdatedAt(frontmatter: Record<string, unknown>, fullPath: string): { updatedAt: string; explicit: boolean } {
  for (const field of [frontmatter.timestamp, frontmatter.date]) {
    if (typeof field === 'string' && field.trim()) {
      const parsed = Date.parse(field.trim());
      if (Number.isFinite(parsed)) return { updatedAt: new Date(parsed).toISOString(), explicit: true };
    } else if (field instanceof Date && Number.isFinite(field.getTime())) {
      return { updatedAt: field.toISOString(), explicit: true };
    }
  }
  return { updatedAt: statSync(fullPath).mtime.toISOString(), explicit: false };
}

export function readWikiPages(root: string, entriesOnly = false): PageFile[] {
  const pages: PageFile[] = [];
  function walk(dir: string, prefix: string) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const path = `${prefix}/${entry.name}`;
      if (!entriesOnly && entry.isDirectory() && entry.name !== 'media') walk(full, path);
      if (!entry.isFile() || !/\.md$/i.test(entry.name) || structuralPages.has(path.toLowerCase())) continue;
      const content = readFileSync(full, 'utf8').replace(/^\uFEFF/, '');
      const { frontmatter, body } = parseFrontmatter(content);
      const title = typeof frontmatter.title === 'string' && frontmatter.title.trim()
        ? frontmatter.title.trim()
        : body.match(/^#\s+(.+)$/m)?.[1].trim() || basename(entry.name).replace(/\.md$/i, '').replaceAll('-', ' ');
      const snippet = typeof frontmatter.description === 'string' && frontmatter.description.trim()
        ? frontmatter.description.trim()
        : [...body.replace(/^#+\s+.*$/gm, '').trim()].slice(0, 160).join('').replace(/\s+/g, ' ');
      const entryMeta = path.startsWith('wiki/entries/') ? readWikiEntryMetadata(path, frontmatter, body) : undefined;
      const rawTags = Array.isArray(frontmatter.tags) ? frontmatter.tags.filter((item): item is string => typeof item === 'string') : [];
      const tags = [...new Set([...rawTags, ...(entryMeta?.keywords ?? []), ...(entryMeta?.categories ?? [])])];
      const resolvedTime = resolvePageUpdatedAt(frontmatter, full);
      pages.push({
        id: path.slice(5, -3), title, type: frontmatter.type.toLowerCase(), path, snippet,
        sources: readSources(content), body, tags,
        updatedAt: resolvedTime.updatedAt, hasExplicitTimestamp: resolvedTime.explicit,
        ...(entryMeta ? { entry: entryMeta } : {}),
        links: [...body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map(link => link[1].trim()),
      });
    }
  }
  if (entriesOnly) {
    const wiki = lstatSync(join(root, 'wiki'), { throwIfNoEntry: false });
    if (!wiki) return pages;
    const entries = wiki.isDirectory() ? lstatSync(join(root, 'wiki', 'entries'), { throwIfNoEntry: false }) : undefined;
    if (!wiki.isDirectory() || (entries && !entries.isDirectory())) throw new InputError('Expected a regular Wiki entries directory');
    if (entries) walk(join(root, 'wiki', 'entries'), 'wiki/entries');
  } else {
    walk(join(root, 'wiki'), 'wiki');
  }
  return pages;
}

function findEntry(pages: PageFile[], id: string) {
  const key = requireText(id, 'wiki entry ID').toLowerCase();
  const managedMatches = pages.filter(page => page.entry && (
    page.id.toLowerCase() === key || page.id.toLowerCase() === `entries/${key}` ||
    page.entry.aliases.some(alias => alias.toLowerCase() === key)
  ));
  if (managedMatches.length > 1) throw new InputError(`Ambiguous Wiki entry ID: ${id}`);
  let page = managedMatches[0] ?? pages.find(item => !item.entry && item.id.toLowerCase() === key);
  if (!page && /^(?:entries\/)?legacy-[a-f0-9]{8,}$/i.test(key)) {
    const prefix = key.startsWith('entries/') ? key : `entries/${key}`;
    const prefixMatches = pages.filter(item => item.entry && item.id.toLowerCase().startsWith(prefix));
    if (prefixMatches.length > 1) throw new InputError(`Ambiguous Wiki entry ID: ${id}`);
    page = prefixMatches[0];
  }
  if (!page) return null;
  const { links: _links, tags: _tags, ...entry } = page;
  return entry;
}

function wikiFingerprint(root: string): string {
  const wikiRoot = join(root, 'wiki');
  if (!existsSync(wikiRoot)) return '';
  const entries: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, item.name);
      const rel = `${prefix}/${item.name}`;
      if (item.isDirectory() && item.name !== 'media') walk(full, rel);
      else if (item.isFile() && /\.md$/i.test(item.name)) {
        const stat = statSync(full);
        entries.push(`${rel}:${Math.floor(stat.mtimeMs)}:${stat.size}`);
      }
    }
  };
  walk(wikiRoot, 'wiki');
  return createHash('sha256').update(`tok:v2\n${entries.join('\n')}`).digest('hex');
}

export function initWiki(root: string, options: { purpose?: string; schema?: string; force?: boolean } = {}) {
  const resolvedRoot = resolve(root);
  const wikiDir = join(resolvedRoot, 'wiki');
  const entriesDir = join(wikiDir, 'entries');
  mkdirSync(entriesDir, { recursive: true });
  const files: Array<{ rel: string; path: string; content: string }> = [
    { rel: 'wiki/purpose.md', path: join(wikiDir, 'purpose.md'), content: `# Wiki Purpose\n\n${options.purpose?.trim() || DEFAULT_PURPOSE}\n` },
    { rel: 'wiki/schema.md', path: join(wikiDir, 'schema.md'), content: `# Wiki Schema\n\n${options.schema?.trim() || DEFAULT_SCHEMA}\n` },
  ];
  const created: string[] = [];
  const kept: string[] = [];
  for (const file of files) {
    if (existsSync(file.path) && !options.force) {
      kept.push(file.rel);
      continue;
    }
    writeFileSync(file.path, file.content, 'utf8');
    created.push(file.rel);
  }
  const wiki = new Wiki(resolvedRoot);
  const stats = readWikiPages(resolvedRoot).length > 0 ? wiki.build() : { pages: 0, edges: 0 };
  return { root: resolvedRoot, created, kept, ...stats };
}

function resolveEdges(pages: PageFile[]) {
  const visible = pages.filter(page => page.type !== 'query');
  const byId = new Map(visible.map(page => [page.id.toLowerCase(), page.id]));
  const aliases = new Map<string, string | undefined>();
  const stableAliases = new Map<string, string>();
  for (const page of visible) {
    for (const key of new Set([slugify(page.title), slugify(page.id.split('/').at(-1)!)])) {
      if (key) aliases.set(key, aliases.has(key) ? undefined : page.id);
    }
    for (const alias of page.entry?.aliases ?? []) {
      const key = alias.toLowerCase();
      const previous = byId.get(key) ?? byId.get(`entries/${key}`) ?? stableAliases.get(key);
      if (previous && previous !== page.id) throw new InputError(`Duplicate Wiki alias: ${alias}`);
      stableAliases.set(key, page.id);
    }
  }
  return visible.flatMap(page => {
    const targets = new Set<string>();
    for (const link of page.links) {
      const key = link.replaceAll('\\', '/').replace(/^wiki\//i, '').replace(/\.md$/i, '');
      const target = byId.get(key.toLowerCase()) ?? stableAliases.get(key.toLowerCase()) ?? aliases.get(slugify(key));
      if (target && target !== page.id) targets.add(target);
    }
    return [...targets].map(target => ({ source: page.id, target }));
  });
}

export class Wiki {
  readonly root: string;
  readonly indexPath: string;
  private readonly legacyIndexPath: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.indexPath = evolvePath(this.root, 'index.db');
    this.legacyIndexPath = join(this.root, 'index.db');
  }

  hasWiki(): boolean {
    return lstatSync(join(this.root, 'wiki'), { throwIfNoEntry: false })?.isDirectory() ?? false;
  }

  /**
   * 返回当前可读的 Wiki 索引路径，优先 `.evolve/index.db`，兼容旧版根目录 `index.db`。
   */
  readableIndexPath(): string | undefined {
    if (lstatSync(this.indexPath, { throwIfNoEntry: false })?.isFile()) return this.indexPath;
    if (lstatSync(this.legacyIndexPath, { throwIfNoEntry: false })?.isFile()) return this.legacyIndexPath;
    return undefined;
  }

  private isIndexStale(indexPath: string): boolean {
    const expected = wikiFingerprint(this.root);
    const db = openDb(indexPath, true);
    try {
      const hasState = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wiki_state'").get();
      if (!hasState) return true;
      const row = db.prepare("SELECT value FROM wiki_state WHERE key = 'fingerprint'").get() as { value?: string } | undefined;
      return row?.value !== expected;
    } catch {
      return true;
    } finally {
      db.close();
    }
  }

  private ensureIndexPath(): string | undefined {
    const existing = this.readableIndexPath();
    if (!existing) {
      if (!this.hasWiki()) return undefined;
      try {
        this.build();
        return this.indexPath;
      } catch {
        return undefined;
      }
    }
    // 仅自动刷新 .evolve/index.db，保留旧版根目录 index.db 兼容读取直到显式 wiki build。
    if (existing === this.indexPath && this.hasWiki() && this.isIndexStale(existing)) {
      try {
        this.build();
      } catch {
        // 只读环境保留现有可读索引。
      }
    }
    return existing;
  }

  async ingest(source: string, options: WikiIngestOptions) {
    const { ingestWiki } = await import('./wiki-ingest.js');
    return ingestWiki(this, source, options);
  }

  constraints(context: WikiContext = {}) {
    if (!existsSync(join(this.root, 'wiki'))) return [];
    return readWikiPages(this.root).filter(page =>
      page.entry?.mode === 'constraint' && page.entry.status === 'active' && appliesToContext(page.entry, context, page.body)
    ).sort((left, right) => contextSpecificity(right.entry!, context) - contextSpecificity(left.entry!, context))
      .map(({ links: _links, tags: _tags, ...page }) => page);
  }

  getEntry(id: string, options: WikiReadOptions = {}) {
    if (!existsSync(join(this.root, 'wiki'))) return null;
    const entry = findEntry(readWikiPages(this.root), id);
    if (entry && options.knowledgeReads) {
      options.knowledgeReads.recordRead({
        kind: 'wiki', id: entry.id, fromSearchId: options.fromSearchId,
        content: entry.body,
      });
    }
    if (entry && options.trackUsage) {
      this.recordRead(entry.id, entry.body, entry.updatedAt);
    }
    return entry;
  }

  private visibleReferences(context: WikiContext) {
    if (!existsSync(join(this.root, 'wiki'))) return [];
    return readWikiPages(this.root, false).filter(page => page.entry
      ? page.entry.mode === 'reference' && page.entry.status === 'active' && appliesToContext(page.entry, context, page.body)
      : true);
  }

  getReference(id: string, context: WikiContext = {}, options: WikiReadOptions = {}) {
    const entry = findEntry(this.visibleReferences(context), id);
    if (entry && options.knowledgeReads) {
      options.knowledgeReads.recordRead({
        kind: 'wiki', id: entry.id, fromSearchId: options.fromSearchId,
        content: entry.body,
      });
    }
    if (entry && options.trackUsage) {
      this.recordRead(entry.id, entry.body, entry.updatedAt);
    }
    return entry;
  }

  private withUsageWriter(run: (db: DatabaseSync) => void): void {
    const indexPath = this.readableIndexPath();
    if (!indexPath) return;
    let db: DatabaseSync | undefined;
    try {
      db = openDb(indexPath);
      db.exec(`CREATE TABLE IF NOT EXISTS wiki_usage (
        page_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        content_changed_at TEXT NOT NULL,
        search_hits INTEGER NOT NULL DEFAULT 0,
        read_count INTEGER NOT NULL DEFAULT 0,
        last_hit_at TEXT,
        last_read_at TEXT
      )`);
      transaction(db, () => run(db!));
    } catch {
      // 只读索引或锁冲突时静默降级，不阻塞检索。
    } finally {
      db?.close();
    }
  }

  recordHits(pageIds: readonly string[], now = new Date().toISOString()): void {
    const unique = [...new Set(pageIds.filter(Boolean))];
    if (!unique.length) return;
    this.withUsageWriter(db => {
      const insert = db.prepare(`INSERT OR IGNORE INTO wiki_usage (page_id, content_hash, content_changed_at) VALUES (?, '', ?)`);
      const update = db.prepare('UPDATE wiki_usage SET search_hits = search_hits + 1, last_hit_at = ? WHERE page_id = ?');
      for (const pageId of unique) {
        insert.run(pageId, now);
        update.run(now, pageId);
      }
    });
  }

  recordRead(pageId: string, body = '', updatedAt = new Date().toISOString(), now = new Date().toISOString()): void {
    if (!pageId) return;
    this.withUsageWriter(db => {
      db.prepare(`INSERT OR IGNORE INTO wiki_usage (page_id, content_hash, content_changed_at) VALUES (?, ?, ?)`)
        .run(pageId, computeUsageContentHash(body), updatedAt);
      db.prepare('UPDATE wiki_usage SET read_count = read_count + 1, last_read_at = ? WHERE page_id = ?')
        .run(now, pageId);
    });
  }

  getUsage(pageId: string): KnowledgeUsageRecord | undefined {
    return this.getUsageMap([pageId]).get(pageId);
  }

  getUsageMap(pageIds?: readonly string[]): Map<string, KnowledgeUsageRecord> {
    const map = new Map<string, KnowledgeUsageRecord>();
    const indexPath = this.readableIndexPath();
    if (!indexPath) return map;
    const db = openDb(indexPath, true);
    try {
      const hasUsage = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wiki_usage'").get();
      if (!hasUsage) return map;
      const where = pageIds?.length ? `WHERE page_id IN (${pageIds.map(() => '?').join(',')})` : '';
      const rows = db.prepare(`SELECT page_id, content_hash, content_changed_at, search_hits, read_count, last_hit_at, last_read_at
        FROM wiki_usage ${where}`).all(...(pageIds?.length ? pageIds : [])) as Array<{
          page_id: string; content_hash: string; content_changed_at: string;
          search_hits: number; read_count: number; last_hit_at: string | null; last_read_at: string | null;
        }>;
      for (const row of rows) {
        map.set(row.page_id, {
          contentHash: row.content_hash,
          contentChangedAt: row.content_changed_at,
          searchHits: row.search_hits,
          readCount: row.read_count,
          ...(row.last_hit_at ? { lastHitAt: row.last_hit_at } : {}),
          ...(row.last_read_at ? { lastReadAt: row.last_read_at } : {}),
        });
      }
      return map;
    } finally {
      db.close();
    }
  }

  references(query: string, context: WikiContext = {}, options: WikiSearchOptions = {}) {
    const indexPath = this.ensureIndexPath();
    if (indexPath) {
      const pages = new Map(readWikiPages(this.root, false).map(page => [page.id, page]));
      const db = openDb(indexPath, true);
      let out: { results: WikiHit[]; links: Array<{ source: string; target: string }> };
      try {
        db.exec('BEGIN');
        const result = searchIndex(db, query, {
          ...options,
          limit: 100,
          includeHistory: false,
          entryMode: 'reference',
        });
        const filtered = result.results.filter(hit => {
          const page = pages.get(hit.id);
          if (!page) return false;
          if (!page.entry) return true;
          return page.entry.mode === 'reference' && page.entry.status === 'active' &&
            appliesToContext(page.entry, context, page.body);
        });
        const limit = searchLimit(options.limit);
        const results = filtered
          .map(hit => {
            const page = pages.get(hit.id)!;
            return {
              ...hit,
              score: hit.score + (page.entry ? contextSpecificity(page.entry, context) / 100 : 0),
            };
          })
          .sort((left, right) => {
            const leftManaged = Boolean(pages.get(left.id)?.entry);
            const rightManaged = Boolean(pages.get(right.id)?.entry);
            return Number(rightManaged) - Number(leftManaged) || right.score - left.score || left.id.localeCompare(right.id);
          })
          .slice(0, limit);
        const included = new Set(results.map(result => result.id));
        out = {
          results,
          links: result.links.filter(link => {
            const source = link.source.replace(/^wiki\//, '').replace(/\.md$/i, '');
            const target = link.target.replace(/^wiki\//, '').replace(/\.md$/i, '');
            return included.has(source) && included.has(target);
          }),
        };
      } finally {
        db.close();
      }
      if (options.trackUsage && out.results.length > 0) {
        this.recordHits(out.results.map(item => item.id));
      }
      return out;
    }
    const db = openDb(':memory:');
    try {
      const visible = this.visibleReferences(context);
      const managedIds = new Set(visible.filter(page => page.entry).map(page => page.id));
      transaction(db, () => indexPages(db, visible));
      const limit = searchLimit(options.limit);
      const raw = searchIndex(db, query, { ...options, limit: 100 });
      const results = raw.results
        .sort((left, right) => Number(managedIds.has(right.id)) - Number(managedIds.has(left.id)) || right.score - left.score || left.id.localeCompare(right.id))
        .slice(0, limit);
      return { results, links: raw.links };
    } finally {
      db.close();
    }
  }

  getEntryByExactBody(body: string) {
    const matches = this.getEntriesByExactBody(body);
    return matches.length === 1 ? matches[0] : null;
  }

  getEntriesByExactBody(body: string) {
    if (!existsSync(join(this.root, 'wiki'))) return [];
    const normalized = body.trim().replace(/\s+/g, ' ');
    return readWikiPages(this.root).filter(page =>
      page.entry?.status === 'active' && page.body.trim().replace(/\s+/g, ' ') === normalized
    );
  }

  build() {
    if (!existsSync(join(this.root, 'wiki'))) throw new NotFoundError('Missing wiki/ directory');
    mkdirSync(dirname(this.indexPath), { recursive: true });
    const fingerprint = wikiFingerprint(this.root);
    const db = openDb(this.indexPath);
    try {
      return transaction(db, () => indexPages(db, readWikiPages(this.root), fingerprint));
    } finally {
      db.close();
    }
  }

  search(query: string, options: WikiSearchOptions = {}) {
    const result = this.searchWithLimit(query, options, false);
    if (options.trackUsage && result.results.length > 0) {
      this.recordHits(result.results.map(item => item.id));
    }
    return result;
  }

  searchAll(query: string, options: Omit<WikiSearchOptions, 'limit'> = {}) {
    return this.searchWithLimit(query, options, true);
  }

  private searchWithLimit(query: string, options: WikiSearchOptions, all: boolean) {
    const indexPath = this.ensureIndexPath();
    if (!indexPath) throw new NotFoundError('Wiki index missing. Run wiki build first.');
    const db = openDb(indexPath, true);
    try {
      db.exec('BEGIN');
      return searchIndex(db, query, options, all);
    } finally {
      db.close();
    }
  }
}

function indexPages(db: DatabaseSync, pages: PageFile[], fingerprint?: string) {
  const edges = resolveEdges(pages);
  db.exec(`
    DROP TABLE IF EXISTS wiki_fts;
    CREATE VIRTUAL TABLE wiki_fts USING fts5(
      page_id UNINDEXED, title_tok, tags_tok, content_tok, tokenize='unicode61 remove_diacritics 0'
    );
    CREATE TABLE IF NOT EXISTS page_meta (
      page_id TEXT PRIMARY KEY, title TEXT, type TEXT, rel_path TEXT, snippet TEXT
    );
    CREATE TABLE IF NOT EXISTS page_sources (page_id TEXT PRIMARY KEY, sources TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wiki_entries (
      page_id TEXT PRIMARY KEY, status TEXT NOT NULL, metadata TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS graph_edge (
      source_id TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY (source_id, target_id)
    );
    CREATE TABLE IF NOT EXISTS wiki_state (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wiki_usage (
      page_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      content_changed_at TEXT NOT NULL,
      search_hits INTEGER NOT NULL DEFAULT 0,
      read_count INTEGER NOT NULL DEFAULT 0,
      last_hit_at TEXT,
      last_read_at TEXT
    );
    DELETE FROM page_meta;
    DELETE FROM page_sources;
    DELETE FROM wiki_entries;
    DELETE FROM graph_edge;
  `);
  if (fingerprint !== undefined) {
    db.prepare("INSERT OR REPLACE INTO wiki_state (key, value) VALUES ('fingerprint', ?)").run(fingerprint);
  }
  const fts = db.prepare('INSERT INTO wiki_fts(page_id, title_tok, tags_tok, content_tok) VALUES (?, ?, ?, ?)');
  const meta = db.prepare('INSERT INTO page_meta(page_id, title, type, rel_path, snippet) VALUES (?, ?, ?, ?, ?)');
  const source = db.prepare('INSERT INTO page_sources(page_id, sources) VALUES (?, ?)');
  const edge = db.prepare('INSERT INTO graph_edge(source_id, target_id) VALUES (?, ?)');
  const entry = db.prepare('INSERT INTO wiki_entries(page_id, status, metadata) VALUES (?, ?, ?)');
  const usage = db.prepare(`INSERT INTO wiki_usage (page_id, content_hash, content_changed_at) VALUES (?, ?, ?)
    ON CONFLICT(page_id) DO UPDATE SET
      content_hash = excluded.content_hash,
      content_changed_at = CASE
        WHEN ? = 1 OR wiki_usage.content_hash != excluded.content_hash THEN excluded.content_changed_at
        ELSE wiki_usage.content_changed_at
      END`);
  for (const page of pages) {
    fts.run(
      page.id,
      tokenizeWiki(page.title).join(' '),
      tokenizeWiki(page.tags.join(' ')).join(' '),
      tokenizeWiki(page.body).join(' '),
    );
    meta.run(page.id, page.title, page.type, page.path, page.snippet);
    source.run(page.id, JSON.stringify(page.sources));
    if (page.entry) entry.run(page.id, page.entry.status, JSON.stringify(page.entry));
    usage.run(page.id, computeUsageContentHash(page.body), page.updatedAt, page.hasExplicitTimestamp ? 1 : 0);
  }
  for (const { source, target } of edges) edge.run(source, target);
  if (fingerprint !== undefined) {
    const activeIds = new Set(pages.map(page => page.id));
    const tracked = db.prepare('SELECT page_id FROM wiki_usage').all() as Array<{ page_id: string }>;
    const remove = db.prepare('DELETE FROM wiki_usage WHERE page_id = ?');
    for (const row of tracked) {
      if (!activeIds.has(row.page_id)) remove.run(row.page_id);
    }
  }
  return { pages: pages.length, edges: edges.length };
}

function searchIndex(db: DatabaseSync, query: string, options: WikiSearchOptions, all = false): {
  results: WikiHit[];
  links: Array<{ source: string; target: string }>;
} {
  const tokens = [...new Set(tokenizeWiki(requireText(query, 'query')))];
  const limit = searchLimit(options.limit);
  const { hop = 0, decay = 0.5 } = options;
  const shouldDecay = options.applyDecay !== false;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isInteger(hop) || hop < 0 || hop > 5) {
    throw new InputError('hop must be an integer between 0 and 5');
  }
  if (!Number.isFinite(decay) || decay <= 0 || decay > 1) {
    throw new InputError('decay must be greater than 0 and at most 1');
  }
  if (!tokens.length) return { results: [], links: [] };
  const expression = tokens.map(token => '"' + token.replaceAll('"', '""') + '"*').join(' OR ');
  const entries = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wiki_entries'").get();
  const visibility = entries && !options.includeHistory
    ? "AND page_id NOT IN (SELECT page_id FROM wiki_entries WHERE status <> 'active')"
    : '';
  const modeVisibility = entries && options.entryMode
    ? (options.entryMode === 'reference'
      ? "AND (page_id NOT IN (SELECT page_id FROM wiki_entries) OR page_id IN (SELECT page_id FROM wiki_entries WHERE json_extract(metadata, '$.mode') = ?))"
      : "AND page_id IN (SELECT page_id FROM wiki_entries WHERE json_extract(metadata, '$.mode') = ?)")
    : '';
  const hasTagsColumn = (db.prepare('PRAGMA table_info(wiki_fts)').all() as Array<{ name: string }>)
    .some(column => column.name === 'tags_tok');
  const scoreExpr = hasTagsColumn ? '-bm25(wiki_fts, 0.0, 5.0, 3.0, 1.0)' : '-bm25(wiki_fts, 0.0, 5.0, 1.0)';
  const candidateLimit = all ? -1 : shouldDecay ? Math.max(limit * 3, hop ? limit * 2 : limit) : (hop ? limit * 2 : limit);
  const seedArgs = entries && options.entryMode ? [expression, options.entryMode, candidateLimit] : [expression, candidateLimit];
  const seeds = db.prepare(`
    SELECT page_id AS id, ${scoreExpr} AS score
    FROM wiki_fts WHERE wiki_fts MATCH ? ${visibility} ${modeVisibility} ORDER BY score DESC, page_id LIMIT ?
  `).all(...seedArgs) as Array<{ id: string; score: number }>;
  if (!seeds.length) return { results: [], links: [] };
  return readHits(db, seeds, all ? Number.MAX_SAFE_INTEGER : limit, hop, decay, Boolean(entries), Boolean(options.includeHistory), options.entryMode, all, shouldDecay, nowMs);
}

function readHits(
  db: DatabaseSync,
  seeds: { id: string; score: number }[],
  limit: number,
  hop: number,
  decay: number,
  hasEntries: boolean,
  includeHistory: boolean,
  entryMode?: 'constraint' | 'reference',
  all = false,
  shouldDecay = true,
  nowMs = Date.now(),
) {
  const hasSources = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='page_sources'").get();
  const hasUsage = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wiki_usage'").get();
  const modeVisibility = hasEntries && entryMode
    ? (entryMode === 'reference'
      ? "AND (e.page_id IS NULL OR json_extract(e.metadata, '$.mode') = ?)"
      : "AND json_extract(e.metadata, '$.mode') = ?")
    : '';
  const pageArgs = hasEntries && entryMode ? [entryMode] : [];
  const rows = db.prepare(`SELECT m.page_id AS id, m.title, m.type, m.rel_path AS path, m.snippet,
    ${hasSources ? "COALESCE(s.sources, '[]')" : "'[]'"} AS sources,
    ${hasEntries ? 'e.metadata' : 'NULL'} AS metadata
    FROM page_meta m ${hasSources ? 'LEFT JOIN page_sources s USING(page_id)' : ''}
    ${hasEntries ? 'LEFT JOIN wiki_entries e USING(page_id)' : ''}
    ${hasEntries && !includeHistory ? `WHERE (e.status IS NULL OR e.status = 'active') ${modeVisibility}` : modeVisibility ? `WHERE ${modeVisibility.slice(4)}` : ''}`)
    .all(...pageArgs) as (Omit<Page, 'sources' | 'entry'> & { sources: string; metadata: string | null })[];
  const pages = new Map(rows.map(({ metadata, ...row }) => [row.id, {
    ...row, path: row.path.replaceAll('\\', '/'), sources: JSON.parse(row.sources) as string[],
    ...(metadata ? { entry: JSON.parse(metadata) as WikiEntryMetadata } : {}),
  }]));
  const usageRows = hasUsage
    ? db.prepare('SELECT page_id, content_changed_at, read_count FROM wiki_usage').all() as Array<{
        page_id: string; content_changed_at: string; read_count: number;
      }>
    : [];
  const usageById = new Map(usageRows.map(row => [row.page_id, row]));
  const graph = new UndirectedGraph();
  const outgoing = new Map<string, Set<string>>();
  for (const page of pages.values()) {
    graph.addNode(page.id, { label: page.title });
    outgoing.set(page.id, new Set());
  }
  const edges = db.prepare('SELECT source_id AS source, target_id AS target FROM graph_edge ORDER BY source_id, target_id')
    .all() as Array<{ source: string; target: string }>;
  for (const { source, target } of edges) {
    if (source === target || !graph.hasNode(source) || !graph.hasNode(target)) continue;
    graph.mergeUndirectedEdge(source, target);
    outgoing.get(source)!.add(target);
  }
  const expanded = graphMultiHopSearch(graph, seeds, { hop, decay, minScore: 0,
    ...(all ? { maxNodes: pages.size } : {}),
  })
    .map(hit => {
      const page = pages.get(hit.id)!;
      const decayKind: KnowledgeDecayKind = page.entry?.mode ?? 'reference';
      const usage = usageById.get(hit.id);
      const timeFactor = shouldDecay && usage?.content_changed_at
        ? computeDecayFactor({ kind: decayKind, contentChangedAt: usage.content_changed_at, readCount: usage.read_count, nowMs })
        : 1;
      const conflictFactor = page.entry?.confidence === 'contested'
        ? 0.5
        : page.entry?.status === 'needs_review'
          ? 0.6
          : page.entry?.conflictsWith?.length
            ? 0.7
            : 1;
      return { ...hit, score: hit.score * timeFactor * conflictFactor };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
  const results: WikiHit[] = expanded.map(({ id, score, hop, via }) => ({
    ...pages.get(id)!, score, hop, via,
    related: graph.neighbors(id).sort((a, b) => graph.degree(b) - graph.degree(a) || a.localeCompare(b)).slice(0, 10)
      .map(neighbor => ({
        id: neighbor,
        title: pages.get(neighbor)!.title,
        path: pages.get(neighbor)!.path,
        direction: outgoing.get(id)!.has(neighbor) ? (outgoing.get(neighbor)!.has(id) ? 'both' : 'out') : 'in',
      })),
  }));
  const included = new Set(results.map(result => result.id));
  const links = edges.filter(({ source, target }) => included.has(source) && included.has(target))
    .map(({ source, target }) => ({ source: pages.get(source)!.path, target: pages.get(target)!.path }));
  return { results, links };
}
