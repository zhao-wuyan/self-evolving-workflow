import { createHash } from 'node:crypto';
import { InputError, requireText } from './common.js';

export const KNOWLEDGE_READS_VERSION = 'knowledge-reads/1.0';

export type KnowledgeSearchSource = 'code' | 'wiki' | 'wiki_references' | 'memory' | 'context' | 'kb' | 'search';
export type KnowledgeReadKind = 'code' | 'wiki' | 'memory' | 'kb';

export interface KnowledgeSearchRecord {
  search_id: string;
  source: KnowledgeSearchSource;
  query: string;
  filters?: Record<string, unknown>;
  returned_ids: string[];
  total_hits: number;
}

export interface KnowledgeReadRecord {
  kind: KnowledgeReadKind;
  id: string;
  from_search_id?: string;
  content_sha256?: string;
  version?: number;
}

export interface KnowledgeConstraintRecord {
  knowledge_id: string;
  content_sha256?: string;
  scope: string[];
  categories?: string[];
  storage_scope?: 'project' | 'global';
  lookup_scope?: Record<string, unknown>;
}

export interface KnowledgePriorReuse {
  artifact_id: string;
  producer_run_id: string;
  content_sha256: string;
}

export interface KnowledgeQueryItem {
  idx: number;
  kind: KnowledgeReadKind;
  id: string;
  scope?: 'project' | 'global';
  from_search_id?: string;
}

export interface KnowledgeQueryRecord {
  query_id: string;
  query: string;
  items: KnowledgeQueryItem[];
}

export interface KnowledgeReadsReceipt {
  schema_version: typeof KNOWLEDGE_READS_VERSION;
  searches: KnowledgeSearchRecord[];
  reads: KnowledgeReadRecord[];
  constraints_bound: KnowledgeConstraintRecord[];
  priors_reuse?: KnowledgePriorReuse[];
  queries?: KnowledgeQueryRecord[];
}

export interface KnowledgeSearchInput {
  source: KnowledgeSearchSource;
  query: string;
  filters?: Record<string, unknown>;
  returnedIds: string[];
}

export interface KnowledgeReadInput {
  kind: KnowledgeReadKind;
  id: string;
  fromSearchId?: string;
  content?: string;
  contentSha256?: string;
  version?: number;
}

export interface KnowledgeConstraintInput {
  knowledgeId: string;
  scope: string[];
  categories?: string[];
  content?: string;
  contentSha256?: string;
  storageScope?: 'project' | 'global';
  lookupScope?: Record<string, unknown>;
}

export function contentSha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new InputError(`Invalid knowledge read ${field}`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

function optionalSha(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new InputError(`Invalid knowledge read ${field}`);
  }
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`Invalid knowledge read ${field}`);
  return value as Record<string, unknown>;
}

function source(value: unknown, field: string): KnowledgeSearchSource {
  if (value !== 'code' && value !== 'wiki' && value !== 'wiki_references' && value !== 'memory' && value !== 'context' &&
      value !== 'kb' && value !== 'search') {
    throw new InputError(`Invalid knowledge read ${field}`);
  }
  return value;
}

function kind(value: unknown, field: string): KnowledgeReadKind {
  if (value !== 'code' && value !== 'wiki' && value !== 'memory' && value !== 'kb') {
    throw new InputError(`Invalid knowledge read ${field}`);
  }
  return value;
}

function parseSearch(value: unknown, index: number): KnowledgeSearchRecord {
  const item = record(value, `search ${index}`);
  const total = item.total_hits;
  if (!Number.isSafeInteger(total) || (total as number) < 0) throw new InputError(`Invalid knowledge read search total ${index}`);
  return {
    search_id: requireText(item.search_id, `knowledge search ID ${index}`),
    source: source(item.source, `search source ${index}`),
    query: requireText(item.query, `knowledge search query ${index}`),
    ...(item.filters === undefined ? {} : { filters: record(item.filters, `search filters ${index}`) }),
    returned_ids: stringList(item.returned_ids, `search returned IDs ${index}`),
    total_hits: total as number,
  };
}

function parseRead(value: unknown, index: number): KnowledgeReadRecord {
  const item = record(value, `read ${index}`);
  const version = item.version;
  if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1)) {
    throw new InputError(`Invalid knowledge read version ${index}`);
  }
  return {
    kind: kind(item.kind, `read kind ${index}`),
    id: requireText(item.id, `knowledge read ID ${index}`),
    ...(item.from_search_id === undefined ? {} : { from_search_id: requireText(item.from_search_id, `knowledge read source ${index}`) }),
    ...(item.content_sha256 === undefined ? {} : { content_sha256: optionalSha(item.content_sha256, `content hash ${index}`) }),
    ...(version === undefined ? {} : { version: version as number }),
  };
}

function parseConstraint(value: unknown, index: number): KnowledgeConstraintRecord {
  const item = record(value, `constraint ${index}`);
  if (item.storage_scope !== undefined && item.storage_scope !== 'project' && item.storage_scope !== 'global') {
    throw new InputError(`Invalid knowledge constraint storage scope ${index}`);
  }
  return {
    knowledge_id: requireText(item.knowledge_id, `constraint ID ${index}`),
    ...(item.content_sha256 === undefined ? {} : { content_sha256: optionalSha(item.content_sha256, `constraint hash ${index}`) }),
    scope: stringList(item.scope, `constraint scope ${index}`),
    ...(item.categories === undefined ? {} : { categories: stringList(item.categories, `constraint categories ${index}`) }),
    ...(item.storage_scope === undefined ? {} : { storage_scope: item.storage_scope }),
    ...(item.lookup_scope === undefined ? {} : { lookup_scope: record(item.lookup_scope, `constraint lookup scope ${index}`) }),
  };
}

function parsePriorReuse(value: unknown): KnowledgePriorReuse {
  const item = record(value, 'priors reuse');
  const hash = optionalSha(item.content_sha256, 'priors content hash');
  if (!hash) throw new InputError('Missing priors content hash');
  return {
    artifact_id: requireText(item.artifact_id, 'priors artifact ID'),
    producer_run_id: requireText(item.producer_run_id, 'priors producer Run ID'),
    content_sha256: hash,
  };
}

function parseQueryItem(value: unknown, index: number, searchIds: Set<string>): KnowledgeQueryItem {
  const item = record(value, `query item ${index}`);
  if (!Number.isSafeInteger(item.idx) || (item.idx as number) < 1) {
    throw new InputError(`Invalid knowledge query item index ${index}`);
  }
  if (item.scope !== undefined && item.scope !== 'project' && item.scope !== 'global') {
    throw new InputError(`Invalid knowledge query item scope ${index}`);
  }
  const fromSearchId = item.from_search_id === undefined
    ? undefined
    : requireText(item.from_search_id, `query item search ID ${index}`);
  if (fromSearchId && !searchIds.has(fromSearchId) && fromSearchId !== 'priors') {
    throw new InputError(`Unknown knowledge search ID: ${fromSearchId}`);
  }
  return {
    idx: item.idx as number,
    kind: kind(item.kind, `query item kind ${index}`),
    id: requireText(item.id, `query item ID ${index}`),
    ...(item.scope === undefined ? {} : { scope: item.scope }),
    ...(fromSearchId === undefined ? {} : { from_search_id: fromSearchId }),
  };
}

function parseQueryRecord(value: unknown, index: number, searchIds: Set<string>): KnowledgeQueryRecord {
  const item = record(value, `query ${index}`);
  if (!Array.isArray(item.items)) throw new InputError(`Invalid knowledge query items ${index}`);
  return {
    query_id: requireText(item.query_id, `knowledge query ID ${index}`),
    query: requireText(item.query, `knowledge query text ${index}`),
    items: item.items.map((entry, itemIndex) => parseQueryItem(entry, itemIndex, searchIds)),
  };
}

export function validateKnowledgeReads(value: unknown): KnowledgeReadsReceipt {
  const input = record(value, 'receipt');
  if (input.schema_version !== KNOWLEDGE_READS_VERSION || !Array.isArray(input.searches) ||
      !Array.isArray(input.reads) || !Array.isArray(input.constraints_bound)) {
    throw new InputError('Invalid knowledge reads receipt');
  }
  const searches = input.searches.map(parseSearch);
  const searchIds = new Set(searches.map(item => item.search_id));
  if (searchIds.size !== searches.length) throw new InputError('Duplicate knowledge search ID');
  const reads = input.reads.map(parseRead);
  for (const item of reads) {
    if (item.from_search_id && !searchIds.has(item.from_search_id) && item.from_search_id !== 'priors') {
      throw new InputError(`Unknown knowledge search ID: ${item.from_search_id}`);
    }
  }
  if (input.priors_reuse !== undefined && !Array.isArray(input.priors_reuse)) throw new InputError('Invalid priors reuse receipt');
  if (input.queries !== undefined && !Array.isArray(input.queries)) throw new InputError('Invalid knowledge queries receipt');
  const queries = input.queries?.map((item, index) => parseQueryRecord(item, index, searchIds));
  if (queries && new Set(queries.map(item => item.query_id)).size !== queries.length) {
    throw new InputError('Duplicate knowledge query ID');
  }
  return {
    schema_version: KNOWLEDGE_READS_VERSION,
    searches,
    reads,
    constraints_bound: input.constraints_bound.map(parseConstraint),
    ...(input.priors_reuse === undefined ? {} : { priors_reuse: input.priors_reuse.map(parsePriorReuse) }),
    ...(queries === undefined ? {} : { queries }),
  };
}

export class KnowledgeReads {
  private sequence = 0;
  private querySequence = 0;
  private readonly searches: KnowledgeSearchRecord[] = [];
  private readonly reads: KnowledgeReadRecord[] = [];
  private readonly constraints: KnowledgeConstraintRecord[] = [];
  private readonly priorReuse?: KnowledgePriorReuse[];
  private readonly queries: KnowledgeQueryRecord[] = [];

  constructor(initial?: KnowledgeReadsReceipt) {
    if (!initial) return;
    const receipt = validateKnowledgeReads(initial);
    this.searches.push(...receipt.searches);
    this.reads.push(...receipt.reads);
    this.constraints.push(...receipt.constraints_bound);
    this.priorReuse = receipt.priors_reuse;
    if (receipt.queries) this.queries.push(...receipt.queries);
    for (const search of this.searches) {
      const match = /^search-(\d+)$/.exec(search.search_id);
      if (match) this.sequence = Math.max(this.sequence, Number(match[1]));
    }
    for (const query of this.queries) {
      const match = /^q-(\d+)$/.exec(query.query_id);
      if (match) this.querySequence = Math.max(this.querySequence, Number(match[1]));
    }
  }

  recordSearch(input: KnowledgeSearchInput): string {
    let searchId: string;
    do {
      searchId = `search-${++this.sequence}`;
    } while (this.searches.some(search => search.search_id === searchId));
    const query = requireText(input.query, 'knowledge search query');
    const returnedIds = stringList(input.returnedIds, 'knowledge search returned IDs');
    this.searches.push({
      search_id: searchId,
      source: input.source,
      query,
      ...(input.filters ? { filters: { ...input.filters } } : {}),
      returned_ids: returnedIds,
      total_hits: returnedIds.length,
    });
    return searchId;
  }

  recordRead(input: KnowledgeReadInput): void {
    const id = requireText(input.id, 'knowledge read ID');
    const fromSearchId = input.fromSearchId === undefined ? undefined : requireText(input.fromSearchId, 'knowledge read search ID');
    if (fromSearchId && fromSearchId !== 'priors' && !this.searches.some(search => search.search_id === fromSearchId)) {
      throw new InputError(`Unknown knowledge search ID: ${fromSearchId}`);
    }
    const contentHash = input.contentSha256 ?? (input.content === undefined ? undefined : contentSha256(input.content));
    if (contentHash !== undefined) optionalSha(contentHash, 'content hash');
    if (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 1)) {
      throw new InputError('Knowledge read version must be a positive integer');
    }
    if (this.reads.some(read => read.kind === input.kind && read.id === id && read.from_search_id === fromSearchId)) return;
    this.reads.push({
      kind: input.kind,
      id,
      ...(fromSearchId ? { from_search_id: fromSearchId } : {}),
      ...(contentHash ? { content_sha256: contentHash } : {}),
      ...(input.version === undefined ? {} : { version: input.version }),
    });
  }

  bindConstraint(input: KnowledgeConstraintInput): void {
    const id = requireText(input.knowledgeId, 'knowledge constraint ID');
    const hash = input.contentSha256 ?? (input.content === undefined ? undefined : contentSha256(input.content));
    if (hash !== undefined) optionalSha(hash, 'constraint hash');
    if (this.constraints.some(item => item.knowledge_id === id)) return;
    this.constraints.push({
      knowledge_id: id,
      ...(hash ? { content_sha256: hash } : {}),
      scope: stringList(input.scope, 'knowledge constraint scope'),
      ...(input.categories ? { categories: stringList(input.categories, 'knowledge constraint categories') } : {}),
      ...(input.storageScope ? { storage_scope: input.storageScope } : {}),
      ...(input.lookupScope ? { lookup_scope: input.lookupScope } : {}),
    });
  }

  recordQuery(query: string, items: readonly KnowledgeQueryItem[]): string {
    let queryId: string;
    do {
      queryId = `q-${++this.querySequence}`;
    } while (this.queries.some(item => item.query_id === queryId));
    this.queries.push({
      query_id: queryId,
      query: requireText(query, 'knowledge search query'),
      items: items.map(item => ({ ...item })),
    });
    return queryId;
  }

  findSearchId(kind: KnowledgeReadKind, id: string, scope?: 'project' | 'global'): string | undefined {
    const matchSource = (search: KnowledgeSearchRecord) => {
      if (kind === 'wiki') return search.source === 'wiki' || search.source === 'wiki_references' || search.source === 'context';
      if (kind === 'memory') return search.source === 'memory';
      if (kind === 'code') return search.source === 'code';
      return true;
    };
    return this.searches.findLast(search =>
      matchSource(search) &&
      search.returned_ids.includes(id) &&
      (!scope || !search.filters?.scope || search.filters.scope === scope),
    )?.search_id;
  }

  resolvePick(queryId: string | undefined, idx: number): KnowledgeQueryItem {
    if (!Number.isSafeInteger(idx) || idx < 1) {
      throw new InputError(`Invalid pick index: ${idx}`);
    }
    if (queryId && /^search-\d+$/.test(queryId)) {
      const search = this.searches.find(item => item.search_id === queryId);
      if (!search) throw new InputError(`Unknown knowledge search ID: ${queryId}`);
      const targetId = search.returned_ids[idx - 1];
      if (!targetId) throw new InputError(`Search ${queryId} has no item #${idx}`);
      const kind: KnowledgeReadKind = search.source === 'memory' ? 'memory'
        : search.source === 'code' ? 'code'
          : search.source === 'wiki' || search.source === 'wiki_references' ? 'wiki' : 'kb';
      const scope = search.filters?.scope === 'project' || search.filters?.scope === 'global'
        ? search.filters.scope : undefined;
      return { idx, kind, id: targetId, ...(scope ? { scope } : {}), from_search_id: search.search_id };
    }
    const record = queryId ? this.queries.find(item => item.query_id === queryId) : this.queries.at(-1);
    if (!record) {
      throw new InputError(queryId
        ? `Unknown knowledge search ID: ${queryId}`
        : 'No recorded search queries available for --pick');
    }
    const found = record.items.find(item => item.idx === idx);
    if (!found) throw new InputError(`Search ${record.query_id} has no item #${idx}`);
    return found;
  }

  resolveFromSearch(
    fromSearchId: string | undefined,
    kind: KnowledgeReadKind,
    id: string,
    scope?: 'project' | 'global',
  ): string | undefined {
    if (fromSearchId === undefined) return this.findSearchId(kind, id, scope);
    if (!/^q-\d+$/.test(fromSearchId)) return fromSearchId;
    const record = this.queries.find(item => item.query_id === fromSearchId);
    if (!record) throw new InputError(`Unknown knowledge search ID: ${fromSearchId}`);
    const match = record.items.find(item =>
      item.id === id && item.kind === kind && (!scope || !item.scope || item.scope === scope),
    );
    return match?.from_search_id ?? this.findSearchId(kind, id, scope);
  }

  toJSON(): KnowledgeReadsReceipt {
    return validateKnowledgeReads({
      schema_version: KNOWLEDGE_READS_VERSION,
      searches: this.searches,
      reads: this.reads,
      constraints_bound: this.constraints,
      ...(this.priorReuse ? { priors_reuse: this.priorReuse } : {}),
      ...(this.queries.length ? { queries: this.queries } : {}),
    });
  }
}

export function formatKnowledgeReadsMessage(receipt: KnowledgeReadsReceipt): string {
  const searches = receipt.searches.map(search =>
    `${search.search_id} ${search.source} "${search.query}" (${search.total_hits} hits: ${search.returned_ids.join(', ') || 'none'})`).join('; ');
  const reads = receipt.reads.map(read =>
    `${read.kind}:${read.id}${read.from_search_id ? ` from ${read.from_search_id}` : ''}`).join(', ') || 'none';
  const constraints = receipt.constraints_bound.map(item => item.knowledge_id).join(', ') || 'none';
  const reuse = receipt.priors_reuse?.map(item => `${item.artifact_id} from ${item.producer_run_id} (${item.content_sha256})`).join(', ');
  return `Knowledge searches: ${searches || 'none'}. Knowledge reads: ${reads}. Bound constraints: ${constraints}.` +
    (reuse ? ` Reused session priors: ${reuse}.` : '');
}
