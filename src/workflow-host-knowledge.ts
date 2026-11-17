import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { InputError, requireText } from './common.js';
import { contentSha256, KnowledgeReads, validateKnowledgeReads, type KnowledgeReadsReceipt } from './knowledge-reads.js';
import type { KnowledgeSourceBinding, OmpInvocationContext, RunBinding } from './omp-contract.js';
import type { WikiPrior } from './workflow-knowledge.js';
import type { OpenVikingReadEvidence } from './openviking/types.js';

import type { WorkflowStore } from './workflow-runtime.js';
import type { KnowledgeToolAccess, KnowledgeUpdate } from './workflow-knowledge-tools.js';
import { validateRemoteReads } from './openviking/evidence.js';
export interface HostKnowledgeState {
  binding?: RunBinding;
  source?: KnowledgeSourceBinding;
  knowledge_reads: KnowledgeReadsReceipt;
  wiki_priors: WikiPrior[];
  remote_reads: OpenVikingReadEvidence[];
}
export interface HostKnowledgeEvent {
  id: string;
  parentId?: string;
  context: OmpInvocationContext;
  operation: string;
  fingerprint: string;
  state: HostKnowledgeState;
  result: unknown;
}

export function emptyHostKnowledge(binding?: RunBinding): HostKnowledgeState {
  return { ...(binding ? { binding } : {}), knowledge_reads: new KnowledgeReads().toJSON(), wiki_priors: [], remote_reads: [] };
}

export function initializeHostKnowledge(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS host_knowledge (id TEXT PRIMARY KEY, host_session TEXT NOT NULL, tool_call TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(host_session, tool_call)) STRICT');
}

export function readHostKnowledge(db: DatabaseSync, id: string, hostSession: string): HostKnowledgeEvent {
  const row = db.prepare('SELECT body FROM host_knowledge WHERE id = ? AND host_session = ?').get(id, hostSession);
  if (!row) throw new InputError('Host knowledge association is unavailable for this session: ' + id);
  const event = JSON.parse(String(row.body)) as HostKnowledgeEvent;
  event.state.knowledge_reads = validateKnowledgeReads(event.state.knowledge_reads);
  return event;
}

export function branchHostKnowledge(db: DatabaseSync, id: string, hostSession: string) {
  const row = db.prepare('SELECT host_session FROM host_knowledge WHERE id = ?').get(id);
  if (!row) throw new InputError('Host knowledge association is unavailable: ' + id);
  // fork 的历史可包含父会话关联，但不能继承父会话的读取资格。
  return row.host_session === hostSession ? readHostKnowledge(db, id, hostSession) : undefined;
}

export function findHostKnowledge(db: DatabaseSync, hostSession: string, toolCall: string) {
  const row = db.prepare('SELECT id FROM host_knowledge WHERE host_session = ? AND tool_call = ?').get(hostSession, toolCall);
  return row ? readHostKnowledge(db, String(row.id), hostSession) : undefined;
}

function replayVisible(db: DatabaseSync, event: HostKnowledgeEvent, parentId: string | undefined, context: OmpInvocationContext) {
  if (parentId === event.parentId && context.branchLeafId === event.context.branchLeafId) return true;
  let cursor = parentId;
  while (cursor) {
    if (cursor === event.id) return true;
    const parent = readHostKnowledge(db, cursor, context.ompSessionId);
    if (parent.operation === 'binding' || parent.operation === 'clear') return false;
    cursor = parent.parentId;
  }
  return false;
}

// 调用方持有同一连接的事务；Run 写入与宿主事件不会分成两次提交。
export function recordHostKnowledge(db: DatabaseSync, context: OmpInvocationContext, operation: string, args: unknown,
  parentId: string | undefined, apply: (state: HostKnowledgeState) => unknown): HostKnowledgeEvent {
  requireText(context.ompSessionId, 'OMP session ID');
  requireText(context.toolCallId, 'tool call ID');
  const fingerprint = contentSha256(JSON.stringify([context.root, context.ompSessionId, context.binding, operation, args]));
  const previous = db.prepare('SELECT id, body FROM host_knowledge WHERE host_session = ? AND tool_call = ?')
    .get(context.ompSessionId, context.toolCallId);
  if (previous) {
    const event = JSON.parse(String(previous.body)) as HostKnowledgeEvent;
    if (event.fingerprint !== fingerprint || !replayVisible(db, event, parentId, context)) {
      throw new InputError('IDEMPOTENCY_PAYLOAD_MISMATCH ' + context.toolCallId);
    }
    return readHostKnowledge(db, event.id, context.ompSessionId);
  }
  const state = parentId ? readHostKnowledge(db, parentId, context.ompSessionId).state : emptyHostKnowledge();
  const result = apply(state);
  validateKnowledgeReads(state.knowledge_reads);
  const event: HostKnowledgeEvent = { id: randomUUID(), ...(parentId ? { parentId } : {}), context, operation, fingerprint, state, result };
  db.prepare('INSERT INTO host_knowledge VALUES (?, ?, ?, ?)').run(event.id, context.ompSessionId, context.toolCallId, JSON.stringify(event));
  return event;
}

export function hostKnowledgeAccess(store: WorkflowStore, state: HostKnowledgeState): KnowledgeToolAccess {
  const binding = () => {
    if (!state.binding) throw new InputError('Bind an explicit Evolve session and running Run with evolve_run_binding first');
    return state.binding;
  };
  return {
    receipt: () => state.knowledge_reads,
    record: (update: KnowledgeUpdate, remote?: OpenVikingReadEvidence[]) => {
      const trace = new KnowledgeReads(state.knowledge_reads);
      update(trace, prior => {
        const content_sha256 = contentSha256(prior.content);
        const existing = state.wiki_priors.find(item => item.id === prior.id);
        if (existing && (existing.content_sha256 !== content_sha256 ||
            JSON.stringify([existing.mode, existing.scope, existing.categories, existing.repositories]) !==
            JSON.stringify([prior.mode, prior.scope, prior.categories, prior.repositories]))) {
          throw new InputError('Wiki evidence changed during this host knowledge scope: ' + prior.id);
        }
        if (!state.wiki_priors.some(item => item.id === prior.id && JSON.stringify(item.lookup_scope) === JSON.stringify(prior.lookup_scope))) {
          state.wiki_priors.push({ ...prior, content_sha256 });
        }
      });
      state.knowledge_reads = trace.toJSON();
      if (remote?.length) {
        if (!state.source?.releaseId) throw new InputError('OPENVIKING_READ_BINDING_MISMATCH');
        validateRemoteReads(remote, state.source.releaseId, state.knowledge_reads, store.root);
        state.remote_reads.push(...remote);
      }
      if (state.binding) store.recordKnowledge(state.binding.session, state.binding.run, update, remote);
      return state.knowledge_reads;
    },
    readSkill: (from, destination) => {
      const { session, run } = binding();
      return store.readSkill(session, run, from, destination);
    },
    readArtifact: (id, scope) => {
      const { session, run } = binding();
      return store.readArtifact(session, run, id, scope);
    },
  };
}
