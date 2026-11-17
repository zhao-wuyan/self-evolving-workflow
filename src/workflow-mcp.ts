import { createInterface } from 'node:readline';
import { WorkflowStore } from './workflow-runtime.js';
import { InputError } from './common.js';
import { openKnowledgeSources } from './knowledge-sources.js';
import { knowledgeToolDefinitions, prepareKnowledgeTool, runKnowledgeAccess } from './workflow-knowledge-tools.js';

export async function serveWorkflowRun(store: WorkflowStore, session: string, run: string, db?: string) {
  store.brief(session, run);
  const sources = await openKnowledgeSources(store.root, { session, db, includeMemory: true });
  const { memory } = sources;
  if (!memory) throw new InputError('Memory reader is not configured');
  const access = runKnowledgeAccess(store, { session, run });
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
          case 'tools/list': value = { tools: knowledgeToolDefinitions }; break;
          case 'tools/call': {
            const { name, arguments: args = {} } = req.params;
            const execute = await prepareKnowledgeTool(sources, name, args, access);
            value = { content: [{ type: 'text', text: JSON.stringify(execute(access)) }] };
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
