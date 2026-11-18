import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { InputError, NotFoundError, pageOffset, pagination, requireText, searchLimit } from './common.js';
import type { KnowledgeReads } from './knowledge-reads.js';
import type { MemoryRecord, MemoryStore } from './memory.js';
import type { MemoryReader } from './memory-reader.js';
import { rrfMerge } from './upstream/search-utils.js';
import { slugify } from './upstream/slug.js';
import { applyWikiChange, proposeWikiChange } from './wiki-change.js';
import { appliesToContext, contextSpecificity, isRepositoryId, isWikiCategory, type WikiContext } from './wiki-entry.js';
import { readWikiPages, Wiki, type WikiHit } from './wiki.js';

export type KnowledgeKind = 'episodic' | 'reference' | 'constraint';
export type KnowledgeScope = 'project' | 'global' | 'local';
export type KnowledgeLayerScope = 'project' | 'global';
export type KnowledgeStorageKind = 'memory' | 'wiki';
export type KnowledgeAuthority = 'unverified_episodic' | 'advisory' | 'binding';
export type KnowledgeStatus = 'active' | 'deprecated' | 'needs_review';

export interface KnowledgeLayer {
  scope: KnowledgeLayerScope;
  wiki?: Wiki;
  memory?: MemoryStore;
  /** Read-only remote/frozen Memory (OpenViking); writes and listing stay on memory. */
  memoryReader?: MemoryReader;
}

export interface KnowledgeInput {
  id?: string;
  kind?: KnowledgeKind;
  title?: string;
  content?: string;
  type?: string;
  scene?: string;
  session?: string;
  priority?: number;
  sourceMessageIds?: string[];
  scope?: string[];
  categories?: string[];
  repositories?: string[];
  keywords?: string[];
  sources?: string[];
}

export interface KnowledgeMutationOptions {
  scope?: KnowledgeLayerScope;
  kind?: KnowledgeKind;
  evidence?: string[];
  apply?: boolean;
  knowledgeReads?: KnowledgeReads;
  fromSearchId?: string;
}

export interface KnowledgeFilters {
  scope?: KnowledgeScope;
  kind?: KnowledgeKind;
  status?: KnowledgeStatus | 'all';
  task?: string;
  paths?: string[];
  categories?: string[];
  repository?: string;
  keyword?: string;
  includePathScoped?: boolean;
  includeHistory?: boolean;
  resolved?: boolean;
  type?: string;
  scene?: string;
  session?: string;
  limit?: number;
  page?: number;
  hop?: number;
  preferredMemoryTypes?: readonly string[];
  knowledgeReads?: KnowledgeReads;
  fromSearchId?: string;
}

export interface KnowledgeRecord {
  id: string;
  rawId: string;
  source: 'kb';
  kind: KnowledgeKind;
  storageKind: KnowledgeStorageKind;
  authority: KnowledgeAuthority;
  scope: KnowledgeLayerScope;
  status: KnowledgeStatus;
  title: string;
  snippet: string;
  content: string;
  sources: string[];
  categories?: string[];
  repositories?: string[];
  keywords?: string[];
  entryScope?: string[];
  path?: string;
  type?: string;
  scene?: string;
  session?: string;
  priority?: number;
  exactValues?: string[];
  sourceMessageScope?: 'messages' | 'turn';
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  score?: number;
  hop?: number;
  via?: string;
  related?: WikiHit['related'];
}

const authorityByKind: Record<KnowledgeKind, KnowledgeAuthority> = {
  episodic: 'unverified_episodic',
  reference: 'advisory',
  constraint: 'binding',
};

const authorityWeights: Record<KnowledgeKind, number> = {
  constraint: 1.4,
  reference: 1.2,
  episodic: 0.8,
};

function makeSnippet(content: string): string {
  return content.replace(/^#+\s+.*$/gm, '').trim().replace(/\s+/g, ' ').slice(0, 160);
}

function normalizeFormalEntryId(rawId: string | undefined, title: string | undefined, content: string): string {
  if (rawId !== undefined) {
    const trimmed = requireText(rawId, 'knowledge entry ID');
    return trimmed.startsWith('entries/') ? trimmed : `entries/${trimmed}`;
  }
  const base = slugify(title?.trim() || content.slice(0, 48)).replace(/^-+|-+$/g, '');
  const fallback = createHash('sha256').update(content).digest('hex').slice(0, 10);
  const slug = /^[a-z0-9][a-z0-9_-]*$/.test(base) ? base : `entry-${fallback}`;
  return `entries/${slug}`;
}

function memoryToRecord(record: MemoryRecord, scope: KnowledgeLayerScope, score?: number): KnowledgeRecord {
  return {
    id: record.id,
    rawId: record.id,
    source: 'kb',
    kind: 'episodic',
    storageKind: 'memory',
    authority: 'unverified_episodic',
    scope,
    status: 'active',
    title: record.type || 'episodic',
    snippet: makeSnippet(record.content),
    content: record.content,
    sources: record.sourceMessageIds,
    type: record.type,
    scene: record.scene,
    session: record.session,
    priority: record.priority,
    ...(record.exactValues ? { exactValues: record.exactValues } : {}),
    ...(record.sourceMessageScope ? { sourceMessageScope: record.sourceMessageScope } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
    ...(score !== undefined ? { score } : {}),
  };
}

function wikiEntryToRecord(
  page: NonNullable<ReturnType<Wiki['getEntry']>>,
  scope: KnowledgeLayerScope,
  extras?: { score?: number; hop?: number; via?: string; related?: WikiHit['related'] },
): KnowledgeRecord {
  const kind: KnowledgeKind = page.entry?.mode ?? 'reference';
  return {
    id: page.id,
    rawId: page.id,
    source: 'kb',
    kind,
    storageKind: 'wiki',
    authority: authorityByKind[kind],
    scope,
    status: page.entry?.status ?? 'active',
    title: page.title,
    snippet: page.snippet,
    content: page.body,
    sources: page.sources,
    ...(page.entry?.categories ? { categories: page.entry.categories } : {}),
    ...(page.entry?.repositories ? { repositories: page.entry.repositories } : {}),
    ...(page.entry?.keywords ? { keywords: page.entry.keywords } : {}),
    ...(page.entry?.scope ? { entryScope: page.entry.scope } : {}),
    path: page.path,
    ...(extras?.score !== undefined ? { score: extras.score } : {}),
    ...(extras?.hop !== undefined ? { hop: extras.hop } : {}),
    ...(extras?.via !== undefined ? { via: extras.via } : {}),
    ...(extras?.related ? { related: extras.related } : {}),
  };
}

function validateFilters(filters: KnowledgeFilters): {
  limit: number;
  page: number;
  hop?: number;
  episodicScene?: string;
  wikiContext: WikiContext;
} {
  const limit = searchLimit(filters.limit);
  const page = filters.page ?? 1;
  if (!Number.isInteger(page) || page < 1) {
    throw new InputError('page must be a positive integer');
  }
  if (filters.hop !== undefined && (!Number.isInteger(filters.hop) || filters.hop < 0 || filters.hop > 5)) {
    throw new InputError('hop must be an integer between 0 and 5');
  }
  if (filters.categories && !filters.categories.every(isWikiCategory)) {
    throw new InputError('Unknown knowledge category');
  }
  if (filters.repository !== undefined && !isRepositoryId(filters.repository)) {
    throw new InputError('Expected a persisted repository UUID');
  }
  if (filters.task !== undefined && filters.scene !== undefined && filters.task !== filters.scene) {
    throw new InputError('task and scene filters must agree');
  }
  return {
    limit,
    page,
    hop: filters.hop,
    episodicScene: filters.scene ?? filters.task,
    wikiContext: {
      task: filters.task,
      paths: filters.paths,
      categories: filters.categories as WikiContext['categories'],
      repository: filters.repository,
      keyword: filters.keyword,
      includePathScoped: filters.includePathScoped,
    },
  };
}

function assertNoEpisodicWikiMetadata(input: KnowledgeInput): void {
  if (input.categories?.length || input.repositories?.length || input.keywords?.length || input.scope?.length) {
    throw new InputError('Episodic records do not support formal Wiki scope, categories, repositories, or keywords');
  }
}

function lookupScopeRecord(filters: KnowledgeFilters): Record<string, unknown> {
  return {
    ...(filters.repository ? { repository: filters.repository } : {}),
    ...(filters.task ? { task: filters.task } : {}),
    ...(filters.paths?.length ? { paths: filters.paths } : {}),
    ...(filters.categories?.length ? { categories: filters.categories } : {}),
  };
}

/**
 * 统一知识库存储门面：合并 SQLite episodic 记忆与 Markdown Wiki 条目为单一 CRUD 模型。
 */
export class KnowledgeStore {
  private readonly layers: readonly KnowledgeLayer[];

  constructor(layers: readonly KnowledgeLayer[]) {
    this.layers = [...layers];
  }

  private layersForScope(scope: KnowledgeScope = 'local'): KnowledgeLayer[] {
    if (scope === 'project') return this.layers.filter(layer => layer.scope === 'project');
    if (scope === 'global') return this.layers.filter(layer => layer.scope === 'global');
    const project = this.layers.filter(layer => layer.scope === 'project');
    const global = this.layers.filter(layer => layer.scope === 'global');
    return [...project, ...global];
  }

  private writableLayer(scope: KnowledgeLayerScope = 'project'): KnowledgeLayer {
    const layer = this.layers.find(item => item.scope === scope) ?? this.layers[0];
    if (!layer) throw new NotFoundError(`No knowledge layer configured for scope: ${scope}`);
    return layer;
  }

  async add(input: KnowledgeInput, options: KnowledgeMutationOptions = {}) {
    const kind: KnowledgeKind = options.kind ?? input.kind ?? 'episodic';
    const layer = this.writableLayer(options.scope ?? 'project');

    if (kind === 'episodic') {
      assertNoEpisodicWikiMetadata(input);
      if (!layer.memory) throw new NotFoundError(`Episodic store not configured for scope: ${layer.scope}`);
      if (input.id && layer.memory.get(input.id)) {
        throw new InputError(`Knowledge record already exists: ${input.id}`);
      }
      const saved = await layer.memory.create({
        id: input.id,
        content: requireText(input.content, 'content'),
        type: input.type,
        scene: input.scene,
        session: input.session,
        priority: input.priority,
        sourceMessageIds: input.sourceMessageIds ?? input.sources,
      });
      return memoryToRecord(saved, layer.scope);
    }

    if (!layer.wiki) throw new NotFoundError(`Wiki store not configured for scope: ${layer.scope}`);
    const content = requireText(input.content, 'content');
    const entry = normalizeFormalEntryId(input.id, input.title, content);
    const title = input.title ?? entry.replace(/^entries\//, '').replace(/[-_]+/g, ' ');
    const evidence = options.evidence ?? input.sources ?? [];
    const draft = {
      operation: 'create' as const,
      entry,
      title,
      mode: kind,
      scope: input.scope ?? ['project'],
      ...(input.categories !== undefined ? { categories: input.categories } : {}),
      ...(input.repositories !== undefined ? { repositories: input.repositories } : {}),
      ...(input.keywords !== undefined ? { keywords: input.keywords } : {}),
      body: content,
    };
    const proposed = proposeWikiChange(layer.wiki, draft, evidence);
    return options.apply ? applyWikiChange(layer.wiki, proposed.id) : proposed;
  }

  get(id: string, filters: KnowledgeFilters = {}): KnowledgeRecord | undefined {
    const key = requireText(id, 'record ID');
    const { wikiContext } = validateFilters(filters);
    const readOpts = { knowledgeReads: filters.knowledgeReads, fromSearchId: filters.fromSearchId };
    const wantWiki = filters.kind !== 'episodic';
    const wantMemory = filters.kind === undefined || filters.kind === 'episodic';

    for (const layer of this.layersForScope(filters.scope ?? 'local')) {
      let wikiRecord: KnowledgeRecord | undefined;
      if (wantWiki && layer.wiki?.hasWiki()) {
        if (filters.resolved) {
          const ref = layer.wiki.getReference(key, wikiContext);
          if (ref) {
            const mode = ref.entry?.mode ?? 'reference';
            if (!filters.kind || filters.kind === mode) {
              if (filters.knowledgeReads) {
                filters.knowledgeReads.recordRead({
                  kind: 'wiki', id: ref.id, fromSearchId: filters.fromSearchId, content: ref.body,
                });
              }
              wikiRecord = wikiEntryToRecord(ref, layer.scope);
            }
          } else {
            const raw = layer.wiki.getEntry(key);
            if (raw?.entry?.mode === 'constraint' && raw.entry.status === 'active' &&
                appliesToContext(raw.entry, wikiContext, raw.body) &&
                (!filters.kind || filters.kind === 'constraint')) {
              if (filters.knowledgeReads) {
                filters.knowledgeReads.recordRead({
                  kind: 'wiki', id: raw.id, fromSearchId: filters.fromSearchId, content: raw.body,
                });
              }
              wikiRecord = wikiEntryToRecord(raw, layer.scope);
            }
          }
        } else {
          const entry = layer.wiki.getEntry(key, readOpts);
          if (entry) {
            const mode = entry.entry?.mode ?? 'reference';
            const status = entry.entry?.status ?? 'active';
            const kindMatch = !filters.kind || filters.kind === mode;
            const statusMatch = !filters.status || filters.status === 'all' || filters.status === status;
            if (kindMatch && statusMatch) {
              wikiRecord = wikiEntryToRecord(entry, layer.scope);
            }
          }
        }
      }

      let memoryRecord: KnowledgeRecord | undefined;
      const statusAllowsMemory = !filters.status || filters.status === 'all' || filters.status === 'active';
      if (wantMemory && statusAllowsMemory && key.startsWith('ov:') && layer.memoryReader) {
        const remote = layer.memoryReader.get(key, readOpts);
        if (remote && typeof (remote as Promise<MemoryRecord | undefined>).then !== 'function') {
          memoryRecord = memoryToRecord(remote as MemoryRecord, layer.scope);
        }
      }
      if (!memoryRecord && wantMemory && layer.memory) {
        if (statusAllowsMemory) {
          const found = layer.memory.get(key, readOpts);
          if (found) memoryRecord = memoryToRecord(found, layer.scope);
        }
      }

      if (wikiRecord && memoryRecord) {
        const exactWiki = wikiRecord.id.toLowerCase() === key.toLowerCase();
        if (!exactWiki && filters.kind === undefined) {
          wikiRecord = undefined;
        } else {
          throw new InputError(`Knowledge ID "${key}" is ambiguous across wiki and memory; specify --kind`);
        }
      }
      if (wikiRecord) return wikiRecord;
      if (memoryRecord) return memoryRecord;
    }

    return undefined;
  }

  async update(id: string, input: KnowledgeInput, options: KnowledgeMutationOptions = {}) {
    const key = requireText(id, 'record ID');
    const explicitKind = options.kind ?? input.kind;
    const layers = options.scope ? this.layersForScope(options.scope) : this.layersForScope('local');

    for (const layer of layers) {
      const existingWiki = explicitKind !== 'episodic' && layer.wiki?.hasWiki()
        ? layer.wiki.getEntry(key)
        : null;
      const existingMemory = (explicitKind === undefined || explicitKind === 'episodic') && layer.memory
        ? layer.memory.get(key)
        : undefined;

      const exactWiki = existingWiki?.id.toLowerCase() === key.toLowerCase();
      if (existingWiki && existingMemory && explicitKind === undefined) {
        if (exactWiki) throw new InputError(`Knowledge ID "${key}" is ambiguous across wiki and memory; specify --kind`);
      }

      if (existingWiki && layer.wiki && (!existingMemory || explicitKind !== undefined || exactWiki)) {
        const currentMode = existingWiki.entry?.mode ?? 'reference';
        if (currentMode === 'constraint' && explicitKind === 'reference') {
          throw new InputError('Formal constraint cannot be downgraded to a reference');
        }
        const operation = explicitKind === 'constraint' && currentMode === 'reference' ? 'promote' : 'update';
        const evidence = options.evidence ?? input.sources ?? [];
        const draft = {
          operation,
          entry: existingWiki.id,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.content !== undefined ? { body: input.content } : {}),
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
          ...(input.categories !== undefined ? { categories: input.categories } : {}),
          ...(input.repositories !== undefined ? { repositories: input.repositories } : {}),
          ...(input.keywords !== undefined ? { keywords: input.keywords } : {}),
        };
        const proposed = proposeWikiChange(layer.wiki, draft, evidence);
        return options.apply ? applyWikiChange(layer.wiki, proposed.id) : proposed;
      }

      if (existingMemory && layer.memory) {
        assertNoEpisodicWikiMetadata(input);
        const sourceMessageIds = input.sourceMessageIds ?? input.sources;
        const updated = await layer.memory.update(existingMemory.id, {
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.scene !== undefined ? { scene: input.scene } : {}),
          ...(input.session !== undefined ? { session: input.session } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(sourceMessageIds !== undefined ? { sourceMessageIds } : {}),
        });
        if (!updated) throw new NotFoundError(`Knowledge record not found: ${key}`);
        return memoryToRecord(updated, layer.scope);
      }
    }

    throw new NotFoundError(`Knowledge record not found: ${key}`);
  }

  async delete(id: string, options: KnowledgeMutationOptions = {}) {
    const key = requireText(id, 'record ID');
    const layers = options.scope ? this.layersForScope(options.scope) : this.layersForScope('local');

    for (const layer of layers) {
      const existingWiki = options.kind !== 'episodic' && layer.wiki?.hasWiki()
        ? layer.wiki.getEntry(key)
        : null;
      const existingMemory = (options.kind === undefined || options.kind === 'episodic') && layer.memory
        ? layer.memory.get(key)
        : undefined;

      const exactWiki = existingWiki?.id.toLowerCase() === key.toLowerCase();
      if (existingWiki && existingMemory && options.kind === undefined && exactWiki) {
        throw new InputError(`Knowledge ID "${key}" is ambiguous across wiki and memory; specify --kind`);
      }

      if (existingWiki && layer.wiki && (options.kind === undefined || (existingWiki.entry?.mode ?? 'reference') === options.kind)
        && (!existingMemory || options.kind !== undefined || exactWiki)) {
        const evidence = options.evidence ?? [];
        const proposed = proposeWikiChange(layer.wiki, { operation: 'retire', entry: existingWiki.id }, evidence);
        return options.apply ? applyWikiChange(layer.wiki, proposed.id) : proposed;
      }

      if (existingMemory && layer.memory) {
        return { deleted: layer.memory.delete(existingMemory.id) };
      }
    }

    return { deleted: false };
  }

  constraints(filters: KnowledgeFilters = {}): KnowledgeRecord[] {
    const { wikiContext } = validateFilters(filters);
    const results: KnowledgeRecord[] = [];
    const seen = new Set<string>();
    const lookupScope = lookupScopeRecord(filters);

    for (const layer of this.layersForScope(filters.scope ?? 'local')) {
      if (!layer.wiki?.hasWiki()) continue;
      for (const page of layer.wiki.constraints(wikiContext)) {
        if (seen.has(page.id)) continue;
        seen.add(page.id);
        if (filters.knowledgeReads) {
          filters.knowledgeReads.bindConstraint({
            knowledgeId: page.id,
            scope: page.entry?.scope ?? [],
            categories: page.entry?.categories,
            content: page.body,
            storageScope: layer.scope,
            lookupScope,
          });
        }
        results.push(wikiEntryToRecord(page, layer.scope));
      }
    }

    return results;
  }

  async list(filters: KnowledgeFilters = {}) {
    const { limit, page, episodicScene, wikiContext } = validateFilters(filters);
    const offset = pageOffset(page, limit);
    const statusFilter = filters.status ?? (filters.includeHistory ? 'all' : 'active');
    const includeWiki = filters.kind !== 'episodic' &&
      filters.type === undefined && filters.scene === undefined && filters.session === undefined;
    const hasWikiOnlyFilters = Boolean(
      filters.categories?.length || filters.repository || filters.keyword ||
      filters.paths?.length || filters.includePathScoped,
    );
    const includeMemory = (!filters.kind || filters.kind === 'episodic') &&
      (statusFilter === 'active' || statusFilter === 'all') &&
      !hasWikiOnlyFilters;

    const wikiRecords: KnowledgeRecord[] = [];
    const memoryRecords: KnowledgeRecord[] = [];
    const seenWiki = new Set<string>();
    const seenMemory = new Set<string>();

    const hasContextFilters = Boolean(
      filters.resolved || filters.task || filters.paths?.length || filters.categories?.length ||
      filters.repository || filters.keyword || filters.includePathScoped,
    );

    for (const layer of this.layersForScope(filters.scope ?? 'local')) {
      if (includeWiki && layer.wiki && existsSync(join(layer.wiki.root, 'wiki'))) {
        for (const page of readWikiPages(layer.wiki.root)) {
          const mode: KnowledgeKind = page.entry?.mode ?? 'reference';
          const status: KnowledgeStatus = page.entry?.status ?? 'active';
          if (filters.kind && mode !== filters.kind) continue;
          if (statusFilter !== 'all' && status !== statusFilter) continue;
          if (page.entry) {
            if (hasContextFilters && !appliesToContext(page.entry, wikiContext, page.body)) continue;
          } else if (filters.kind === 'constraint' || filters.categories?.length || filters.repository || filters.keyword) {
            continue;
          }
          const key = `${mode}:${page.id}`;
          if (seenWiki.has(key)) continue;
          seenWiki.add(key);
          wikiRecords.push(wikiEntryToRecord(page, layer.scope));
        }
      }

      if (includeMemory && layer.memory) {
        for (let memPage = 1; ; memPage++) {
          const batch = layer.memory.list({
            limit: 100,
            page: memPage,
            type: filters.type,
            scene: episodicScene,
            session: filters.session,
          });
          for (const rec of batch.results) {
            if (seenMemory.has(rec.id)) continue;
            seenMemory.add(rec.id);
            memoryRecords.push(memoryToRecord(rec, layer.scope));
          }
          if (!batch.pagination || batch.pagination.nextPage === null) break;
        }
      }
    }

    const combined = [...wikiRecords, ...memoryRecords];
    return {
      results: combined.slice(offset, offset + limit),
      pagination: pagination(page, limit, combined.length > offset + limit),
    };
  }

  async search(query: string, filters: KnowledgeFilters = {}) {
    const text = requireText(query, 'query');
    const { limit, page, hop, episodicScene, wikiContext } = validateFilters(filters);
    const offset = pageOffset(page, limit);
    const statusFilter = filters.status ?? (filters.includeHistory ? 'all' : 'active');
    const includeHistory = Boolean(filters.includeHistory) || statusFilter !== 'active';
    const includeWiki = filters.kind !== 'episodic' &&
      filters.type === undefined && filters.scene === undefined && filters.session === undefined;
    const hasWikiOnlyFilters = Boolean(
      filters.categories?.length || filters.repository || filters.keyword ||
      filters.paths?.length || filters.includePathScoped,
    );
    const includeMemory = (!filters.kind || filters.kind === 'episodic') &&
      (statusFilter === 'active' || statusFilter === 'all') &&
      !hasWikiOnlyFilters;

    const wikiBuckets: KnowledgeRecord[] = [];
    const memoryBuckets: KnowledgeRecord[] = [];
    const seenWiki = new Set<string>();
    const seenMemory = new Set<string>();
    const lookupFilters = lookupScopeRecord(filters);

    for (const layer of this.layersForScope(filters.scope ?? 'local')) {
      if (includeWiki && layer.wiki && (Boolean(layer.wiki.readableIndexPath()) || layer.wiki.hasWiki())) {
        const pagesById = new Map(readWikiPages(layer.wiki.root).map(item => [item.id, item]));
        const rawHits = layer.wiki.searchAll(text, {
          hop,
          includeHistory,
          entryMode: filters.kind === 'constraint' ? 'constraint' : filters.kind === 'reference' ? 'reference' : undefined,
        }).results;
        const layerWikiHits: KnowledgeRecord[] = [];
        const hasContextFilters = Boolean(
          wikiContext.task || wikiContext.paths?.length || wikiContext.categories?.length ||
          wikiContext.repository || wikiContext.keyword || wikiContext.includePathScoped,
        );
        for (const hit of rawHits) {
          const full = pagesById.get(hit.id);
          const mode: KnowledgeKind = full?.entry?.mode ?? hit.entry?.mode ?? 'reference';
          const status: KnowledgeStatus = full?.entry?.status ?? hit.entry?.status ?? 'active';
          if (filters.kind && mode !== filters.kind) continue;
          if (statusFilter !== 'all' && status !== statusFilter) continue;
          if (full?.entry) {
            if (!appliesToContext(full.entry, wikiContext, full.body)) continue;
          } else if (filters.kind === 'constraint' || filters.categories?.length || filters.repository || filters.keyword) {
            continue;
          }
          const specificity = full?.entry && hasContextFilters ? contextSpecificity(full.entry, wikiContext) / 100 : 0;
          const record = full
            ? wikiEntryToRecord(full, layer.scope, {
                score: hit.score + specificity, hop: hit.hop, via: hit.via, related: hit.related,
              })
            : {
                id: hit.id, rawId: hit.id, source: 'kb' as const, kind: mode, storageKind: 'wiki' as const,
                authority: authorityByKind[mode], scope: layer.scope, status,
                title: hit.title, snippet: hit.snippet, content: hit.snippet, sources: hit.sources,
                path: hit.path, score: hit.score + specificity, hop: hit.hop, via: hit.via, related: hit.related,
              };
          layerWikiHits.push(record);
        }

        if (filters.knowledgeReads) {
          filters.knowledgeReads.recordSearch({
            source: 'wiki',
            query: text,
            filters: {
              scope: layer.scope,
              ...lookupFilters,
              page,
              limit,
              ...(hop !== undefined ? { hop } : {}),
            },
            returnedIds: layerWikiHits.map(item => item.rawId),
          });
        }

        for (const item of layerWikiHits) {
          const key = `${item.kind}:${item.id}`;
          if (seenWiki.has(key)) continue;
          seenWiki.add(key);
          wikiBuckets.push(item);
        }
      }

      const readableMemory = layer.memoryReader ?? layer.memory;
      if (includeMemory && readableMemory) {
        const layerMemHits: KnowledgeRecord[] = [];
        for (let memPage = 1; ; memPage++) {
          const batch = await readableMemory.search(text, {
            limit: 100,
            page: memPage,
            type: filters.type,
            scene: episodicScene,
            session: filters.session,
          });
          for (const hit of batch.results) {
            layerMemHits.push(memoryToRecord(hit, layer.scope, hit.score));
          }
          if (!batch.pagination || batch.pagination.nextPage === null) break;
        }

        if (filters.preferredMemoryTypes?.length) {
          const preferred = new Set(filters.preferredMemoryTypes);
          layerMemHits.sort((left, right) =>
            Number(preferred.has(right.type ?? '')) - Number(preferred.has(left.type ?? '')));
        }

        if (filters.knowledgeReads) {
          filters.knowledgeReads.recordSearch({
            source: 'memory',
            query: text,
            filters: {
              scope: layer.scope,
              page,
              limit,
              ...(filters.type !== undefined ? { type: filters.type } : {}),
              ...(episodicScene !== undefined ? { scene: episodicScene } : {}),
              ...(filters.session !== undefined ? { session: filters.session } : {}),
            },
            returnedIds: layerMemHits.map(item => item.rawId),
          });
        }

        for (const item of layerMemHits) {
          if (seenMemory.has(item.id)) continue;
          seenMemory.add(item.id);
          memoryBuckets.push(item);
        }
      }
    }

    // 同一存储域在跨层（project/global）去重后再融合，避免全局重复条目抬高自身排名。
    const fused = rrfMerge(
      [wikiBuckets, memoryBuckets].filter(bucket => bucket.length > 0),
      item => `${item.kind}:${item.id}`,
    ).map(({ rrfScore, ...item }) => ({
      ...item,
      score: rrfScore * authorityWeights[item.kind],
    })).sort((left, right) =>
      right.score - left.score || `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));

    return {
      results: fused.slice(offset, offset + limit),
      pagination: pagination(page, limit, fused.length > offset + limit),
    };
  }
}
