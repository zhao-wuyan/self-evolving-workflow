import { createInterface } from 'node:readline';
import { buildWikiPrior, wikiLookupScope } from './workflow-knowledge.js';
import { WorkflowStore } from './workflow-runtime.js';
import { InputError, requireText } from './common.js';
import { openKnowledgeSources } from './knowledge-sources.js';

const text = { type: 'string' };
const textList = { type: 'array', items: text };
const scope = { type: 'object', properties: { repository: text, task: text, paths: textList, categories: textList }, additionalProperties: false };
function definition(name: string, description: string, properties: object, required: string[] = []) {
  return { name, description, annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const tools = [
  definition('read_skill', 'Open the committed Skill entry. Use from and destination for a declared Markdown link.', { from: text, destination: text }),
  definition('read_artifact', 'Read a bound artifact. For session-priors, use scope if the Wiki lookup had task, path, category or repository filters.', { id: text, scope }, ['id']),
  definition('wiki_context', 'Find applicable project Wiki constraints and reference IDs by keyword. The Run records this search.', { query: text, scope }, ['query']),
  definition('wiki_reference', 'Read the exact Wiki body for an ID returned by wiki_context. The Run records its search and content hash.', { id: text }, ['id']),
  definition('memory_search', 'Search Agent Memory and record the selected backend and results for this Run.', { query: text }, ['query']),
  definition('memory_get', 'Read the exact Memory record selected from this Run’s search results.', { id: text }, ['id']),
];

export async function serveWorkflowRun(store: WorkflowStore, session: string, run: string, db?: string) {
  store.brief(session, run);
  const sources = await openKnowledgeSources(store.root, { session, db, includeMemory: true });
  const { memory, wiki } = sources;
  if (!memory) throw new InputError('Memory reader is not configured');
  try {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      const req = JSON.parse(line);
      if (req.id === undefined) continue;
      let value: unknown;
      try {
        switch (req.method) {
          case 'initialize': value = {
            protocolVersion: req.params.protocolVersion, capabilities: { tools: {} },
            serverInfo: { name: 'evolve-workflow', version: '1.0.0' },
          }; break;
          case 'ping': value = {}; break;
          case 'tools/list': value = { tools }; break;
          case 'tools/call': {
            const { name, arguments: args = {} } = req.params;
            let result: unknown;
            switch (name) {
              case 'read_skill':
                result = store.readSkill(session, run, args.from, args.destination);
                break;
              case 'read_artifact':
                result = store.readArtifact(session, run, requireText(args.id, 'artifact ID'), wikiLookupScope(args.scope));
                break;
              case 'wiki_context': {
                const query = requireText(args.query, 'Wiki query');
                const lookupScope = wikiLookupScope({ ...args.scope, repository: args.scope?.repository ?? sources.repositoryId });
                const references = wiki.references(query, lookupScope).results;
                const constraints = wiki.constraints(lookupScope);
                const trace = store.recordKnowledge(session, run, (receipt, pin) => {
                  const searchId = receipt.recordSearch({
                    source: 'wiki_references', query, filters: lookupScope, returnedIds: references.map(item => item.id),
                  });
                  for (const page of constraints) {
                    const prior = buildWikiPrior(page, 'constraint', lookupScope, searchId);
                    receipt.bindConstraint({ knowledgeId: prior.id, content: prior.content, scope: prior.scope, categories: prior.categories });
                    pin(prior);
                  }
                });
                result = { constraints, references, search_id: trace.searches.at(-1)?.search_id };
                break;
              }
              case 'wiki_reference': {
                const id = requireText(args.id, 'Wiki reference ID');
                store.recordKnowledge(session, run, (receipt, pin) => {
                  const search = receipt.toJSON().searches.findLast(item => item.source === 'wiki_references' && item.returned_ids.includes(id));
                  if (!search) throw new InputError('Select an ID returned by wiki_context in this Run');
                  const lookupScope = wikiLookupScope(search.filters);
                  const page = wiki.getReference(id, lookupScope, { knowledgeReads: receipt, fromSearchId: search.search_id });
                  if (!page || page.id !== id) throw new InputError('Wiki reference is no longer available in the recorded scope: ' + id);
                  pin(buildWikiPrior(page, 'reference', lookupScope, search.search_id));
                  result = page;
                });
                break;
              }
              case 'memory_search': {
                const query = requireText(args.query, 'search query');
                const found = await memory.search(query);
                const trace = store.recordKnowledge(session, run, receipt => receipt.recordSearch({
                  source: 'memory', query, returnedIds: found.results.map(item => item.id),
                }), memory.drainRemoteReads?.());
                result = { ...found, search_id: trace.searches.at(-1)?.search_id, ...(sources.backend ? { knowledge_backend: sources.backend } : {}) };
                break;
              }
              case 'memory_get': {
                const id = requireText(args.id, 'memory ID');
                const searched = store.brief(session, run).knowledge_reads?.searches.some(search => search.source === 'memory' && search.returned_ids.includes(id));
                if (!searched) throw new InputError('Select an ID from this Run’s search results');
                const item = await memory.get(id);
                if (!item) throw new InputError('Memory is unavailable: ' + id);
                store.recordKnowledge(session, run, receipt => {
                  const search = receipt.toJSON().searches.findLast(item => item.source === 'memory' && item.returned_ids.includes(id));
                  if (!search) throw new InputError('Select an ID from this Run’s search results');
                  receipt.recordRead({ kind: 'memory', id, fromSearchId: search.search_id, content: item.content, version: item.version });
                }, memory.drainRemoteReads?.());
                result = item;
                break;
              }
              default: throw new InputError('Unknown workflow tool: ' + name);
            }
            value = { content: [{ type: 'text', text: JSON.stringify(result) }] };
            break;
          }
          default:
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
            continue;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (req.method !== 'tools/call') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message } }) + '\n');
          continue;
        }
        value = { isError: true, content: [{ type: 'text', text: message }] };
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: value }) + '\n');
    }
  } finally {
    memory.close?.();
  }
}
