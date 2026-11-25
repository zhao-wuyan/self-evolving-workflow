import { createHash } from 'node:crypto';
import {
  createAgentMemoryEnvelope,
  type AgentMemoryContextScope,
  type AgentMemoryEnvelope,
} from './context-envelope.js';
import { codeMatchesPaths, isCodeLockError, type CodeGraph } from './code.js';
import { InputError, NotFoundError, pageOffset, pagination, requireText, searchLimit } from './common.js';
import type { KnowledgeFilters, KnowledgeKind, KnowledgeRecord, KnowledgeStore } from './kb.js';
import type { MemorySearchOptions } from './memory.js';
import type { MemoryReader, MemorySearchResult } from './memory-reader.js';
import type { Wiki, WikiSearchOptions } from './wiki.js';
import type { WikiContext } from './wiki-entry.js';
import type { KnowledgeReads } from './knowledge-reads.js';
import { rrfMerge } from './upstream/search-utils.js';
import { applyBoundedExploration } from './knowledge-decay.js';
import { STOP_WORDS, WIKI_TOKEN_SPLIT_REGEX, tokenizeWiki } from './wiki-tokens.js';

export interface SearchSources {
  code?: CodeGraph;
  wiki?: Wiki;
  memory?: MemoryReader;
  repositoryId?: string;
}

export type SearchScope = 'code' | 'wiki' | 'memory' | 'all';

export interface SearchOptions {
  scope?: SearchScope;
  limit?: number;
  wiki?: Omit<WikiSearchOptions, 'limit'>;
  memory?: Omit<MemorySearchOptions, 'limit'>;
  knowledgeReads?: KnowledgeReads;
}

export interface ContextOptions {
  limit?: number;
  context?: WikiContext;
  wiki?: Omit<WikiSearchOptions, 'limit'>;
  memory?: Omit<MemorySearchOptions, 'limit'>;
  contextScope?: AgentMemoryContextScope;
  includeWorkingMemory?: boolean;
  preferredMemoryTypes?: readonly string[];
  knowledgeReads?: KnowledgeReads;
}

/**
 * 优先排序命中 search_profile 指定类型的记忆条目，不丢失其余候选。
 */
export function prioritizeMemoryHits<T extends { type: string }>(
  hits: readonly T[],
  preferredTypes?: readonly string[],
): T[] {
  if (!preferredTypes?.length) return [...hits];
  const preferred = new Set(preferredTypes);
  const prioritized: T[] = [];
  const rest: T[] = [];
  for (const hit of hits) {
    if (preferred.has(hit.type)) prioritized.push(hit);
    else rest.push(hit);
  }
  return [...prioritized, ...rest];
}

export interface SearchResults {
  code?: Awaited<ReturnType<CodeGraph['search']>>;
  wiki?: ReturnType<Wiki['search']>;
  memory?: MemorySearchResult;
}

export function parseScope(scope: string): SearchScope {
  if (scope === 'all' || scope === 'code' || scope === 'wiki' || scope === 'memory') return scope;
  throw new InputError('scope must be all, code, wiki or memory');
}

export async function search(sources: SearchSources, query: string, options: SearchOptions = {}): Promise<SearchResults> {
  const text = requireText(query, 'query');
  const limit = searchLimit(options.limit);
  const scope = parseScope(options.scope ?? 'all');
  if (scope !== 'all' && !sources[scope]) throw new NotFoundError(`Search source is not configured: ${scope}`);
  const wiki = scope === 'all' || scope === 'wiki' ? sources.wiki?.search(text, { ...options.wiki, limit }) : undefined;
  const readLegacyCode = async () => {
    if (!(scope === 'all' || scope === 'code') || !sources.code) return undefined;
    try {
      return await sources.code.search(text, limit);
    } catch (error) {
      if (scope === 'all' && (sources.wiki || sources.memory) && isCodeLockError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[evolve:code] ${message}; skipping code results for this query.`);
        return [];
      }
      throw error;
    }
  };
  const [code, memory] = await Promise.all([
    readLegacyCode(),
    scope === 'all' || scope === 'memory' ? sources.memory?.search(text, { ...options.memory, limit }) : undefined,
  ]);
  const tracker = options.knowledgeReads;
  if (tracker && wiki) {
    tracker.recordSearch({
      source: 'wiki', query: text, filters: options.wiki,
      returnedIds: wiki.results.map(hit => hit.id),
    });
  }
  if (tracker && code) {
    const returnedIds = Array.isArray(code) ? code.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const id = (item as { id?: unknown; node?: { id?: unknown } }).id ?? (item as { node?: { id?: unknown } }).node?.id;
      return typeof id === 'string' ? [id] : [];
    }) : [];
    tracker.recordSearch({ source: 'code', query: text, returnedIds });
  }
  if (tracker && memory) {
    tracker.recordSearch({
      source: 'memory', query: text, filters: options.memory,
      returnedIds: memory.results.map(hit => hit.id),
    });
  }
  return { ...(code && { code }), ...(wiki && { wiki }), ...(memory && { memory }) };
}

export async function context(
  sources: SearchSources, query: string, options: ContextOptions = {},
): Promise<AgentMemoryEnvelope> {
  const text = requireText(query, 'query');
  const limit = searchLimit(options.limit);
  const wikiContext = { ...options.context, repository: options.context?.repository ?? sources.repositoryId };
  const constraints = sources.wiki?.constraints(wikiContext) ?? [];
  if (Buffer.byteLength(JSON.stringify(constraints)) > 5 * 1024 * 1024) throw new InputError('Wiki snapshot exceeds the Run artifact size limit');
  const references = sources.wiki?.references(text, wikiContext, { ...options.wiki, limit }).results ?? [];
  const workingMemories = options.includeWorkingMemory && sources.memory
    ? prioritizeMemoryHits((await sources.memory.search(text, { ...options.memory, limit })).results, options.preferredMemoryTypes)
    : [];
  const tracker = options.knowledgeReads;
  if (tracker) {
    for (const constraint of constraints) {
      tracker.bindConstraint({
        knowledgeId: constraint.id,
        scope: constraint.entry?.scope ?? [],
        categories: constraint.entry?.categories,
        content: constraint.body,
      });
    }
    if (sources.wiki) {
      tracker.recordSearch({
        source: 'wiki_references', query: text,
        filters: { ...wikiContext, ...options.wiki },
        returnedIds: references.map(hit => hit.id),
      });
    }
    if (options.includeWorkingMemory && sources.memory) {
      tracker.recordSearch({
        source: 'memory', query: text, filters: options.memory,
        returnedIds: workingMemories.map(memory => memory.id),
      });
    }
  }
  return createAgentMemoryEnvelope({
    contextScope: options.contextScope,
    constraints: constraints.map(page => ({
      knowledge_id: page.id,
      title: page.title,
      mode: 'constraint' as const,
      authority: 'binding' as const,
      scope: page.entry?.scope ?? [],
      ...(page.entry?.categories ? { categories: page.entry.categories } : {}),
      content: page.body,
      content_sha256: `sha256:${createHash('sha256').update(page.body).digest('hex')}`,
      sources: page.sources,
      source_count: page.sources.length,
    })),
    references: references.map(hit => ({
      knowledge_id: hit.id,
      title: hit.title,
      mode: 'reference' as const,
      authority: 'advisory' as const,
      score: hit.score,
      hop: hit.hop,
      snippet: hit.snippet,
      sources: hit.sources,
      related_knowledge_ids: hit.related.map(related => related.id),
    })),
    workingMemories: workingMemories.map(memory => ({
      memory_id: memory.id,
      session_id: memory.session,
      type: memory.type,
      authority: 'unverified_episodic' as const,
      content: memory.content,
      source_ids: memory.sourceMessageIds,
      linked_knowledge_id: null,
    })),
  });
}

/**
 * 合并主包与全局补充 AgentMemoryEnvelope，按条目标识去重并保持项目条目优先。
 */
export function mergeContextEnvelopes(
  primary: AgentMemoryEnvelope,
  fallback: AgentMemoryEnvelope,
  limit?: number,
): AgentMemoryEnvelope {
  const max = searchLimit(limit);
  const mergeBy = <T>(first: readonly T[], second: readonly T[], keyOf: (item: T) => string) => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const item of [...first, ...second]) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= max) break;
    }
    return out;
  };
  return createAgentMemoryEnvelope({
    contextScope: primary.context_scope,
    constraints: mergeBy(primary.constraints, fallback.constraints, item => item.knowledge_id),
    references: mergeBy(primary.references, fallback.references, item => item.knowledge_id),
    workingMemories: mergeBy(primary.working_memories, fallback.working_memories, item => item.memory_id),
  });
}

export type UnifiedSearchSource = 'kb' | 'code';

export interface UnifiedSearchOptions extends KnowledgeFilters {
  from?: string | readonly UnifiedSearchSource[];
  mode?: 'merged' | 'context';
  memorySession?: string;
  preferredMemoryTypes?: readonly string[];
  contextScope?: AgentMemoryContextScope;
  constraintLimit?: number;
  constraintBudgetChars?: number;
  nowMs?: number;
  applyDecay?: boolean;
  trackUsage?: boolean;
  explore?: boolean;
}

export interface UnifiedCodeHit {
  source: 'code';
  kind: 'code';
  id: string;
  title: string;
  snippet: string;
  content: string;
  score: number;
  authority: 'symbol';
  scope: 'project';
  status: 'active';
  path: string;
  startLine: number;
  endLine: number;
}

export type UnifiedSearchHit = (KnowledgeRecord & { score: number }) | UnifiedCodeHit;

export interface UnifiedSearchSources {
  kb?: Pick<KnowledgeStore, 'search' | 'constraints'> & Partial<Pick<KnowledgeStore, 'recordHits' | 'getSearchHitCounts'>>;
  code?: Pick<CodeGraph, 'search'>;
}

export interface UnifiedMergedResults {
  schema_version: 'evolve-search/1.0';
  mode: 'merged';
  query: string;
  results: UnifiedSearchHit[];
  pagination: ReturnType<typeof pagination>;
}

export interface UnifiedContextResults {
  schema_version: 'evolve-context/1.0';
  mode: 'context';
  query: string;
  trust_boundary: 'untrusted_evidence_data_only';
  context_scope: AgentMemoryContextScope;
  constraints: Array<KnowledgeRecord & { content_sha256: string }>;
  constraints_truncated?: boolean;
  constraints_total?: number;
  constraints_omitted?: Array<{ id: string; title: string }>;
  constraints_notice?: string;
  references: Array<KnowledgeRecord & { score: number }>;
  episodic: Array<KnowledgeRecord & { score: number }>;
  code: UnifiedCodeHit[];
}

export function parseSearchFrom(value: string | readonly UnifiedSearchSource[] = 'all'): UnifiedSearchSource[] {
  const sources = typeof value === 'string' ? value.split(',').map(item => item.trim()) : [...value];
  if (sources.length === 1 && sources[0] === 'all') return ['kb', 'code'];
  if (!sources.length || sources.some(item => item !== 'kb' && item !== 'code')) {
    throw new InputError('from must be all or a comma-separated selection of kb,code');
  }
  return [...new Set(sources)] as UnifiedSearchSource[];
}

const authorityWeights = { constraint: 1.4, reference: 1.2, code: 1, episodic: 0.8 } as const;
const knowledgeKinds: readonly KnowledgeKind[] = ['constraint', 'reference', 'episodic'];
// 跨异构源融合采用更陡峭的位次衰减，避免代码符号数量多时将记忆与参考完全挤出前列。
const CROSS_SOURCE_RRF_K = 10;
const EXPLORE_MIN_RELEVANCE_RATIO = 0.65;
export const DEFAULT_MAX_CONTEXT_CONSTRAINTS = 20;
export const DEFAULT_MAX_CONTEXT_CONSTRAINT_CHARS = 4000;

function extractQueryConcepts(query: string): string[] {
  const rawSegments = query
    .toLowerCase()
    .split(WIKI_TOKEN_SPLIT_REGEX)
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0 && !STOP_WORDS.has(segment));
  const segments = [...new Set(rawSegments)];
  if (segments.length === 1) {
    const only = segments[0];
    if (/^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(only) && [...only].length > 6) {
      return [...new Set(tokenizeWiki(query))];
    }
  }
  return segments;
}

function computeQueryCoverageFactor(hit: UnifiedSearchHit, concepts: readonly string[]): number {
  if (concepts.length <= 1) return 1;
  if (hit.source === 'kb' && (hit.hop ?? 0) > 0) return 1;
  const haystack = [hit.title, hit.content, hit.snippet, hit.path]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase();
  let matched = 0;
  for (const concept of concepts) {
    if (haystack.includes(concept)) {
      matched += 1;
      continue;
    }
    const chars = [...concept];
    if (/^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(concept) && chars.length >= 4) {
      const bigrams = [...new Set(tokenizeWiki(concept).filter(token => [...token].length === 2))];
      if (bigrams.length > 0) {
        const hits = bigrams.filter(bigram => haystack.includes(bigram)).length;
        const ratio = hits / bigrams.length;
        if (ratio >= 0.5) matched += ratio;
      }
    }
  }
  const coverage = Math.min(1, matched / concepts.length);
  return 0.45 + 0.55 * coverage;
}

function hitKey(hit: UnifiedSearchHit): string {
  return `${hit.kind}:${hit.id}`;
}

function uniqueProjectFirst<T extends { kind: string; id: string; scope: string }>(hits: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const hit of hits) {
    const key = `${hit.kind}:${hit.id}`;
    const current = unique.get(key);
    if (!current || (current.scope !== 'project' && hit.scope === 'project')) unique.set(key, hit);
  }
  return [...unique.values()];
}

function fuseSearchLists(lists: UnifiedSearchHit[][], query: string): UnifiedSearchHit[] {
  const concepts = extractQueryConcepts(query);
  return rrfMerge(lists.map(uniqueProjectFirst), hitKey, CROSS_SOURCE_RRF_K)
    .map(({ rrfScore, ...hit }) => {
      const conflictFactor = hit.source === 'kb'
        ? (hit.confidence === 'contested' ? 0.5 : hit.status === 'needs_review' ? 0.6 : hit.conflictsWith?.length ? 0.7 : 1)
        : 1;
      const coverageFactor = computeQueryCoverageFactor(hit, concepts);
      return { ...hit, score: rrfScore * authorityWeights[hit.kind] * conflictFactor * coverageFactor };
    })
    .sort((left, right) => right.score - left.score || hitKey(left).localeCompare(hitKey(right)));
}

function applyConstraintBudget<T extends { id: string; title: string; content: string }>(
  items: readonly T[],
  maxItems: number,
  maxChars: number,
) {
  const kept: T[] = [];
  const omitted: Array<{ id: string; title: string }> = [];
  let usedChars = 0;
  for (const item of items) {
    const nextChars = usedChars + item.content.length;
    if (kept.length > 0 && (kept.length >= maxItems || nextChars > maxChars)) {
      omitted.push({ id: item.id, title: item.title });
      continue;
    }
    kept.push(item);
    usedChars = nextChars;
  }
  return { kept, omitted };
}

/**
 * 在源内保留相关性次序，以 RRF 和权威度权重合并知识与代码。
 */
export async function unifiedSearch(
  sources: UnifiedSearchSources,
  query: string,
  options: UnifiedSearchOptions = {},
): Promise<UnifiedMergedResults | UnifiedContextResults> {
  const text = requireText(query, 'query');
  const from = parseSearchFrom(options.from);
  const mode = options.mode ?? 'merged';
  const scope = options.scope ?? 'local';
  if (mode !== 'merged' && mode !== 'context') throw new InputError('mode must be merged or context');
  if (scope !== 'project' && scope !== 'global' && scope !== 'local') {
    throw new InputError('scope must be project, global or local');
  }
  if (options.kind !== undefined && !knowledgeKinds.includes(options.kind)) {
    throw new InputError('kind must be episodic, reference or constraint');
  }
  if (options.hop !== undefined && (!Number.isInteger(options.hop) || options.hop < 0 || options.hop > 5)) {
    throw new InputError('hop must be an integer between 0 and 5');
  }
  if (!from.includes('kb')) {
    const knowledgeOnly = [
      'kind', 'categories', 'type', 'scene', 'session', 'memorySession', 'status',
      'repository', 'keyword', 'includePathScoped', 'includeHistory', 'resolved', 'hop',
    ] as const;
    const incompatible = knowledgeOnly.filter(key => {
      const value = options[key];
      return value !== undefined && value !== false && !(key === 'hop' && value === 0) &&
        !(Array.isArray(value) && value.length === 0);
    });
    if (incompatible.length) {
      throw new InputError(`Knowledge filters require --from kb or all: ${incompatible.join(', ')}`);
    }
  }
  const limit = searchLimit(options.limit);
  const page = options.page ?? 1;
  const offset = pageOffset(page, limit);
  if (mode === 'context' && page !== 1) throw new InputError('Context mode does not support pagination');
  if (scope === 'global' && from.length === 1 && from[0] === 'code') {
    throw new InputError('Code search has no global source; use --scope project or local');
  }
  const useCode = from.includes('code') && scope !== 'global';
  if (useCode && page !== 1) {
    throw new InputError('Code search does not support pagination; use --from kb or refine the query');
  }
  const kinds = options.kind ? [options.kind] : mode === 'context' ? (['reference', 'episodic'] as const) : knowledgeKinds;
  const {
    from: _from, mode: _mode, memorySession, preferredMemoryTypes, contextScope,
    constraintLimit, constraintBudgetChars, nowMs, applyDecay, trackUsage, explore,
    ...knowledgeOptions
  } = options;
  const maxConstraints = constraintLimit ?? DEFAULT_MAX_CONTEXT_CONSTRAINTS;
  const maxConstraintChars = constraintBudgetChars ?? DEFAULT_MAX_CONTEXT_CONSTRAINT_CHARS;
  if (!Number.isInteger(maxConstraints) || maxConstraints < 1) {
    throw new InputError('constraintLimit must be a positive integer');
  }
  if (!Number.isInteger(maxConstraintChars) || maxConstraintChars < 1) {
    throw new InputError('constraintBudgetChars must be a positive integer');
  }
  const candidateCount = Math.max(100, offset + limit + 1);
  const readKnowledge = async (kind: KnowledgeKind): Promise<UnifiedSearchHit[]> => {
    if (!from.includes('kb') || !sources.kb) return [];
    const filters: KnowledgeFilters = {
      ...knowledgeOptions, scope, kind, limit: 100, page: 1,
      nowMs, applyDecay, trackUsage: false, explore: false,
    };
    if (mode === 'context' && kind !== 'episodic') {
      filters.resolved = true;
      delete filters.session;
      delete filters.type;
      delete filters.scene;
    }
    if (kind === 'episodic') {
      if (mode === 'context') {
        filters.session = memorySession;
      } else if (memorySession !== undefined) {
        filters.session = memorySession;
      }
      // 仓储标识约束正式 Wiki 的适用范围，工作记忆由项目存储和独立会话条件选择。
      delete filters.repository;
      filters.preferredMemoryTypes = preferredMemoryTypes;
    }
    const results: KnowledgeRecord[] = [];
    for (let sourcePage = 1; results.length < candidateCount; sourcePage++) {
      const result = await sources.kb.search(text, { ...filters, page: sourcePage });
      results.push(...result.results);
      if (result.pagination.nextPage === null) break;
    }
    const ranked = kind === 'episodic' && preferredMemoryTypes?.length
      ? prioritizeMemoryHits(results.map(hit => ({ ...hit, type: hit.type ?? '' })), preferredMemoryTypes)
      : results;
    return uniqueProjectFirst(ranked).map(hit => ({ ...hit, score: hit.score ?? 0 }));
  };
  const readCode = async (): Promise<UnifiedCodeHit[]> => {
    if (!useCode || !sources.code) return [];
    let rawHits;
    try {
      rawHits = await sources.code.search(text, 100, { paths: options.paths });
    } catch (error) {
      // 混合检索包含知识库时，冷建库或并发锁冲突只降级代码片段，不阻塞规则与记忆检索。
      if (from.includes('kb') && isCodeLockError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[evolve:code] ${message}; skipping code results for this query.`);
        return [];
      }
      throw error;
    }
    const hits = rawHits.filter(hit => codeMatchesPaths(hit.node.filePath, options.paths));
    options.knowledgeReads?.recordSearch({
      source: 'code', query: text, filters: { scope: 'project', paths: options.paths },
      returnedIds: hits.map(hit => hit.node.id),
    });
    return hits.map(({ node, score, highlights }) => ({
      source: 'code', kind: 'code', id: node.id, title: node.qualifiedName || node.name,
      snippet: highlights?.join(' ') || node.docstring || node.signature || node.name,
      content: [node.signature, node.docstring].filter(Boolean).join('\n') || node.name,
      score, authority: 'symbol', scope: 'project', status: 'active', path: node.filePath,
      startLine: node.startLine, endLine: node.endLine,
    }));
  };
  const [knowledgeLists, code] = await Promise.all([
    Promise.all(kinds.map(readKnowledge)),
    readCode(),
  ]);
  const merged = fuseSearchLists([...knowledgeLists, code], text);
  const hitCounts = explore !== false && from.includes('kb') ? sources.kb?.getSearchHitCounts?.(scope) : undefined;
  const recordKbHits = (items: ReadonlyArray<UnifiedSearchHit>) => {
    if (trackUsage === false || !sources.kb?.recordHits) return;
    const kbItems = items.filter((item): item is KnowledgeRecord & { score: number } => item.source === 'kb');
    if (kbItems.length) sources.kb.recordHits(kbItems);
  };
  if (mode === 'merged') {
    const ranked = options.page === undefined && hitCounts?.size
      ? applyBoundedExploration(merged, {
          limit, page: 1, getId: hitKey, getScore: hit => hit.score, searchHits: hitCounts,
          minRelevanceRatio: EXPLORE_MIN_RELEVANCE_RATIO,
        })
      : merged;
    const results = ranked.slice(offset, offset + limit);
    recordKbHits(results);
    return {
      schema_version: 'evolve-search/1.0', mode, query: text,
      results,
      pagination: pagination(page, limit, !useCode && ranked.length > offset + limit),
    };
  }
  const constraintOptions: KnowledgeFilters = {
    ...knowledgeOptions, scope, status: 'active', includeHistory: false, resolved: true,
  };
  delete constraintOptions.session;
  delete constraintOptions.type;
  delete constraintOptions.scene;
  const allConstraints = from.includes('kb') && sources.kb && (!options.kind || options.kind === 'constraint')
    ? uniqueProjectFirst(sources.kb.constraints(constraintOptions))
    : [];
  const { kept: constraints, omitted } = applyConstraintBudget(allConstraints, maxConstraints, maxConstraintChars);
  const rawReferences = merged.filter((hit): hit is KnowledgeRecord & { score: number } => hit.source === 'kb' && hit.kind === 'reference');
  const rawEpisodic = merged.filter((hit): hit is KnowledgeRecord & { score: number } => hit.source === 'kb' && hit.kind === 'episodic');
  const references = (hitCounts?.size
    ? applyBoundedExploration(rawReferences, {
        limit, page: 1, getId: hitKey, getScore: hit => hit.score, searchHits: hitCounts,
        minRelevanceRatio: EXPLORE_MIN_RELEVANCE_RATIO,
      })
    : rawReferences).slice(0, limit);
  const episodic = (hitCounts?.size
    ? applyBoundedExploration(rawEpisodic, {
        limit, page: 1, getId: hitKey, getScore: hit => hit.score, searchHits: hitCounts,
        minRelevanceRatio: EXPLORE_MIN_RELEVANCE_RATIO,
      })
    : rawEpisodic).slice(0, limit);
  recordKbHits([
    ...constraints.map(hit => ({ ...hit, score: 1 })),
    ...references,
    ...episodic,
  ]);
  return {
    schema_version: 'evolve-context/1.0', mode, query: text,
    trust_boundary: 'untrusted_evidence_data_only',
    context_scope: {
      ...contextScope,
      ...(options.task ? { task_kind: options.task } : {}),
      ...(options.paths?.length ? { paths: [...new Set(options.paths)] } : {}),
    },
    constraints: constraints.map(hit => ({
      ...hit, content_sha256: `sha256:${createHash('sha256').update(hit.content).digest('hex')}`,
    })),
    ...(omitted.length > 0 ? {
      constraints_truncated: true,
      constraints_total: allConstraints.length,
      constraints_omitted: omitted,
      constraints_notice: `Showing ${constraints.length} of ${allConstraints.length} applicable constraints (budget reached); narrow with --task/--path/--category or inspect omitted IDs via evolve kb get.`,
    } : {}),
    references,
    episodic,
    code: merged.filter((hit): hit is UnifiedCodeHit => hit.source === 'code').slice(0, limit),
  };
}
