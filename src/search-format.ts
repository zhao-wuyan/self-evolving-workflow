import type { KnowledgeRecord } from './kb.js';
import type { UnifiedCodeHit, UnifiedContextResults, UnifiedMergedResults } from './search.js';

export type OutputFormat = 'json' | 'compact';

export const INLINE_CONTENT_LIMIT = 300;
const SHORT_HEX_BASE = 8;

function shortenWithLength(id: string, hexLength: number): string {
  if (/^[a-f0-9]{64}$/i.test(id)) return id.slice(0, hexLength);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return id.slice(0, hexLength);
  }
  const legacyWiki = /^entries\/legacy-([a-f0-9]{16,})$/i.exec(id);
  if (legacyWiki) return `entries/legacy-${legacyWiki[1].slice(0, hexLength)}`;
  const codeNode = /^([a-z_]+):([a-f0-9]{16,})$/i.exec(id);
  if (codeNode) return `${codeNode[1]}:${codeNode[2].slice(0, hexLength)}`;
  return id;
}

/**
 * 为十六进制长 ID 生成无状态最短唯一前缀；语义化 slug（如 entries/preflight）原样保留。
 */
export function shortenEntityId(id: string, siblings: readonly string[] = []): string {
  for (let hexLength = SHORT_HEX_BASE; hexLength <= 64; hexLength += 2) {
    const candidate = shortenWithLength(id, hexLength);
    if (candidate === id) return id;
    const collides = siblings.some(
      other => other !== id && shortenWithLength(other, hexLength).toLowerCase() === candidate.toLowerCase(),
    );
    if (!collides) return candidate;
  }
  return id;
}

export function projectBody(content: string, snippet: string): { content: string } | { snippet: string; truncated: true } {
  const trimmed = content.trim();
  if (trimmed.length <= INLINE_CONTENT_LIMIT) {
    return { content };
  }
  const cleanSnippet = snippet.trim();
  const preview = cleanSnippet && cleanSnippet.length < trimmed.length
    ? cleanSnippet
    : trimmed.replace(/\s+/g, ' ').slice(0, 160);
  return { snippet: preview, truncated: true };
}

export interface CompactHitOptions {
  idx?: number;
  omitKind?: boolean;
  allIds?: readonly string[];
}

export function projectKnowledgeHit(hit: KnowledgeRecord, options: CompactHitOptions = {}) {
  const allIds = options.allIds ?? [];
  const id = shortenEntityId(hit.id, allIds);
  const nonTrivialScope = hit.entryScope && !(hit.entryScope.length === 1 && hit.entryScope[0] === 'project')
    ? hit.entryScope : undefined;
  const expectedPath = `wiki/${hit.id}.md`;
  return {
    ...(options.idx === undefined ? {} : { idx: options.idx }),
    id,
    ...(!options.omitKind ? { kind: hit.kind } : {}),
    ...(hit.type ? { type: hit.type } : {}),
    ...(hit.storageKind === 'wiki' ? { title: hit.title } : {}),
    scope: hit.scope,
    ...(hit.status !== 'active' ? { status: hit.status } : {}),
    ...(hit.confidence === 'contested' || hit.confidence === 'low' ? { confidence: hit.confidence } : {}),
    ...(hit.conflictsWith?.length ? { conflictsWith: hit.conflictsWith } : {}),
    ...(hit.scene ? { scene: hit.scene } : {}),
    ...(hit.categories?.length ? { categories: hit.categories } : {}),
    ...(nonTrivialScope ? { entryScope: nonTrivialScope } : {}),
    ...(hit.path && hit.path !== expectedPath ? { path: hit.path } : {}),
    ...(hit.hop ? { hop: hit.hop, ...(hit.via ? { via: hit.via } : {}) } : {}),
    ...(hit.related?.length ? {
      related: hit.related.map(item => ({
        id: shortenEntityId(item.id, allIds),
        title: item.title,
        direction: item.direction,
      })),
    } : {}),
    ...projectBody(hit.content, hit.snippet),
  };
}

export function projectCodeHit(hit: UnifiedCodeHit, options: CompactHitOptions = {}) {
  const id = shortenEntityId(hit.id, options.allIds ?? []);
  return {
    ...(options.idx === undefined ? {} : { idx: options.idx }),
    id,
    ...(!options.omitKind ? { kind: 'code' as const } : {}),
    title: hit.title,
    loc: `${hit.path}:${hit.startLine}-${hit.endLine}`,
    ...projectBody(hit.content, hit.snippet),
  };
}

export interface RawCodeGraphItem {
  node: {
    id: string;
    kind: string;
    name: string;
    qualifiedName?: string;
    filePath: string;
    startLine: number;
    endLine: number;
    signature?: string;
  };
  [key: string]: unknown;
}

export function projectCodeGraphItem(item: RawCodeGraphItem, allIds: readonly string[], idx?: number) {
  const { node } = item;
  return {
    ...(idx === undefined ? {} : { idx }),
    node: {
      id: shortenEntityId(node.id, allIds),
      kind: node.kind,
      name: node.name,
      ...(node.qualifiedName && node.qualifiedName !== node.name ? { qualifiedName: node.qualifiedName } : {}),
      filePath: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine,
      ...(node.signature ? { signature: node.signature } : {}),
    },
  };
}

export interface UnifiedContextJsonOptions {
  searchId?: string;
  indices?: Map<string, number>;
  verbose?: boolean;
}

export function formatUnifiedContextJson(result: UnifiedContextResults, options: UnifiedContextJsonOptions = {}) {
  const indexOf = (kind: string, id: string) => options.indices?.get(`${kind}:${id}`);
  if (options.verbose) {
    return {
      ...(options.searchId ? { search_id: options.searchId } : {}),
      ...result,
    };
  }
  const allIds = [
    ...result.constraints.map(item => item.id),
    ...result.references.map(item => item.id),
    ...result.episodic.map(item => item.id),
    ...result.code.map(item => item.id),
    ...(result.constraints_omitted?.map(item => item.id) ?? []),
  ];
  return {
    schema_version: result.schema_version,
    mode: result.mode,
    query: result.query,
    ...(options.searchId ? { search_id: options.searchId } : {}),
    trust_boundary: result.trust_boundary,
    context_scope: result.context_scope,
    constraints: result.constraints.map(item =>
      projectKnowledgeHit(item, { idx: indexOf(item.kind, item.id), omitKind: true, allIds })),
    ...(result.constraints_truncated ? {
      constraints_truncated: true,
      constraints_total: result.constraints_total,
      constraints_omitted: result.constraints_omitted?.map(item => ({
        id: shortenEntityId(item.id, allIds),
        title: item.title,
      })),
      constraints_notice: result.constraints_notice,
    } : {}),
    references: result.references.map(item =>
      projectKnowledgeHit(item, { idx: indexOf(item.kind, item.id), omitKind: true, allIds })),
    episodic: result.episodic.map(item =>
      projectKnowledgeHit(item, { idx: indexOf(item.kind, item.id), omitKind: true, allIds })),
    code: result.code.map(item =>
      projectCodeHit(item, { idx: indexOf('code', item.id), omitKind: true, allIds })),
  };
}

export function formatUnifiedMergedJson(result: UnifiedMergedResults, options: UnifiedContextJsonOptions = {}) {
  const indexOf = (kind: string, id: string) => options.indices?.get(`${kind}:${id}`);
  if (options.verbose) {
    return {
      ...(options.searchId ? { search_id: options.searchId } : {}),
      ...result,
    };
  }
  const allIds = result.results.map(item => item.id);
  return {
    schema_version: result.schema_version,
    mode: result.mode,
    query: result.query,
    ...(options.searchId ? { search_id: options.searchId } : {}),
    results: result.results.map(item => item.source === 'code'
      ? projectCodeHit(item, { idx: indexOf('code', item.id), allIds })
      : projectKnowledgeHit(item, { idx: indexOf(item.kind, item.id), allIds })),
    pagination: result.pagination,
  };
}

function formatLineText(prefix: string, body: { content?: string; snippet?: string; truncated?: boolean }): string {
  const text = (body.content ?? body.snippet ?? '').replace(/\s+/g, ' ').trim();
  const suffix = body.truncated ? '[truncated] ' : '';
  return `${prefix}\n    ${suffix}${text}`;
}

function conflictBadge(item: Record<string, unknown>): string | undefined {
  if (item.confidence === 'contested' || (Array.isArray(item.conflictsWith) && item.conflictsWith.length > 0)) {
    return '[CONTESTED]';
  }
  if (item.status === 'needs_review') return '[NEEDS_REVIEW]';
  return undefined;
}

export function renderUnifiedContextCompact(
  result: ReturnType<typeof formatUnifiedContextJson>,
): string {
  const lines: string[] = [];
  const header = [
    ...(result.search_id ? [`search_id: ${result.search_id}`] : []),
    `query: ${JSON.stringify(result.query)}`,
    'mode: context',
  ].join(' | ');
  lines.push(header);

  const renderKnowledgeSection = (label: string, items: Array<Record<string, unknown>>) => {
    if (!items.length) return;
    lines.push('', `[${label}] (${items.length})`);
    for (const item of items) {
      const marker = item.idx === undefined ? '-' : `[${item.idx}]`;
      const meta = [conflictBadge(item), item.id, item.scope, item.type, item.scene ? `scene: ${item.scene}` : undefined, item.title]
        .filter(Boolean).join(' | ');
      lines.push(formatLineText(`${marker} ${meta}`, item as { content?: string; snippet?: string; truncated?: boolean }));
    }
  };

  renderKnowledgeSection('constraints', result.constraints as Array<Record<string, unknown>>);
  if ('constraints_notice' in result && result.constraints_notice) {
    lines.push(`  note: ${result.constraints_notice}`);
  }
  renderKnowledgeSection('references', result.references as Array<Record<string, unknown>>);
  renderKnowledgeSection('episodic', result.episodic as Array<Record<string, unknown>>);

  if (result.code.length) {
    lines.push('', `[code] (${result.code.length})`);
    for (const item of result.code as Array<Record<string, unknown>>) {
      const marker = item.idx === undefined ? '-' : `[${item.idx}]`;
      const loc = item.loc ?? (item.path ? `${item.path}:${item.startLine}-${item.endLine}` : undefined);
      const meta = [item.id, loc, item.title].filter(Boolean).join(' | ');
      lines.push(formatLineText(`${marker} ${meta}`, item as { content?: string; snippet?: string; truncated?: boolean }));
    }
  }
  return lines.join('\n') + '\n';
}

export function renderUnifiedMergedCompact(
  result: ReturnType<typeof formatUnifiedMergedJson>,
): string {
  const lines: string[] = [];
  const header = [
    ...(result.search_id ? [`search_id: ${result.search_id}`] : []),
    `query: ${JSON.stringify(result.query)}`,
    `page: ${result.pagination.page}`,
  ].join(' | ');
  lines.push(header);
  if (!result.results.length) return lines.join('\n') + '\n(no results)\n';
  for (const item of result.results as Array<Record<string, unknown>>) {
    const marker = item.idx === undefined ? '-' : `[${item.idx}]`;
    const loc = item.loc ?? (item.path && item.startLine ? `${item.path}:${item.startLine}-${item.endLine}` : undefined);
    const meta = [conflictBadge(item), item.id, item.kind, item.type, item.scope, loc, item.title].filter(Boolean).join(' | ');
    lines.push(formatLineText(`${marker} ${meta}`, item as { content?: string; snippet?: string; truncated?: boolean }));
  }
  return lines.join('\n') + '\n';
}

export function renderKbSearchCompact(payload: {
  search_id?: string;
  results: Array<Record<string, unknown>>;
  pagination?: { page: number; nextPage: number | null };
}): string {
  const lines: string[] = [];
  if (payload.search_id || payload.pagination) {
    lines.push([
      ...(payload.search_id ? [`search_id: ${payload.search_id}`] : []),
      ...(payload.pagination ? [`page: ${payload.pagination.page}${payload.pagination.nextPage ? ` (next: ${payload.pagination.nextPage})` : ''}`] : []),
    ].join(' | '));
  }
  if (!payload.results.length) return (lines.length ? lines.join('\n') + '\n' : '') + '(no results)\n';
  for (const item of payload.results) {
    const marker = item.idx === undefined ? '-' : `[${item.idx}]`;
    const meta = [conflictBadge(item), item.id, item.kind, item.type, item.scope, item.title].filter(Boolean).join(' | ');
    lines.push(formatLineText(`${marker} ${meta}`, item as { content?: string; snippet?: string; truncated?: boolean }));
  }
  return lines.join('\n') + '\n';
}

export function renderCodeSearchCompact(payload: {
  search_id?: string;
  results: Array<Record<string, unknown>>;
}): string {
  const lines: string[] = [];
  if (payload.search_id) lines.push(`search_id: ${payload.search_id}`);
  if (!payload.results.length) return (lines.length ? lines.join('\n') + '\n' : '') + '(no results)\n';
  for (const item of payload.results) {
    const node = (item.node ?? item) as Record<string, unknown>;
    const marker = item.idx === undefined ? '-' : `[${item.idx}]`;
    const loc = node.filePath ? `${node.filePath}:${node.startLine}-${node.endLine}` : undefined;
    const meta = [node.id, node.kind, loc, node.qualifiedName ?? node.name].filter(Boolean).join(' | ');
    lines.push(`${marker} ${meta}${node.signature ? `\n    ${node.signature}` : ''}`);
  }
  return lines.join('\n') + '\n';
}

export function renderKbGetCompact(value: unknown): string {
  if (value === null || value === undefined) return '(not found)\n';
  const items = Array.isArray((value as { results?: unknown }).results)
    ? (value as { results: Array<Record<string, unknown>> }).results
    : [value as Record<string, unknown>];
  return items.map(item => {
    const header = [conflictBadge(item), item.id, item.kind, item.type, item.scope, item.title].filter(Boolean).join(' | ');
    const loc = item.path && item.startLine ? `\nlocation: ${item.path}:${item.startLine}-${item.endLine}` : '';
    const sources = Array.isArray(item.sources) && item.sources.length ? `\nsources: ${item.sources.join(', ')}` : '';
    return `[${header}]${loc}${sources}\n${item.content ?? ''}`;
  }).join('\n---\n') + '\n';
}
