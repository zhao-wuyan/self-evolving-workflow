import { openKnowledgeSources } from './knowledge-sources.js';
import { knowledgeToolDefinitions, prepareKnowledgeTool, runKnowledgeAccess } from './workflow-knowledge-tools.js';
import { WorkflowStore } from './workflow-runtime.js';

export interface OmpWorkerRequest {
  request_id: string;
  cwd: string;
  prompt: string;
  mode: 'analysis' | 'write';
  model: string;
  binding?: { root: string; session: string; run: string };
}

interface ToolResult { content: Array<{ type: string; text: string }>; isError?: boolean }
interface WorkerTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  approval: 'read';
  execute(id: string, args: Record<string, unknown>, onUpdate: unknown, context: unknown, signal?: AbortSignal): Promise<ToolResult>;
}
interface SessionEvent {
  type: string;
  message?: { role?: string; stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> };
}
interface WorkerSession {
  model?: { id: string };
  getActiveToolNames(): string[];
  subscribe(handler: (event: SessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}
interface WorkerSdk {
  Settings: { loadReadOnly(options: { cwd: string }): Promise<unknown> };
  AgentRegistry: new () => unknown;
  SessionManager: { inMemory(): unknown };
  createAgentSession(options: Record<string, unknown>): Promise<{ session: WorkerSession }>;
}
interface OmpExtensionApi {
  pi: WorkerSdk;
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, context: { cwd: string; modelRegistry: unknown }): Promise<void>;
  }): void;
}
interface RunConnection {
  tools: WorkerTool[];
  close(): Promise<void>;
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

export async function executeOmpWorker(request: OmpWorkerRequest, context: { cwd: string; modelRegistry?: unknown }, sdk: WorkerSdk) {
  let session: WorkerSession | undefined;
  let connection: RunConnection | undefined;
  let unsubscribe: (() => void) | undefined;
  const response: { output?: string; error?: string } = {};
  const cancel = () => { if (session) void session.abort(); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (!request.request_id || !request.prompt || !request.model || request.cwd !== context.cwd ||
        !['analysis', 'write'].includes(request.mode)) throw new Error('Invalid Evolve OMP worker request');
    if (typeof sdk.createAgentSession !== 'function' || typeof sdk.AgentRegistry !== 'function' ||
        typeof sdk.SessionManager?.inMemory !== 'function' || typeof sdk.Settings?.loadReadOnly !== 'function') {
      throw new Error('OMP does not expose the required restricted SDK');
    }
    connection = request.binding ? await connectRun(request.binding) : undefined;
    const builtins = request.mode === 'analysis' ? ['read', 'grep', 'glob']
      : ['read', 'grep', 'glob', 'edit', 'write', 'bash', 'lsp'];
    const tools = connection?.tools ?? [];
    const allowed = [...builtins, ...tools.map(tool => tool.name)];
    const created = await sdk.createAgentSession({
      cwd: request.cwd,
      settings: await sdk.Settings.loadReadOnly({ cwd: request.cwd }),
      modelPattern: request.model,
      agentRegistry: new sdk.AgentRegistry(),
      sessionManager: sdk.SessionManager.inMemory(),
      toolNames: allowed,
      restrictToolNames: true,
      customTools: tools,
      allowRestrictedCustomTools: true,
      enableMCP: false,
      enableLsp: request.mode === 'write',
      disableExtensionDiscovery: true,
      skills: [], rules: [],
      hasUI: false,
    });
    session = created.session;
    const active = session.getActiveToolNames();
    if (active.some(name => !allowed.includes(name)) || !builtins.slice(0, 3).every(name => active.includes(name)) ||
        !tools.every(tool => active.includes(tool.name))) throw new Error('OMP could not establish the requested tool boundary');
    let output = '';
    let failure: string | undefined;
    unsubscribe = session.subscribe(event => {
      if (event.type !== 'message_end' || event.message?.role !== 'assistant') return;
      if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
        failure = event.message.errorMessage ?? 'OMP worker turn failed: ' + event.message.stopReason;
      }
      output = event.message.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? '';
    });
    const bindingGuide = connection
      ? 'Use evolve_read_skill to load the bound Skill and evolve_wiki_context/evolve_memory_search with exact reads for project knowledge. These tools are already bound to this Evolve Run. Do not create or complete Runs.\n'
      : '';
    const modeGuide = request.mode === 'analysis'
      ? 'Analysis only. Read and search project files; return findings or a plan as your final answer. Do not modify files or request implementation approval.\n'
      : 'Implement only the requested changes. Respect tool permissions; report denied operations and verification limits accurately.\n';
    await session.prompt(modeGuide + bindingGuide + '\n' + request.prompt);
    if (failure) throw new Error(failure);
    if (!output.trim()) throw new Error('OMP worker did not produce a final answer');
    response.output = output;
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  } finally {
    unsubscribe?.();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    try { if (session) await session.dispose(); }
    finally { if (connection) await connection.close(); }
  }
  return response;
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
