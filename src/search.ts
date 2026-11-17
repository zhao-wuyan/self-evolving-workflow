import { createHash } from 'node:crypto';
import {
  createAgentMemoryEnvelope,
  type AgentMemoryContextScope,
  type AgentMemoryEnvelope,
} from './context-envelope.js';
import type { CodeGraph } from './code.js';
import { InputError, NotFoundError, requireText, searchLimit } from './common.js';
import type { MemorySearchOptions } from './memory.js';
import type { MemoryReader, MemorySearchResult } from './memory-reader.js';
import type { Wiki, WikiSearchOptions } from './wiki.js';
import type { WikiContext } from './wiki-entry.js';
import type { KnowledgeReads } from './knowledge-reads.js';

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
  knowledgeReads?: KnowledgeReads;
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
  const [code, memory] = await Promise.all([
    scope === 'all' || scope === 'code' ? sources.code?.search(text, limit) : undefined,
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
    ? (await sources.memory.search(text, { ...options.memory, limit })).results
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
