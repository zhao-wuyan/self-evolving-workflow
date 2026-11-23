import { openKnowledgeSources } from './knowledge-sources.js';
import { knowledgeToolDefinitions, prepareKnowledgeTool, runKnowledgeAccess } from './workflow-knowledge-tools.js';
import { WorkflowStore } from './workflow-runtime.js';
import { executeOmpSession, type OmpWorkerRequest, type WorkerSdk, type RunConnection, type ToolResult, type WorkerTool,
  type OmpExtensionApi } from './omp-model-worker.js';
export { type OmpWorkerRequest } from './omp-model-worker.js';

export async function executeOmpWorker(request: OmpWorkerRequest, context: { cwd: string; modelRegistry?: unknown }, sdk: WorkerSdk) {
  return executeOmpSession(request, context, sdk, connectRun);
}


async function connectRun(binding: NonNullable<OmpWorkerRequest['binding']>): Promise<RunConnection> {
  const store = new WorkflowStore(binding.root);
  try {
    if (store.brief(binding.session, binding.run).status !== 'running') throw new Error('Select a running Evolve Run');
    const access = runKnowledgeAccess(store, binding);
    const sources = await openKnowledgeSources(binding.root, { session: binding.session, includeMemory: true });
    let queue = Promise.resolve();
    const tools: WorkerTool[] = knowledgeToolDefinitions.map(tool => ({
      name: 'evolve_' + tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      approval: 'read',
      execute: (_id, args, _onUpdate, _context, signal) => {
        const result = queue.then(async (): Promise<ToolResult> => {
          try {
            signal?.throwIfAborted();
            const apply = await prepareKnowledgeTool(sources, tool.name, args, access);
            signal?.throwIfAborted();
            return { content: [{ type: 'text', text: JSON.stringify(apply(access)) }] };
          } catch (error) {
            return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
          }
        });
        queue = result.then(() => undefined);
        return result;
      },
    }));
    return { tools, close: async () => {
      await queue;
      try { sources.memory?.close?.(); }
      finally { store.close(); }
    } };
  } catch (error) {
    store.close();
    throw error;
  }
}


export default function ompWorker(api: OmpExtensionApi) {
  api.registerCommand('evolve-worker', {
    description: 'Run an Evolve worker with an explicit SDK tool boundary',
    handler: async (args, context) => {
      const request = JSON.parse(args) as OmpWorkerRequest;
      const response = await executeOmpWorker(request, context, api.pi);
      process.stdout.write(JSON.stringify({ type: 'evolve_worker_result', request_id: request.request_id, ...response }) + '\n');
    },
  });
}
