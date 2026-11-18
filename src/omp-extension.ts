import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { InputError, requireText } from './common.js';
import { KnowledgeReads } from './knowledge-reads.js';
import { knowledgeSourceFingerprint, openKnowledgeSources, type KnowledgeSources } from './knowledge-sources.js';
import { registerOmpExperience } from './omp-experience.js';
import { registerOmpIgnore } from './omp-ignore.js';
import { registerOmpMigration } from './omp-migrate.js';
import { registerOmpOpenViking } from './omp-openviking.js';
import { registerOmpStatus } from './omp-status.js';
import { emptyHostKnowledge, hostKnowledgeAccess, type HostKnowledgeEvent } from './workflow-host-knowledge.js';
import { knowledgeToolDefinitions, prepareKnowledgeTool } from './workflow-knowledge-tools.js';
import { WorkflowStore } from './workflow-runtime.js';
import { runBundledWorkflow } from './omp-cli-bridge.js';
import type { KnowledgeSourceBinding, OmpContext, OmpExtensionApi, OmpInvocationContext, OmpToolResult, RunBinding } from './omp-contract.js';

const associationType = 'self-evolving-workflow.knowledge.v1';
interface SourceLease { identity: string; pending: Promise<KnowledgeSources>; selected?: KnowledgeSourceBinding }
function toolResult(value: unknown): OmpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
}
function assertRun(store: WorkflowStore, binding?: RunBinding) {
  if (binding && store.brief(binding.session, binding.run).status !== 'running') throw new InputError('Select a running Evolve Run');
}
function latestAssociation(ctx: OmpContext, store: WorkflowStore): HostKnowledgeEvent | undefined {
  let latest: HostKnowledgeEvent | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === 'reset_boundary' || entry.customType === 'reset_boundary') latest = undefined;
    if (entry.type !== 'custom' || entry.customType !== associationType) continue;
    const data = entry.data as { eventId?: unknown } | undefined;
    latest = store.hostKnowledge(requireText(data?.eventId, 'host knowledge association'), ctx.sessionManager.getSessionId());
  }
  return latest;
}

export default function ompExtension(api: OmpExtensionApi) {
  registerOmpExperience(api);
  registerOmpIgnore(api);
  registerOmpMigration(api);
  registerOmpOpenViking(api);
  registerOmpStatus(api);

  let generation = 0;
  let active: { root: string; session: string } | undefined;
  let queue: Promise<void> = Promise.resolve();
  let lease: SourceLease | undefined;
  const retireSources = () => {
    const previous = lease;
    lease = undefined;
    if (previous) {
      // 等当前读取与证据提取结束再释放；初始化失败没有已取得的 reader。
      return queue.then(() => previous.pending.then(sources => sources.memory?.close?.(), () => undefined));
    }
  };
  const activate = (ctx: OmpContext) => {
    generation++;
    retireSources();
    active = { root: realpathSync(ctx.cwd), session: requireText(ctx.sessionManager.getSessionId(), 'OMP session ID') };
  };
  const invoke = (id: string, ctx: OmpContext, signal: AbortSignal | undefined,
    action: (context: OmpInvocationContext, guard: () => void) => Promise<OmpToolResult>) => {
    const context: OmpInvocationContext = {
      root: realpathSync(ctx.cwd), ompSessionId: requireText(ctx.sessionManager.getSessionId(), 'OMP session ID'),
      branchLeafId: ctx.sessionManager.getLeafId(), toolCallId: requireText(id, 'tool call ID'), generation,
    };
    const guard = () => {
      signal?.throwIfAborted();
      if (context.generation !== generation || active?.root !== context.root || active.session !== context.ompSessionId ||
          ctx.sessionManager.getSessionId() !== context.ompSessionId) throw new InputError('OMP invocation cancelled by a session or branch transition');
    };
    // 完整串行化 reader 操作与 drain；每次调用仍保留开始时的身份和取消代数。
    const result = queue.then(async () => { guard(); return action(context, guard); });
    // 调用者接收原 rejection；队列尾仅负责让后续独立调用继续运行。
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const publish = (event: HostKnowledgeEvent, ctx: OmpContext, guard: () => void) => {
    guard();
    if (!ctx.sessionManager.getBranch().some(entry => entry.type === 'custom' && entry.customType === associationType &&
        (entry.data as { eventId?: unknown } | undefined)?.eventId === event.id)) {
      api.appendEntry(associationType, { eventId: event.id });
    }
    return toolResult(event.result);
  };
  const sourcesFor = async (context: OmpInvocationContext, remembered?: KnowledgeSourceBinding) => {
    const fingerprint = knowledgeSourceFingerprint(context.root);
    if (remembered && remembered.fingerprint !== fingerprint) throw new InputError('Knowledge source configuration changed; use evolve_run_binding reset before searching again');
    const identity = JSON.stringify([context.root, context.ompSessionId, context.binding, fingerprint]);
    if (lease && (lease.identity !== identity || remembered && lease.selected?.releaseId !== remembered.releaseId)) retireSources();
    if (!lease) {
      const pending = openKnowledgeSources(context.root, {
        session: context.binding?.session, includeMemory: true, pinMemory: true, releaseId: remembered?.releaseId,
        ...(remembered?.backend === 'local' && !remembered.releaseId ? { memoryBackend: 'local' as const } : {}),
      });
      lease = { identity, pending };
    }
    const current = lease;
    try {
      const sources = await current.pending;
      const selected: KnowledgeSourceBinding = { fingerprint, backend: sources.backend?.active ?? 'local',
        ...(sources.releaseId ? { releaseId: sources.releaseId } : {}), ...(sources.repositoryId ? { repositoryId: sources.repositoryId } : {}) };
      current.selected = selected;
      return { sources, selected };
    } catch (error) { if (lease === current) lease = undefined; throw error; }
  };

  for (const event of ['session_start', 'session_switch', 'session_branch', 'session_tree'] as const) {
    api.on(event, (_event, ctx) => activate(ctx));
  }
  api.on('session_shutdown', async () => { generation++; active = undefined; await retireSources(); });
  api.on('session_clear', (_event, ctx) => {
    activate(ctx);
    const store = new WorkflowStore(realpathSync(ctx.cwd));
    try {
      const context: OmpInvocationContext = { root: store.root, ompSessionId: ctx.sessionManager.getSessionId(),
        branchLeafId: ctx.sessionManager.getLeafId(), toolCallId: 'clear-' + randomUUID(), generation };
      const event = store.recordHostKnowledge(context, 'clear', {}, undefined, state => {
        Object.assign(state, emptyHostKnowledge());
        delete state.binding;
        delete state.source;
        return { cleared: true };
      });
      api.appendEntry(associationType, { eventId: event.id });
    } finally { store.close(); }
  });

  const z = api.zod;
  const lookup = z.object({ repository: z.string().optional(), task: z.string().optional(),
    paths: z.array(z.string()).optional(), categories: z.array(z.string()).optional() });
  for (const tool of knowledgeToolDefinitions) {
    const parameters = tool.name === 'read_skill' ? z.object({ from: z.string().optional(), destination: z.string().optional() })
      : tool.name === 'read_artifact' ? z.object({ id: z.string(), scope: lookup.optional() })
      : tool.name === 'wiki_context' ? z.object({ query: z.string(), scope: lookup.optional() })
      : tool.name === 'memory_search' ? z.object({ query: z.string() }) : z.object({ id: z.string() });
    api.registerTool({
      name: 'evolve_' + tool.name, label: 'Evolve ' + tool.name, description: tool.description, parameters, approval: 'read',
      execute: (id, args, signal, _onUpdate, ctx) => invoke(id, ctx, signal, async (context, guard) => {
        const store = new WorkflowStore(context.root);
        try {
          const parent = latestAssociation(ctx, store);
          context.binding = parent?.state.binding;
          assertRun(store, context.binding);
          const replay = store.hostKnowledgeCall(context.ompSessionId, id);
          if (replay) {
            const event = store.recordHostKnowledge(context, tool.name, args, parent?.id, () => { throw new InputError('Replay is unavailable'); });
            return publish(event, ctx, guard);
          }
          if ((tool.name === 'read_skill' || tool.name === 'read_artifact') && !context.binding) {
            throw new InputError('Bind an explicit Evolve session and running Run with evolve_run_binding first');
          }
          const { sources, selected } = await sourcesFor(context, parent?.state.source);
          guard();
          const initial = parent?.state ?? emptyHostKnowledge(context.binding);
          const execute = await prepareKnowledgeTool(sources, tool.name, args, hostKnowledgeAccess(store, initial));
          guard();
          const event = store.recordHostKnowledge(context, tool.name, args, parent?.id, state => {
            guard();
            assertRun(store, context.binding);
            state.source = { ...selected, backend: sources.backend?.active ?? selected.backend };
            return execute(hostKnowledgeAccess(store, state));
          });
          return publish(event, ctx, guard);
        } finally { store.close(); }
      }),
    });
  }
  api.registerTool({
    name: 'evolve_run_binding', label: 'Evolve Run binding', approval: 'write',
    description: 'Explicitly bind a running Evolve session+run, unbind it, or reset knowledge scope after configuration changes. Binding changes never backfill old reads.',
    parameters: z.object({ action: z.string(), session: z.string().optional(), run: z.string().optional() }),
    execute: (id, args, signal, _onUpdate, ctx) => invoke(id, ctx, signal, async (context, guard) => {
      const action = requireText(args.action, 'binding action');
      if (!['bind', 'unbind', 'reset'].includes(action)) throw new InputError('Use bind, unbind or reset');
      const binding = action === 'bind' ? { session: requireText(args.session, 'Evolve session ID'), run: requireText(args.run, 'Evolve Run ID') } : undefined;
      const store = new WorkflowStore(context.root);
      try {
        const parent = latestAssociation(ctx, store);
        context.binding = binding;
        assertRun(store, binding);
        guard();
        const event = store.recordHostKnowledge(context, 'binding', args, parent?.id, state => {
          Object.assign(state, emptyHostKnowledge(binding));
          if (!binding) delete state.binding;
          delete state.source;
          return { binding: binding ?? null, knowledge_reads: new KnowledgeReads().toJSON() };
        });
        const result = publish(event, ctx, guard);
        generation++;
        retireSources();
        return result;
      } finally { store.close(); }
    }),
  });
  api.registerTool({
    name: 'evolve_workflow', label: 'Evolve workflow', approval: 'exec',
    description: 'Run session, run (including run task), and skill control through the bundled CLI using argv (no shell, no global evolve). For OpenViking policy use ["openviking","policy"] to inspect; identify an existing reproducible Skill entry, runner and scenarios from the repository or verified Run evidence, then pass --entry, --runner and --scenarios to preview. Never guess tests. Summarize the preview; re-submit the same arguments with --apply <preview_id> to request approval for a local Git commit, not a release. Personal experience accepts status/search/get only. Use skill install for project Skills, then commit them.',
    parameters: z.object({ argv: z.array(z.string()) }),
    execute: (id, args, signal, _onUpdate, ctx) => invoke(id, ctx, signal, async (context, guard) => {
      const argv = args.argv;
      const mainSession = ctx.agent?.kind === 'main';
      if (!mainSession && Array.isArray(argv) && argv[0] === 'openviking') {
        return toolResult({ status: 'deferred', reason: 'OpenViking policy is handled by the main session' });
      }
      if (Array.isArray(argv) && argv[0] === 'openviking' && argv[1] === 'policy' &&
          argv.some(arg => typeof arg === 'string' && (arg === '--apply' || arg.startsWith('--apply=')))) {
        if (!ctx.hasUI) throw new InputError('OpenViking policy apply requires interactive approval');
        if (!await ctx.ui.confirm('提交 OpenViking 演进策略？', `${JSON.stringify(argv)}\n仅创建本地 Git 提交，不会发布到 OpenViking。`)) {
          return toolResult({ status: 'cancelled' });
        }
        guard();
      }
      const result = await runBundledWorkflow(context.root, argv, signal, mainSession ? 'main' : 'sub');
      guard();
      return { ...toolResult(result), ...(result.exit_code !== 0 ? { isError: true } : {}) };
    }),
  });
}
