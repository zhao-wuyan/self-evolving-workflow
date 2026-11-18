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

export interface KnowledgeReadsReceipt {
  schema_version: typeof KNOWLEDGE_READS_VERSION;
  searches: KnowledgeSearchRecord[];
  reads: KnowledgeReadRecord[];
  constraints_bound: KnowledgeConstraintRecord[];
  priors_reuse?: KnowledgePriorReuse[];
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
  return {
    schema_version: KNOWLEDGE_READS_VERSION,
    searches,
    reads,
    constraints_bound: input.constraints_bound.map(parseConstraint),
    ...(input.priors_reuse === undefined ? {} : { priors_reuse: input.priors_reuse.map(parsePriorReuse) }),
  };
}

export class KnowledgeReads {
  private sequence = 0;
  private readonly searches: KnowledgeSearchRecord[] = [];
  private readonly reads: KnowledgeReadRecord[] = [];
  private readonly constraints: KnowledgeConstraintRecord[] = [];
  private readonly priorReuse?: KnowledgePriorReuse[];

  constructor(initial?: KnowledgeReadsReceipt) {
    if (!initial) return;
    const receipt = validateKnowledgeReads(initial);
    this.searches.push(...receipt.searches);
    this.reads.push(...receipt.reads);
    this.constraints.push(...receipt.constraints_bound);
    this.priorReuse = receipt.priors_reuse;
    for (const search of this.searches) {
      const match = /^search-(\d+)$/.exec(search.search_id);
      if (match) this.sequence = Math.max(this.sequence, Number(match[1]));
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

  toJSON(): KnowledgeReadsReceipt {
    return validateKnowledgeReads({
      schema_version: KNOWLEDGE_READS_VERSION,
      searches: this.searches,
      reads: this.reads,
      constraints_bound: this.constraints,
      ...(this.priorReuse ? { priors_reuse: this.priorReuse } : {}),
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
