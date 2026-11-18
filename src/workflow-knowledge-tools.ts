import { InputError, requireText } from './common.js';
import { buildWikiPrior, wikiLookupScope, type WikiPrior, type WikiLookupScope } from './workflow-knowledge.js';
import type { KnowledgeReads, KnowledgeReadsReceipt } from './knowledge-reads.js';
import type { KnowledgeSources } from './knowledge-sources.js';
import type { OpenVikingReadEvidence } from './openviking/types.js';
import type { WorkflowStore } from './workflow-runtime.js';

const text = { type: 'string' };
const textList = { type: 'array', items: text };
const scope = { type: 'object', properties: { repository: text, task: text, paths: textList, categories: textList }, additionalProperties: false };
function definition(name: string, description: string, properties: object, required: string[] = []) {
  return { name, description, annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
export const knowledgeToolDefinitions = [
  definition('read_skill', 'Open the committed Skill entry. Use from and destination for a declared Markdown link. Requires an explicit Run binding.', { from: text, destination: text }),
  definition('read_artifact', 'Read a bound artifact. Use scope for filtered session-priors. Requires an explicit Run binding.', { id: text, scope }, ['id']),
  definition('wiki_context', 'Find applicable Wiki constraints and reference IDs by keyword and record the search.', { query: text, scope }, ['query']),
  definition('wiki_reference', 'Read the exact Wiki body for an ID returned by wiki_context in the current knowledge scope.', { id: text }, ['id']),
  definition('memory_search', 'Search Agent Memory and record the selected backend and result IDs.', { query: text }, ['query']),
  definition('memory_get', 'Read an exact Memory record selected from the current knowledge scope search results.', { id: text }, ['id']),
];
export type KnowledgeUpdate = (receipt: KnowledgeReads, pin: (prior: Omit<WikiPrior, 'content_sha256'>) => void) => void;
export interface KnowledgeToolAccess {
  receipt(): KnowledgeReadsReceipt | undefined;
  record(update: KnowledgeUpdate, remote?: OpenVikingReadEvidence[]): KnowledgeReadsReceipt;
  readSkill(from?: string, destination?: string): unknown;
  readArtifact(id: string, scope: WikiLookupScope): unknown;
}
export function runKnowledgeAccess(store: WorkflowStore, binding: { session: string; run: string }): KnowledgeToolAccess {
  const { session, run } = binding;
  return {
    receipt: () => store.brief(session, run).knowledge_reads,
    record: (update, remote) => store.recordKnowledge(session, run, update, remote),
    readSkill: (from, destination) => store.readSkill(session, run, from, destination),
    readArtifact: (id, lookup) => store.readArtifact(session, run, id, lookup),
  };
}
function selected(receipt: KnowledgeReadsReceipt | undefined, source: 'memory' | 'wiki_references', id: string) {
  const search = receipt?.searches.findLast(item => item.source === source && item.returned_ids.includes(id));
  if (!search) throw new InputError(source === 'memory' ? 'Select an ID from this Run’s search results (or the current host knowledge scope)'
    : 'Select an ID returned by wiki_context in this Run or host knowledge scope');
  return search;
}

// 远程读取在事务外完成；返回的同步操作才写证据，便于宿主与 Run 原子提交。
// 一个 service 必须将读取和 drain 作为完整操作串行化，不能共享 reader 的中间缓冲。
export async function prepareKnowledgeTool(sources: KnowledgeSources, name: string, args: Record<string, unknown>,
  initial: KnowledgeToolAccess): Promise<(access: KnowledgeToolAccess) => unknown> {
  const { wiki, memory } = sources;
  switch (name) {
    case 'read_skill': {
      const from = args.from === undefined ? undefined : requireText(args.from, 'source document');
      const destination = args.destination === undefined ? undefined : requireText(args.destination, 'Markdown destination');
      return access => access.readSkill(from, destination);
    }
    case 'read_artifact': {
      const id = requireText(args.id, 'artifact ID');
      const lookup = wikiLookupScope(args.scope);
      return access => access.readArtifact(id, lookup);
    }
    case 'wiki_context': {
      const query = requireText(args.query, 'Wiki query');
      const lookup = wikiLookupScope(args.scope);
      const lookupScope = wikiLookupScope({ ...lookup, repository: lookup.repository ?? sources.repositoryId });
      const references = wiki.references(query, lookupScope).results;
      const constraints = wiki.constraints(lookupScope);
      return access => {
        const trace = access.record((receipt, pin) => {
          const searchId = receipt.recordSearch({ source: 'wiki_references', query, filters: lookupScope,
            returnedIds: references.map(item => item.id) });
          for (const page of constraints) {
            const prior = buildWikiPrior(page, 'constraint', lookupScope, searchId);
            receipt.bindConstraint({ knowledgeId: prior.id, content: prior.content, scope: prior.scope, categories: prior.categories });
            pin(prior);
          }
        });
        return { constraints, references, search_id: trace.searches.at(-1)?.search_id };
      };
    }
    case 'wiki_reference': {
      const id = requireText(args.id, 'Wiki reference ID');
      return access => {
        let result: unknown;
        access.record((receipt, pin) => {
          const search = selected(receipt.toJSON(), 'wiki_references', id);
          const lookupScope = wikiLookupScope(search.filters);
          const page = wiki.getReference(id, lookupScope, { knowledgeReads: receipt, fromSearchId: search.search_id });
          if (!page || page.id !== id) throw new InputError('Wiki reference is no longer available in the recorded scope: ' + id);
          pin(buildWikiPrior(page, 'reference', lookupScope, search.search_id));
          result = page;
        });
        return result;
      };
    }
    case 'memory_search': {
      if (!memory) throw new InputError('Memory reader is not configured');
      const query = requireText(args.query, 'search query');
      try {
        const found = await memory.search(query);
        const remote = memory.drainRemoteReads?.();
        return access => {
          const trace = access.record(receipt => receipt.recordSearch({ source: 'memory', query,
            returnedIds: found.results.map(item => item.id) }), remote);
          return { ...found, search_id: trace.searches.at(-1)?.search_id,
            ...(sources.backend ? { knowledge_backend: { ...sources.backend } } : {}) };
        };
      } catch (error) { memory.drainRemoteReads?.(); throw error; }
    }
    case 'memory_get': {
      if (!memory) throw new InputError('Memory reader is not configured');
      const id = requireText(args.id, 'memory ID');
      selected(initial.receipt(), 'memory', id);
      try {
        const item = await memory.get(id);
        if (!item) throw new InputError('Memory is unavailable: ' + id);
        const remote = memory.drainRemoteReads?.();
        return access => {
          access.record(receipt => {
            const search = selected(receipt.toJSON(), 'memory', id);
            receipt.recordRead({ kind: 'memory', id, fromSearchId: search.search_id, content: item.content, version: item.version });
          }, remote);
          return item;
        };
      } catch (error) { memory.drainRemoteReads?.(); throw error; }
    }
    default: throw new InputError('Unknown workflow tool: ' + name);
  }
}
