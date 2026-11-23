import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  evolveDir, evolvePath, InputError, LEGACY_AGENT_MEMORY_DIR, openDb, requireText,
  resolveEvolveStorage, transaction,
} from './common.js';
import { contentSha256, KnowledgeReads, validateKnowledgeReads, type KnowledgePriorReuse, type KnowledgeReadsReceipt } from './knowledge-reads.js';
import { Wiki } from './wiki.js';
import { appliesToContext } from './wiki-entry.js';
import { buildWikiPrior, wikiLookupScope, type WikiLookupScope, type WikiPrior } from './workflow-knowledge.js';
import { workflowName } from './workflow-names.js';
import type { AssetBinding, OpenVikingReadEvidence } from './openviking/types.js';
import { readRemoteReceipt, validateRemoteReads } from './openviking/evidence.js';
import {
  bindWorkflowSkill, readWorkflowLink, readWorkflowMarkdown, workflowBlob, workflowHash, workflowHeader, workflowMeta,
  workflowPath, workflowRecord, type ArtifactType, type WorkflowSkill, type OutputSlot,
} from './workflow-skills.js';

type StepStatus = 'pending' | 'running' | 'completed' | 'skipped';
type RunStatus = 'running' | 'blocked' | 'failed' | 'cancelled' | 'sealed';
export interface BoundaryContract {
  in_scope?: string[];
  out_of_scope?: string[];
  constraints?: string[];
  definition_of_done?: string;
}
export interface SessionGoal {
  id: string;
  goal: string;
  boundary?: string;
  done_when?: string;
  evidence?: string;
  lifecycle?: string[];
  status?: string;
}
export interface SessionAmendment {
  id: string;
  recorded_at: string;
  previous_objective: string;
  objective: string;
  definition_of_done?: string;
  evidence: string[];
  reason?: string;
}
export interface SessionPolicy {
  auto_mode?: boolean;
  goal_mode?: boolean;
}
export interface WorkflowStep {
  id: string;
  command: string;
  args: string[];
  kind?: 'step' | 'decision';
  retry_max?: number;
  decision_ref?: string;
  stage?: string;
  goal_ref?: string;
}
interface Step extends WorkflowStep {
  status: StepStatus;
  run_id?: string;
  decision?: 'proceed' | 'fix' | 'escalate';
  confidence?: number;
}
interface Run {
  id: string;
  owner: string;
  step_id: string;
  status: RunStatus;
  revision: number;
  skill: WorkflowSkill;
  task: { command: string; args: string[]; goal: string };
  inputs: string[];
  input_aliases: Record<string, string>;
  reads: Record<string, string>;
  retry_of_run_id?: string;
  summary?: string;
  finished_at?: string;
  verdict?: 'done' | 'done_with_concerns';
  knowledge_reads?: KnowledgeReadsReceipt;
  openviking_reads?: OpenVikingReadEvidence[];
  wiki_priors?: WikiPrior[];
  priors_reuse?: KnowledgePriorReuse[];
  assignments?: Record<string, Assignment>;
}
interface Assignment {
  id: string;
  role: string;
  path: string;
  result?: { summary: string; sha256: string };
  cancellation?: string;
}
interface Artifact extends ArtifactType {
  id: string;
  path: string;
  run_id: string;
  sha256: string;
  derived_from: string[];
  status: 'sealed';
  wiki_priors?: true;
}
interface Session {
  schema_version: 'evolve-session/1.0';
  id: string;
  objective: string;
  definition_of_done: string;
  boundary_contract?: BoundaryContract;
  goals?: SessionGoal[];
  amendments?: SessionAmendment[];
  policy?: SessionPolicy;
  openviking?: AssetBinding;
  status: 'open' | 'completed';
  revision: number;
  created_at: string;
  completed_at?: string;
  steps: Step[];
  runs: Run[];
  aliases: Record<string, string>;
  artifacts: Record<string, Artifact>;
}
export interface Mutation {
  actor: string;
  requestId?: string;
  revision?: number;
  runRevision?: number;
  evidence?: string[];
  reason?: string;
}
interface Publication { artifact: Artifact; bytes: Buffer }
const maxArtifactBytes = 5 * 1024 * 1024;

export function workflowId(value: unknown, label: string) {
  const id = requireText(value, label);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|constructor|prototype)$/i.test(id)) {
    throw new InputError('Invalid ' + label + ': ' + id);
  }
  return id;
}

function changed(id: string, expected: number | undefined, actual: number) {
  if (expected !== undefined && expected !== actual) {
    throw new InputError('REVISION_CONFLICT ' + id + ': expected ' + expected + ', current ' + actual);
  }
}

function findRun(session: Session, runId: string) {
  const run = session.runs.find(item => item.id === runId);
  if (!run) throw new InputError('Run not found: ' + runId);
  return run;
}

/** 生成 Session 内递增的 Run 编号（run-001 起），兼容历史 run-<uuid> 记录与已有目录。 */
function nextRunId(session: Session, dirExists: (runId: string) => boolean): string {
  let max = 0;
  for (const run of session.runs) {
    const match = /^run-(\d+)$/.exec(run.id);
    if (match) {
      const n = Number(match[1]);
      if (Number.isSafeInteger(n) && n > max) max = n;
    }
  }
  let next = max + 1;
  let candidate = `run-${String(next).padStart(3, '0')}`;
  while (session.runs.some(run => run.id === candidate) || dirExists(candidate)) {
    next++;
    candidate = `run-${String(next).padStart(3, '0')}`;
  }
  return candidate;
}

function findStep(session: Session, id: string) {
  const step = session.steps.find(item => item.id === id);
  if (!step) throw new InputError('Step not found: ' + id);
  return step;
}

function isDecisionOnlyStep(step: Pick<WorkflowStep, 'kind' | 'command' | 'decision_ref'>) {
  return step.kind === 'decision' || (!step.command && Boolean(step.decision_ref));
}

function activeDecision(session: Session) {
  const gated = session.steps.find(step => step.status === 'completed' && step.decision_ref &&
    (step.decision === undefined || step.decision === 'escalate'));
  if (gated) return gated;
  const firstPending = session.steps.find(step => step.status === 'pending');
  return firstPending && isDecisionOnlyStep(firstPending) ? firstPending : undefined;
}

function nextAction(session: Session) {
  const authority = session.policy?.auto_mode ? 'automatic' : 'manual';
  const active = session.runs.find(run => run.status === 'running' || run.status === 'blocked');
  const decision = activeDecision(session);
  if (session.status === 'completed') return { action: 'end', authority };
  if (active) return { action: active.status === 'running' ? 'execute' : 'recover', run_id: active.id, authority };
  if (decision) return { action: 'decide', decision_ref: decision.decision_ref, authority };
  if (session.steps.some(step => step.status === 'pending')) return { action: 'next', authority };
  return { action: 'complete', authority };
}

function safeFile(root: string, path: string) {
  let file = root;
  for (const part of workflowPath(path).split('/')) {
    file = join(file, part);
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) throw new InputError('Workflow files must be regular entries: ' + path);
  }
  const info = lstatSync(file);
  if (!info.isFile() || info.size > maxArtifactBytes) throw new InputError('Expected a regular file at most 5 MiB: ' + path);
  const bytes = readFileSync(file);
  if (bytes.length > maxArtifactBytes) throw new InputError('Workflow file exceeds 5 MiB: ' + path);
  return bytes;
}

function hasFiles(dir: string): boolean {
  const rootInfo = lstatSync(dir, { throwIfNoEntry: false });
  if (!rootInfo || !rootInfo.isDirectory()) return Boolean(rootInfo);
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    const info = lstatSync(child, { throwIfNoEntry: false });
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) return true;
    if (hasFiles(child)) return true;
  }
  return false;
}

function expandSlot(directory: string, slot: string) {
  if (!slot.includes('{')) return [slot];
  const parent = slot.slice(0, slot.lastIndexOf('/'));
  const dir = join(directory, workflowPath(parent));
  const info = lstatSync(dir, { throwIfNoEntry: false });
  if (!info) return [];
  if (!info.isDirectory()) throw new InputError('Invalid output directory: ' + parent);
  const pattern = slot.slice(parent.length + 1).split(/(\{[a-zA-Z_]+\})/).map(part =>
    part.startsWith('{') ? '[A-Za-z0-9_-]+' : part.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')).join('');
  return readdirSync(dir).filter(path => new RegExp('^' + pattern + '$').test(path)).map(path => parent + '/' + path);
}

function artifactMetadata(path: string, bytes: Buffer) {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (path.endsWith('.json') || path.endsWith('.ndjson')) {
    const records = path.endsWith('.ndjson') ? text.trim().split(/\r?\n/).map(line => JSON.parse(line)) : [JSON.parse(text)];
    return workflowMeta(workflowRecord(records[0], 'artifact body')._meta);
  }
  return workflowMeta(workflowHeader(text));
}

export function workflowDbPath(root: string) {
  return resolveEvolveStorage(root, ['workflow.db'], join(resolve(root), LEGACY_AGENT_MEMORY_DIR, 'workflow.db'));
}

export function readEvolveSessions(root: string, id?: string): Session[] {
  const path = workflowDbPath(root);
  if (!existsSync(path)) return [];
  const db = openDb(path, true);
  try {
    const rows = id ? db.prepare('SELECT body FROM sessions WHERE id = ?').all(id)
      : db.prepare('SELECT body FROM sessions ORDER BY id').all();
    return rows.map(row => JSON.parse(String(row.body)) as Session);
  } finally {
    db.close();
  }
}

/** Run 结局：被重试、失败、阻塞、取消或带顾虑完成均视为非干净结局。 */
export function runOutcome(session: Session, run: Run): 'clean' | 'non_clean' | 'pending' {
  if (run.status === 'failed' || run.status === 'blocked' || run.status === 'cancelled' ||
      run.verdict === 'done_with_concerns' || session.runs.some(other => other.retry_of_run_id === run.id)) {
    return 'non_clean';
  }
  return run.status === 'sealed' ? 'clean' : 'pending';
}

/** Session 完成后提示自进化的信号，供完成回执与提醒共用。 */
export function sessionEvolveSignals(session: Session): string[] {
  const signals: string[] = [];
  if (session.runs.some(run => Boolean(run.retry_of_run_id))) signals.push('run_retry');
  if (session.runs.some(run => run.status === 'failed' || run.status === 'blocked' || run.status === 'cancelled')) {
    signals.push('non_clean_run');
  }
  if (session.runs.some(run => run.verdict === 'done_with_concerns')) signals.push('done_with_concerns');
  if (session.runs.length > 0 && session.runs.every(run => !run.knowledge_reads?.reads.length && !run.knowledge_reads?.searches.length)) {
    signals.push('empty_knowledge_reads');
  }
  return signals;
}

export function evolveSessionReceipt(session: Session) {
  if (session.status !== 'completed' || !session.completed_at) {
    throw new InputError('Complete the Evolve Session before harvesting its evidence');
  }
  return {
    schema_version: 'evolve-session-completion/1.0',
    id: workflowHash(JSON.stringify([session.id, session.created_at, session.completed_at, session.revision])).slice(7),
    session_id: session.id,
    recorded_at: session.completed_at,
    messages: session.runs.flatMap(run => {
      const timestamp = run.finished_at ?? session.completed_at!;
      return [
        { id: run.id + ':outcome', role: 'tool' as const, timestamp,
          content: [run.task.command + ' ' + run.status, run.summary, run.retry_of_run_id && 'retries ' + run.retry_of_run_id]
            .filter(Boolean).join('. ') },
        ...(run.knowledge_reads ? [{ id: run.id + ':knowledge-reads', role: 'tool' as const, timestamp,
          content: JSON.stringify(run.knowledge_reads) }] : []),
      ];
    }),
  };
}

export function* readCompletedVerificationArtifacts(root: string, id?: string) {
  const sessions = readEvolveSessions(root, id).filter(session => session.status === 'completed');
  if (!sessions.length) return;
  const db = openDb(workflowDbPath(root), true);
  try {
    const read = db.prepare('SELECT body FROM artifacts WHERE session = ? AND id = ?');
    for (const session of sessions) {
      const finalRuns = new Set(session.steps.flatMap(step => step.status === 'completed' && step.run_id ? [step.run_id] : []));
      const verified = new Map(session.runs.filter(run => finalRuns.has(run.id) && runOutcome(session, run) === 'clean')
        .map(run => [run.id, run.skill.skill_id]));
      for (const artifact of Object.values(session.artifacts)) {
        if (artifact.role !== 'primary' || artifact.status !== 'sealed' || !(
          artifact.schema === 'test-results/1.0' && verified.get(artifact.run_id) === 'ew-test' ||
          artifact.schema === 'verification/1.0' && verified.get(artifact.run_id) === 'ew-verify'
        )) continue;
        const value = read.get(session.id, artifact.id)?.body;
        const bytes = value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : undefined;
        if (!bytes || workflowHash(bytes) !== artifact.sha256) {
          throw new InputError('Sealed verification bytes are unavailable or changed: ' + artifact.id);
        }
        yield { session: session.id, id: artifact.id, sha256: artifact.sha256, schema: artifact.schema,
          body: workflowRecord(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), 'verification artifact') };
      }
    }
  } finally { db.close(); }
}

export class WorkflowStore {
  private readonly db: ReturnType<typeof openDb>;
  constructor(readonly root: string) {
    const path = workflowDbPath(root);
    mkdirSync(dirname(path), { recursive: true });
    this.db = openDb(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;',
      'CREATE TABLE IF NOT EXISTS requests (session TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY (session, id), FOREIGN KEY (session) REFERENCES sessions(id)) STRICT;',
      'CREATE TABLE IF NOT EXISTS artifacts (session TEXT NOT NULL, id TEXT NOT NULL, body BLOB NOT NULL, PRIMARY KEY (session, id), FOREIGN KEY (session) REFERENCES sessions(id)) STRICT;',
    ].join('\n'));
  }

  close() { this.db.close(); }

  find(id: string) {
    const row = this.db.prepare('SELECT body FROM sessions WHERE id = ?').get(id);
    return row ? JSON.parse(String(row.body)) as Session : undefined;
  }

  status(id: string) {
    const session = this.find(id);
    if (!session) {
      if (existsSync(join(this.root, '.workflow', 'sessions', workflowId(id, 'Session ID')))) {
        throw new InputError('Historical Session: use evolve session review or evolve kb harvest session to inspect pre-Evolve Sessions');
      }
      throw new InputError('Evolve Session not found: ' + id);
    }
    return { ...session, orchestration_revision: session.revision, continuation: nextAction(session) };
  }

  list(filter?: { status?: 'open' | 'completed'; query?: string }) {
    const query = filter?.query?.trim().toLowerCase();
    return this.db.prepare('SELECT body FROM sessions ORDER BY id').all().map(row => {
      const session = JSON.parse(String(row.body)) as Session;
      return { id: session.id, objective: session.objective, status: session.status,
        orchestration_revision: session.revision, steps: session.steps,
        ...(session.goals ? { goals: session.goals } : {}),
        ...(session.policy ? { policy: session.policy } : {}),
        continuation: nextAction(session) };
    }).filter(item => (!filter?.status || item.status === filter.status) &&
      (!query || item.id.toLowerCase().includes(query) || item.objective.toLowerCase().includes(query)));
  }

  private save(session: Session) {
    this.db.prepare('INSERT INTO sessions VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(session.id, JSON.stringify(session));
  }

  private change<T extends object>(id: string, operation: string, mutation: Mutation, input: unknown, apply: () => T) {
    const actor = workflowId(mutation.actor, 'actor');
    const fingerprint = workflowHash(JSON.stringify([operation, actor, mutation.revision, mutation.runRevision, mutation.evidence, mutation.reason, input]));
    const requestId = mutation.requestId ? workflowId(mutation.requestId, 'request ID')
      : (mutation.revision === undefined && operation !== 'session.open' ? 'req-' + randomUUID() : fingerprint.slice(7));
    type Receipt = T & { receipt: { request_id: string; action: string; actor: string; recorded_at: string; evidence: string[]; reason?: string } };
    return transaction(this.db, () => {
      const saved = this.db.prepare('SELECT fingerprint, receipt FROM requests WHERE session = ? AND id = ?').get(id, requestId);
      if (saved) {
        if (saved.fingerprint !== fingerprint) throw new InputError('IDEMPOTENCY_PAYLOAD_MISMATCH ' + requestId);
        return JSON.parse(String(saved.receipt)) as Receipt;
      }
      const receipt = { ...apply(), receipt: { request_id: requestId, action: operation, actor,
        recorded_at: new Date().toISOString(), evidence: mutation.evidence ?? [], reason: mutation.reason } };
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?)').run(id, requestId, fingerprint, JSON.stringify(receipt));
      return receipt;
    });
  }

  private mutate<T extends object>(id: string, operation: string, change: Mutation, input: unknown, apply: (session: Session) => T) {
    return this.change(id, operation, change, input, () => {
      const session = this.status(id);
      if (session.status !== 'open') throw new InputError('Session is completed: ' + id);
      changed(id, change.revision, session.revision);
      const result = apply(session);
      session.revision++;
      // 续步由已持久化的状态计算。
      const { continuation: _continuation, orchestration_revision: _revision, ...saved } = session;
      this.save(saved);
      return { ...result, session_id: id, orchestration_revision: session.revision, continuation: nextAction(session) };
    });
  }

  open(id: string, objective: string, definition: string, steps: WorkflowStep[], change: Mutation, options?: {
    boundaryContract?: BoundaryContract; goals?: SessionGoal[]; policy?: SessionPolicy;
    openviking?: Pick<AssetBinding, 'project_id' | 'release_id' | 'manifest_sha256'>;
  }) {
    workflowId(id, 'Session ID');
    return this.change(id, 'session.open', change, { objective, definition, steps, ...options }, () => {
      if (this.find(id) || existsSync(join(this.root, '.workflow', 'sessions', id))) throw new InputError('Session ID already exists: ' + id);
      if (options?.openviking) this.assertAssetSessionAvailable(id);
      const existing = new Set<string>();
      const chain = steps.map(step => {
        this.validateStep(step, undefined, Boolean(options?.openviking));
        if (existing.has(step.id) || (step.decision_ref && steps.filter(item => item.decision_ref === step.decision_ref).length > 1)) {
          throw new InputError('Duplicate chain step or decision: ' + step.id);
        }
        existing.add(step.id);
        return { ...step, command: step.command ? workflowName(step.command) : '', status: 'pending' as const };
      });
      const session: Session = {
        schema_version: 'evolve-session/1.0', id, objective: requireText(objective, 'objective'), definition_of_done: definition,
        ...(options?.boundaryContract ? { boundary_contract: options.boundaryContract } : {}),
        ...(options?.goals ? { goals: options.goals } : {}),
        ...(options?.policy ? { policy: options.policy } : {}),
        ...(options?.openviking ? { openviking: { ...options.openviking, phase: 'preparing' as const } } : {}),
        created_at: new Date().toISOString(), revision: 0, status: 'open', steps: chain, runs: [], aliases: {}, artifacts: {},
      };
      this.save(session);
      return { session_id: id, status: 'open', orchestration_revision: 0, continuation: nextAction(session) };
    });
  }

  private validateStep(step: WorkflowStep, commit?: string, preparing = false) {
    workflowId(step.id, 'step ID');
    if (step.decision_ref) workflowId(step.decision_ref, 'decision ID');
    if (step.retry_max !== undefined && (!Number.isSafeInteger(step.retry_max) || step.retry_max < 1)) {
      throw new InputError('retry_max must be a positive integer');
    }
    if (isDecisionOnlyStep(step)) {
      if (!step.decision_ref) throw new InputError('Decision-only steps require a decision ID');
      if (step.command) throw new InputError('Decision-only steps cannot bind a Skill command');
      return;
    }
    if (!preparing) bindWorkflowSkill(this.root, step.command, commit);
    if (/^ew-odyssey-(security|defensive)$/.test(workflowName(step.command)) && step.args.includes('--fix')) {
      throw new InputError('This Odyssey mode uses a read-only audit');
    }
  }

  assertAssetSessionAvailable(id: string) {
    for (const row of this.db.prepare('SELECT body FROM sessions WHERE id <> ?').all(id)) {
      const session = JSON.parse(String(row.body)) as Session;
      if (session.openviking && (session.status === 'open' || ['pending', 'running'].includes(session.openviking.publication?.state ?? ''))) {
        throw new InputError('OPENVIKING_ACTIVE_SESSION: ' + session.id);
      }
    }
  }

  bindAssets(id: string, binding: { release_id: string; manifest_sha256: string; skill_commit: string }, change: Mutation) {
    return this.mutate(id, 'session.bind-assets', change, binding, session => {
      const assets = session.openviking;
      if (!assets || assets.release_id !== binding.release_id || assets.manifest_sha256 !== binding.manifest_sha256 ||
          assets.phase === 'ready' && assets.skill_commit !== binding.skill_commit) throw new InputError('OPENVIKING_BINDING_MISMATCH');
      for (const step of session.steps) this.validateStep(step, binding.skill_commit);
      Object.assign(assets, binding, { phase: 'ready' });
      return { openviking: assets };
    });
  }

  recordAssetPublication(id: string, publication: NonNullable<AssetBinding['publication']>, change: Mutation) {
    return this.change(id, 'session.asset-publication', change, publication, () => {
      const session = this.status(id);
      changed(id, change.revision, session.revision);
      if (session.status !== 'completed' || !session.openviking) throw new InputError('OPENVIKING_SESSION_NOT_COMPLETED');
      const previous = session.openviking.publication?.state;
      const terminal = ['no_change', 'published'];
      if (terminal.includes(previous ?? '')) {
        if (JSON.stringify(session.openviking.publication) !== JSON.stringify(publication)) throw new InputError('OPENVIKING_PUBLICATION_TERMINAL');
      } else if (publication.state === 'running') this.assertAssetSessionAvailable(id);
      else if (previous !== 'running' || !['no_change', 'published', 'failed', 'conflict'].includes(publication.state)) {
        throw new InputError('OPENVIKING_PUBLICATION_TRANSITION');
      }
      session.openviking.publication = publication;
      session.revision++;
      const { continuation: _continuation, orchestration_revision: _revision, ...saved } = session;
      this.save(saved);
      return { session_id: id, orchestration_revision: session.revision, openviking: session.openviking, continuation: nextAction(session) };
    });
  }

  wikiRoot(id: string) {
    const assets = this.status(id).openviking;
    if (assets?.phase === 'preparing') throw new InputError('OPENVIKING_ASSETS_NOT_READY');
    return assets ? join(this.root, '.agent-memory', 'openviking', 'releases', assets.release_id, 'wiki') : this.root;
  }

  amend(id: string, objective: string, definition: string | undefined, change: Mutation) {
    return this.mutate(id, 'session.amend', change, { objective, definition }, session => {
      if (session.runs.some(run => run.status === 'blocked' || run.status === 'running')) {
        throw new InputError('Resolve the active Run before amending the Session');
      }
      if (!change.evidence?.length) throw new InputError('Supply evidence for the approved amendment');
      const previous = session.objective;
      session.objective = requireText(objective, 'amended objective');
      if (definition !== undefined) session.definition_of_done = requireText(definition, 'definition of done');
      const amendments = (session.amendments ??= []);
      const amendment: SessionAmendment = {
        id: 'CHG-' + String(amendments.length + 1).padStart(3, '0'),
        recorded_at: new Date().toISOString(), previous_objective: previous, objective: session.objective,
        ...(definition !== undefined ? { definition_of_done: session.definition_of_done } : {}),
        evidence: change.evidence, ...(change.reason ? { reason: change.reason } : {}),
      };
      amendments.push(amendment);
      return { amendment_id: amendment.id, previous_objective: previous, objective: session.objective, definition_of_done: session.definition_of_done };
    });
  }

  chain(id: string, action: 'insert' | 'replace' | 'skip', step: WorkflowStep, after: string | undefined, change: Mutation) {
    return this.mutate(id, 'chain.' + action, change, { step, after }, session => {
      if (session.openviking?.phase === 'preparing') throw new InputError('OPENVIKING_ASSETS_NOT_READY');
      const current = session.steps.findIndex(item => item.id === step.id);
      if (action === 'insert') {
        if (current >= 0) throw new InputError('Step already exists: ' + step.id);
        this.validateStep(step, session.openviking?.skill_commit);
        if (step.decision_ref && session.steps.some(item => item.decision_ref === step.decision_ref)) throw new InputError('Decision already exists');
        const index = after ? session.steps.findIndex(item => item.id === after) + 1 : session.steps.length;
        const firstPending = session.steps.findIndex(item => item.status === 'pending');
        if ((after && index === 0) || index < (firstPending < 0 ? session.steps.length : firstPending)) {
          throw new InputError('Insert the step in the pending chain');
        }
        session.steps.splice(index, 0, { ...step, command: step.command ? workflowName(step.command) : '', status: 'pending' });
      } else {
        const original = findStep(session, step.id);
        if (original.status !== 'pending') throw new InputError('Select a pending step');
        if (action === 'replace') {
          const replacement = { ...original, ...step, decision_ref: step.decision_ref ?? original.decision_ref };
          this.validateStep(replacement, session.openviking?.skill_commit);
          if (replacement.decision_ref && session.steps.some(item => item.id !== step.id && item.decision_ref === replacement.decision_ref)) {
            throw new InputError('Decision already exists');
          }
          session.steps[current] = { ...replacement, command: replacement.command ? workflowName(replacement.command) : '' };
        } else {
          if (!change.evidence?.length) throw new InputError('Supply evidence for a skipped step');
          original.status = 'skipped';
        }
      }
      return { step_id: step.id, status: action === 'skip' ? 'skipped' : 'pending' };
    });
  }

  private runDir(id: string, runId: string) {
    const target = evolvePath(this.root, 'runs', id, runId);
    if (existsSync(target)) return target;
    const legacy = join(resolve(this.root), LEGACY_AGENT_MEMORY_DIR, 'workflow', 'runs', id, runId);
    return existsSync(legacy) ? legacy : target;
  }

  private packet(session: Session, run: Run) {
    const knowledgeProfile = {
      task: workflowName(run.task.command).replace(/^ew-/, ''),
      ...(run.skill.wiki_categories?.length ? { categories: run.skill.wiki_categories } : {}),
      ...(run.skill.search_profile?.wiki?.length ? { wiki: run.skill.search_profile.wiki } : {}),
      ...(run.skill.search_profile?.memory?.length ? { memory_types: run.skill.search_profile.memory } : {}),
    };
    return {
      session_id: session.id, run_id: run.id, run_dir: this.runDir(session.id, run.id),
      status: run.status, revision: run.revision, orchestration_revision: session.revision,
      task: { ...run.task, input_refs: run.inputs },
      skill_ref: run.skill, skill_entry_path: run.skill.package_path + '/' + run.skill.entry,
      gates: run.skill.gates, upstream_aliases: run.input_aliases,
      knowledge_profile: knowledgeProfile,
      upstream: Object.fromEntries(run.inputs.map(id => [id, session.artifacts[id]])),
      skill_reads: this.readProof(run), retry_of_run_id: run.retry_of_run_id,
      ...(session.boundary_contract ? { boundary_contract: session.boundary_contract } : {}),
      ...(session.goals ? { goals: session.goals } : {}),
      ...(session.amendments ? { amendments: session.amendments } : {}),
      ...(session.policy ? { policy: session.policy } : {}),
      ...(run.knowledge_reads ? { knowledge_reads: run.knowledge_reads } : {}),
      ...(session.openviking ? { openviking: session.openviking } : {}),
      ...(run.openviking_reads ? { openviking_reads: run.openviking_reads } : {}),
    };
  }

  next(id: string, change: Mutation, gates: string[] = [], stepId?: string) {
    const packet = this.mutate(id, 'run.next', change, { gates, stepId }, session => {
      if (session.openviking?.phase === 'preparing') throw new InputError('OPENVIKING_ASSETS_NOT_READY');
      if (nextAction(session).action !== 'next') throw new InputError('Workflow continuation does not dispatch a Run');
      const step = session.steps.find(item => item.status === 'pending')!;
      if (stepId && step.id !== stepId) throw new InputError('Run creation must follow the pending chain');
      const attempts = session.runs.filter(item => item.step_id === step.id && item.status !== 'running').length;
      if (step.retry_max !== undefined && attempts >= step.retry_max) {
        throw new InputError('Retry limit exceeded for step: ' + step.id);
      }
      const command = workflowName(step.command);
      const skill = bindWorkflowSkill(this.root, command, session.openviking?.skill_commit);
      const missing = skill.gates.entry.filter(gate => !gates.includes(gate));
      if (missing.length) throw new InputError('Missing entry gates: ' + missing.join(', '));
      const args = step.args.map(arg => arg.replaceAll('{session}', session.id).replaceAll('{intent}', session.objective));
      const runId = nextRunId(session, candidate => existsSync(this.runDir(session.id, candidate)));
      const run: Run = {
        id: runId, owner: change.actor, step_id: step.id, status: 'running', revision: 0, skill,
        task: { command, args, goal: session.objective },
        inputs: [], input_aliases: {}, reads: {},
        ...(step.run_id ? { retry_of_run_id: step.run_id } : {}),
      };
      for (const slot of skill.consumes) {
        const artifact = slot.alias ? session.artifacts[session.aliases[slot.alias]] :
          Object.values(session.artifacts).findLast(item => item.kind === slot.kind && item.schema === slot.schema && item.role === slot.role);
        if (!artifact || artifact.kind !== slot.kind || artifact.schema !== slot.schema || artifact.role !== slot.role ||
            (!slot.accepts_negative_evidence && findRun(session, artifact.run_id).verdict === 'done_with_concerns')) {
          if (slot.required) throw new InputError('Required upstream artifact: ' + (slot.alias ?? slot.kind));
          continue;
        }
        run.inputs.push(artifact.id);
        if (slot.alias) run.input_aliases[slot.alias] = artifact.id;
        if (slot.role === 'primary') {
          run.inputs.push(...Object.values(session.artifacts)
            .filter(item => item.run_id === artifact.run_id && (item.role === 'attachment' || item.role === 'evidence'))
            .map(item => item.id));
        }
      }
      run.inputs = [...new Set(run.inputs)];
      session.runs.push(run);
      step.status = 'running';
      step.run_id = run.id;
      return this.packet(session, run);
    });
    if (packet.skill_ref.produces.some(slot => slot.required)) {
      mkdirSync(join(packet.run_dir, 'outputs'), { recursive: true });
    }
    return packet;
  }

  brief(id: string, runId: string) {
    const session = this.status(id);
    const packet = this.packet(session, findRun(session, runId));
    if (packet.status !== 'sealed' && packet.skill_ref.produces.some(slot => slot.required)) {
      mkdirSync(join(packet.run_dir, 'outputs'), { recursive: true });
    }
    return { ...packet, continuation: nextAction(session) };
  }

  readSkill(id: string, runId: string, from?: string, destination?: string) {
    return transaction(this.db, () => {
      const session = this.find(id);
      if (!session) throw new InputError('Evolve Session not found: ' + id);
      const run = findRun(session, runId);
      if ((from === undefined) !== (destination === undefined)) throw new InputError('Supply both --from and a Markdown destination');
      if (from && !Object.hasOwn(run.reads, from)) throw new InputError('Read the source document first: ' + from);
      const read = from && destination ? readWorkflowLink(this.root, run.skill, from, destination)
        : readWorkflowMarkdown(this.root, run.skill, run.skill.entry);
      if (run.status === 'running' || run.status === 'blocked') {
        run.reads[read.path] = read.sha256;
        this.save(session);
      }
      return { ...read, recorded: Object.hasOwn(run.reads, read.path) };
    });
  }

  readArtifact(id: string, runId: string, artifactId: string, scope: WikiLookupScope = {}) {
    const session = this.status(id);
    const run = findRun(session, runId);
    const resolved = run.input_aliases[artifactId] ?? artifactId;
    if (!run.inputs.includes(resolved)) throw new InputError('Artifact is outside the Run input binding: ' + artifactId);
    const artifact = session.artifacts[resolved];
    const bytes = this.db.prepare('SELECT body FROM artifacts WHERE session = ? AND id = ?').get(id, resolved)?.body;
    if (!(bytes instanceof Uint8Array) || workflowHash(Buffer.from(bytes)) !== artifact.sha256) {
      throw new InputError('Sealed artifact bytes are unavailable or changed: ' + resolved);
    }
    const content = Buffer.from(bytes).toString('utf8');
    if (artifact.wiki_priors) {
      const scopes = workflowRecord(JSON.parse(content), 'session-priors').lookup_scopes;
      const expected = JSON.stringify(wikiLookupScope(scope));
      if (!Array.isArray(scopes) || !scopes.some(item => JSON.stringify(wikiLookupScope(item)) === expected)) {
        throw new InputError('Wiki scope is outside session-priors; use evolve search --mode context in this Run');
      }
      transaction(this.db, () => {
        const latest = this.status(id);
        const consumer = findRun(latest, runId);
        if (consumer.status !== 'running' || consumer.priors_reuse?.some(item => item.artifact_id === artifact.id)) return;
        (consumer.priors_reuse ??= []).push({ artifact_id: artifact.id, producer_run_id: artifact.run_id, content_sha256: artifact.sha256 });
        const { continuation: _continuation, orchestration_revision: _revision, ...saved } = latest;
        this.save(saved);
      });
    }
    return { ...artifact, content };
  }

  private readProof(run: Run) {
    return {
      reference: run.skill, reads: Object.entries(run.reads).map(([path, sha256]) => ({ path, sha256 })),
      missing: run.skill.required_links.filter(path => !Object.hasOwn(run.reads, path)),
    };
  }

  private cliWikiPriors(session: Session, knowledge: KnowledgeReadsReceipt | undefined) {
    if (!knowledge || (!knowledge.constraints_bound.length && !knowledge.reads.some(item => item.kind === 'wiki'))) return;
    const project = new Wiki(this.wikiRoot(session.id));
    const global = new Wiki(evolveDir(homedir()));
    const priors: WikiPrior[] = [];
    const scopeFrom = (filters: Record<string, unknown> = {}) => wikiLookupScope(Object.fromEntries(
      Object.entries(filters).filter(([key]) => ['repository', 'task', 'paths', 'categories'].includes(key)),
    ));
    const pin = (id: string, hash: string | undefined, lookup: WikiLookupScope,
      storageScope?: 'project' | 'global', checkScope = true, searchId = '') => {
      const layers = storageScope === 'global' ? [global] : storageScope === 'project' ? [project] : [project, global];
      const pages = layers.map(wiki => ({ page: wiki.getEntry(id), wiki })).filter(item => item.page);
      const selected = pages.find(item => !hash || contentSha256(item.page!.body) === hash);
      if (!selected) throw new InputError('Wiki evidence changed or disappeared during this Run: ' + id);
      const page = selected.page!;
      if (checkScope && page.entry && (page.entry.status !== 'active' || !appliesToContext(page.entry, lookup, page.body))) {
        throw new InputError('Wiki evidence is no longer available in the recorded scope: ' + id);
      }
      const prior = buildWikiPrior(page, page.entry?.mode === 'constraint' ? 'constraint' : 'reference', lookup, searchId);
      return { ...prior, storage_scope: selected.wiki === global ? 'global' as const : 'project' as const };
    };
    for (const bound of knowledge.constraints_bound) {
      priors.push(pin(bound.knowledge_id, bound.content_sha256, scopeFrom(bound.lookup_scope),
        bound.storage_scope, bound.lookup_scope !== undefined));
    }
    for (const read of knowledge.reads) {
      if (read.kind !== 'wiki' || priors.some(item => item.id === read.id)) continue;
      const search = knowledge.searches.find(item => item.search_id === read.from_search_id);
      if (search && (!['wiki', 'wiki_references', 'context'].includes(search.source) || !search.returned_ids.includes(read.id))) {
        throw new InputError('Wiki read was not returned by its recorded search: ' + read.id);
      }
      const storageScope = search?.filters?.scope === 'project' || search?.filters?.scope === 'global'
        ? search.filters.scope : undefined;
      priors.push(pin(read.id, read.content_sha256, scopeFrom(search?.filters), storageScope,
        search !== undefined, read.from_search_id ?? ''));
    }
    return priors.length ? priors : undefined;
  }

  private outputs(session: Session, run: Run, gates: string[]) {
    const directory = this.runDir(session.id, run.id);
    const errors: string[] = [];
    errors.push(...run.skill.gates.exit.filter(gate => !gates.includes(gate)).map(gate => 'Required exit gate: ' + gate));
    if (run.status !== 'running') errors.push('Complete a running Run');
    for (const item of Object.values(run.assignments ?? {})) {
      if (item.cancellation) continue;
      const bytes = item.result && safeFile(directory, item.path);
      if (!item.result || !bytes || workflowHash(bytes) !== item.result.sha256) errors.push('Swarm assignment evidence: ' + item.id);
    }
    const trace = safeFile(directory, 'knowledge-reads.json');
    if (trace && run.knowledge_reads) errors.push('Select a single Run knowledge receipt source');
    const knowledge = trace ? validateKnowledgeReads(JSON.parse(trace.toString('utf8'))) : run.knowledge_reads;
    if (trace && knowledge?.priors_reuse) errors.push('Run reuse evidence comes from bound artifact reads');
    const receipt = run.priors_reuse?.length
      ? { ...(knowledge ?? new KnowledgeReads().toJSON()), priors_reuse: run.priors_reuse } : knowledge;
    const remotePath = join(directory, 'knowledge-reads.json.openviking.json');
    const remoteBytes = safeFile(directory, 'knowledge-reads.json.openviking.json');
    const remoteReceipt = remoteBytes ? readRemoteReceipt(remotePath) : undefined;
    const remoteReads = remoteReceipt?.reads ?? run.openviking_reads;
    if (remoteReceipt && (remoteReceipt.project_id !== session.openviking?.project_id || remoteReceipt.release_id !== session.openviking?.release_id)) throw new InputError('OPENVIKING_READ_BINDING_MISMATCH');
    if (remoteReads?.length) {
      if (!session.openviking) throw new InputError('OPENVIKING_READ_BINDING_MISMATCH');
      validateRemoteReads(remoteReads, session.openviking.release_id, receipt, this.root);
    }
    const reportBytes = safeFile(directory, 'report.md');
    if (reportBytes) {
      const reportMeta = workflowHeader(reportBytes.toString('utf8'));
      if (Array.isArray(reportMeta.next)) {
        for (const item of reportMeta.next) {
          if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).command === 'string') {
            const cmd = (item as Record<string, string>).command;
            try { bindWorkflowSkill(this.root, cmd, session.openviking?.skill_commit); } catch { errors.push('Invalid report.md next command: ' + cmd); }
          }
        }
      }
    }
    const publications: Publication[] = [];
    for (const slot of run.skill.produces) {
      const isPriorsSlot = slot.alias === 'session-priors' && slot.kind === 'priors' && slot.schema === 'priors/1.0'
        && slot.path === 'outputs/priors.json';
      const priors = isPriorsSlot ? (run.wiki_priors?.length ? run.wiki_priors : this.cliWikiPriors(session, knowledge)) : undefined;
      const generated = priors?.length ? Buffer.from(JSON.stringify({
        _meta: { alias: slot.alias, kind: slot.kind, schema: slot.schema, role: slot.role },
        source_run_id: run.id,
        lookup_scopes: [...new Map(priors.map(item => [JSON.stringify(item.lookup_scope), item.lookup_scope])).values()],
        wiki: priors,
      })) : undefined;
      let discovered = 0;
      for (const path of generated ? [slot.path] : expandSlot(directory, slot.path)) {
        const bytes = generated ?? safeFile(directory, path);
        if (!bytes) continue;
        discovered++;
        if (bytes.length > maxArtifactBytes) errors.push('Artifact exceeds the size limit: ' + path);
        const meta = artifactMetadata(path, bytes);
        if (meta.kind !== slot.kind || meta.schema !== slot.schema || meta.role !== slot.role || meta.alias !== slot.alias) {
          errors.push('Artifact metadata does not match the Skill contract: ' + path);
        }
        if (workflowName(run.task.command).startsWith('ew-odyssey-') && path === 'outputs/session.json' &&
            workflowRecord(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), 'Odyssey checkpoint').current_state !== 'END') {
          errors.push('Finish the Odyssey domain checkpoint before sealing');
        }
        const artifact: Artifact = { ...meta, id: 'art-' + randomUUID(), path, run_id: run.id,
          sha256: workflowHash(bytes), derived_from: run.inputs, status: 'sealed', ...(generated ? { wiki_priors: true } : {}) };
        publications.push({ artifact, bytes });
      }
      if (!discovered && slot.required) errors.push('Required artifact: ' + slot.path);
    }
    return { errors, publications, knowledge: receipt, remoteReads };
  }

  check(id: string, runId: string, gates: string[]) {
    const session = this.status(id);
    const run = findRun(session, runId);
    if (run.status === 'sealed') return {
      ...this.packet(session, run), completion_preflight: { ready: false, errors: ['Run is sealed'] },
      knowledge_reads: run.knowledge_reads,
    };
    const { errors, knowledge } = this.outputs(session, run, gates);
    return { ...this.packet(session, run), completion_preflight: { ready: errors.length === 0, errors }, knowledge_reads: knowledge };
  }

  completeRun(id: string, runId: string, summary: string, verdict: 'done' | 'done_with_concerns', gates: string[], change: Mutation) {
    return this.mutate(id, 'run.complete', change, { runId, summary, verdict, gates }, session => {
      const run = findRun(session, runId);
      changed(runId, change.runRevision, run.revision);
      const { errors, publications, knowledge, remoteReads } = this.outputs(session, run, gates);
      if (errors.length) throw new InputError(errors.join('\n'));
      const artifacts: Record<string, Artifact> = {};
      const aliases: Record<string, string> = {};
      for (const { artifact, bytes } of publications) {
        this.db.prepare('INSERT INTO artifacts VALUES (?, ?, ?)').run(id, artifact.id, bytes);
        artifacts[artifact.id] = artifact;
        if (artifact.alias) aliases[artifact.alias] = artifact.id;
      }
      Object.assign(session.artifacts, artifacts);
      session.aliases = { ...session.aliases, ...aliases };
      run.status = 'sealed';
      run.revision++;
      run.finished_at = new Date().toISOString();
      run.verdict = verdict;
      run.summary = requireText(summary, 'Run summary');
      run.knowledge_reads = knowledge;
      run.openviking_reads = remoteReads;
      delete run.wiki_priors;
      delete run.priors_reuse;
      findStep(session, run.step_id).status = 'completed';
      return { ...this.packet(session, run), artifact_publication: { artifacts, aliases }, knowledge_reads: knowledge };
    });
  }

  transition(id: string, runId: string, status: 'running' | 'blocked' | 'failed' | 'cancelled', reason: string, change: Mutation) {
    const packet = this.mutate(id, 'run.transition', change, { runId, status, reason }, session => {
      const run = findRun(session, runId);
      changed(runId, change.runRevision, run.revision);
      if ((run.status !== 'blocked' && run.status !== 'running') || run.status === status) throw new InputError('Invalid Run transition');
      run.status = status;
      run.revision++;
      run.summary = requireText(reason, 'transition reason');
      if (status === 'failed' || status === 'cancelled') {
        run.finished_at = new Date().toISOString();
        findStep(session, run.step_id).status = 'pending';
      }
      return this.packet(session, run);
    });
    if (status === 'cancelled' && !packet.knowledge_reads) {
      const dir = this.runDir(id, runId);
      if (existsSync(dir) && !hasFiles(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return packet;
  }

  decide(id: string, decisionId: string, verdict: 'proceed' | 'fix' | 'escalate', summary: string, change: Mutation,
    options?: { targetStepId?: string; confidence?: number }) {
    return this.mutate(id, 'run.decide', change, { decisionId, verdict, summary, ...options }, session => {
      const step = activeDecision(session);
      if (step?.decision_ref !== decisionId) throw new InputError('Select the pending decision');
      if (options?.confidence !== undefined && (options.confidence < 0 || options.confidence > 100 || !Number.isFinite(options.confidence))) {
        throw new InputError('Confidence score must be between 0 and 100');
      }
      if (session.policy?.auto_mode && verdict === 'proceed' && options?.confidence !== undefined && options.confidence < 60 && !change.evidence?.length) {
        throw new InputError('Confidence below 60 requires explicit evidence or escalation');
      }
      if (verdict === 'fix' && step.command && /^ew-odyssey-(security|defensive)$/.test(workflowName(step.command))) {
        throw new InputError('Route read-only audit findings to a separate remediation step');
      }
      step.decision = verdict;
      if (options?.confidence !== undefined) step.confidence = options.confidence;
      if (verdict === 'proceed' && isDecisionOnlyStep(step)) {
        step.status = 'completed';
      } else if (verdict === 'escalate' && isDecisionOnlyStep(step)) {
        step.status = 'completed';
      } else if (verdict === 'fix') {
        const decisionIdx = session.steps.indexOf(step);
        if (options?.targetStepId) {
          const targetIdx = session.steps.findIndex(item => item.id === options.targetStepId);
          if (targetIdx < 0 || targetIdx > decisionIdx || isDecisionOnlyStep(session.steps[targetIdx])) {
            throw new InputError('Select a prior executable step to reopen for fixes: ' + options.targetStepId);
          }
          for (let i = targetIdx; i <= decisionIdx; i++) {
            session.steps[i].status = 'pending';
            delete session.steps[i].decision;
          }
        } else {
          if (isDecisionOnlyStep(step)) {
            throw new InputError('Specify --target-step <step-id> when returning fix from a decision-only step');
          }
          step.status = 'pending';
          delete step.decision;
        }
      }
      return { decision_ref: decisionId, verdict, summary, ...(options?.confidence !== undefined ? { confidence: options.confidence } : {}) };
    });
  }

  completeSession(id: string, change: Mutation) {
    return this.mutate(id, 'session.complete', change, {}, session => {
      if (!session.steps.length || nextAction(session).action !== 'complete') throw new InputError('Resolve pending workflow steps and decisions');
      session.status = 'completed';
      session.completed_at = new Date().toISOString();
      if (session.openviking) session.openviking.publication = { state: 'pending' };
      const completion = evolveSessionReceipt({ ...session, revision: session.revision + 1 });
      const evolveSignals = sessionEvolveSignals(session);
      const closeoutCommand = `evolve kb harvest session ${session.id} --project <project-id>`;
      const reviewCommand = `evolve session review ${session.id}`;
      return {
        status: session.status,
        completed_at: session.completed_at,
        completion_id: completion.id,
        closeout_command: closeoutCommand,
        evolve_reminder: evolveSignals.length > 0,
        ...(evolveSignals.length > 0 ? { evolve_signals: evolveSignals, review_command: reviewCommand } : {}),
        recommended_actions: [
          closeoutCommand,
          ...(evolveSignals.length > 0 ? [reviewCommand] : []),
        ],
      };
    });
  }

  team(id: string, runId: string, action: 'assign' | 'report' | 'cancel', assignment: Assignment, change: Mutation) {
    return this.mutate(id, 'team.' + action, change, { runId, assignment }, session => {
      const run = findRun(session, runId);
      if (workflowName(run.skill.skill_id) !== 'ew-swarm' || run.status !== 'running') throw new InputError('Select a running Swarm Run');
      if (action !== 'report' && run.owner !== change.actor) throw new InputError('Use the Swarm coordinator identity');
      const taskId = workflowId(assignment.id, 'assignment ID');
      const roster = run.assignments ??= {};
      if (action === 'assign') {
        if (Object.hasOwn(roster, taskId)) throw new InputError('Assignment already exists: ' + taskId);
        workflowPath(assignment.path, '.json');
        if (!assignment.path.startsWith('outputs/') && !assignment.path.startsWith('work/team/scores/')) {
          throw new InputError('Assignment output belongs under outputs/ or work/team/scores/');
        }
        if (Object.values(roster).some(item => item.path === assignment.path && !item.cancellation)) throw new InputError('Another assignment owns this output');
        roster[taskId] = assignment;
      } else {
        const task = roster[taskId];
        if (!Object.hasOwn(roster, taskId) || task.result || task.cancellation) throw new InputError('Select an outstanding assignment');
        if (action === 'cancel') {
          task.cancellation = requireText(change.reason, 'assignment cancellation reason');
        } else {
          if (task.role !== change.actor) throw new InputError('Use the assigned worker identity');
          const bytes = safeFile(this.runDir(id, runId), task.path);
          if (!bytes) throw new InputError('Assignment artifact is required: ' + task.path);
          JSON.parse(bytes.toString('utf8'));
          task.result = { summary: requireText(assignment.result?.summary, 'assignment summary'), sha256: workflowHash(bytes) };
        }
      }
      return { run_id: run.id, assignment: roster[taskId] };
    });
  }

  teamList(id: string, runId: string) {
    return Object.values(findRun(this.status(id), runId).assignments ?? {});
  }

  swarmController(id: string, runId: string) {
    const run = this.brief(id, runId);
    if (workflowName(run.skill_ref.skill_id) !== 'ew-swarm' || run.status !== 'running') throw new InputError('Select a running Swarm Run');
    const work = join(run.run_dir, 'work');
    const target = join(work, 'controller');
    mkdirSync(target, { recursive: true });
    for (const source of ['scripts/aco.py', 'scripts/pheromone.py', 'scripts/scoring.py', 'specs/swarm-config-template.json']) {
      const bytes = workflowBlob(this.root, run.skill_ref.commit, run.skill_ref.package_path + '/' + source);
      const name = source.split('/').at(-1)!;
      const existing = safeFile(run.run_dir, 'work/controller/' + name);
      if (existing && !existing.equals(bytes)) throw new InputError('Controller file changed: ' + name);
      if (!existing) writeFileSync(join(target, name), bytes, { flag: 'wx' });
    }
    return { controller_dir: target, script: join(target, 'aco.py'), config_template: join(target, 'swarm-config-template.json') };
  }

  recordKnowledge(id: string, runId: string, update: (trace: KnowledgeReads, pin: (prior: Omit<WikiPrior, 'content_sha256'>) => void) => void,
    remoteReads?: OpenVikingReadEvidence[]) {
    return transaction(this.db, () => {
      const session = this.status(id);
      const run = findRun(session, runId);
      if (run.status !== 'running') throw new InputError('Select a running Run for knowledge reads');
      if (safeFile(this.runDir(id, runId), 'knowledge-reads.json')) throw new InputError('Select a single Run knowledge receipt source');
      const trace = new KnowledgeReads(run.knowledge_reads);
      update(trace, prior => {
        const hash = contentSha256(prior.content);
        const snapshots = (run.wiki_priors ??= []);
        const existing = snapshots.find(item => item.id === prior.id);
        if (existing && (existing.content_sha256 !== hash || JSON.stringify([existing.mode, existing.scope, existing.categories, existing.repositories]) !==
          JSON.stringify([prior.mode, prior.scope, prior.categories, prior.repositories]))) {
          throw new InputError('Wiki evidence changed during this Run: ' + prior.id);
        }
        if (!snapshots.some(item => item.id === prior.id && JSON.stringify(item.lookup_scope) === JSON.stringify(prior.lookup_scope))) {
          snapshots.push({ ...prior, content_sha256: hash });
        }
      });
      if (run.wiki_priors && Buffer.byteLength(JSON.stringify(run.wiki_priors)) > maxArtifactBytes) {
        throw new InputError('Wiki snapshot exceeds the Run artifact size limit');
      }
      run.knowledge_reads = trace.toJSON();
      if (remoteReads?.length) {
        if (!session.openviking || remoteReads.some(item => item.release_id !== session.openviking!.release_id)) throw new InputError('OPENVIKING_READ_BINDING_MISMATCH');
        validateRemoteReads(remoteReads, session.openviking.release_id, trace.toJSON(), this.root);
        (run.openviking_reads ??= []).push(...remoteReads);
      }
      const { continuation: _continuation, orchestration_revision: _revision, ...saved } = session;
      this.save(saved);
      return run.knowledge_reads;
    });
  }
}
