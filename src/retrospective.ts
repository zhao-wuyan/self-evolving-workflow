import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSessionSignalPrompt } from './agent-memory-prompts.js';
import { parseReceipt, readSessionTransitions, readSkillExecution } from './closeout.js';
import { InputError, LEGACY_AGENT_MEMORY_DIR, requireText, resolveEvolveStorage } from './common.js';
import { defaultMemoryDbPath, extractMemoryInputs, MemoryStore, validateConversationMessages, type ConversationMessage } from './memory.js';
import type { LlmClient } from './upstream/llm.js';
import { readCompletionTranscriptRefs, readTranscriptSnapshots } from './transcript-evidence.js';
import type { Wiki } from './wiki.js';
import { formatKnowledgeReadsMessage, validateKnowledgeReads, type KnowledgeReadsReceipt } from './knowledge-reads.js';
import { readEvolveSessions } from './workflow-runtime.js';

export interface SkillSignal {
  id: string;
  kind: 'correction' | 'error' | 'retry' | 'aborted' | 'verified_fix' | 'workflow_issue' | 'unclassified';
  summary: string;
  sources: string[];
  runIds: string[];
}

export interface ReviewedRun {
  id: string;
  command: string;
  skillRef?: ReviewedSkillReference;
  skillReads?: { source: string; files: Array<{ path: string; sha256: string }> };
  knowledgeReads?: { source: string; receipt: KnowledgeReadsReceipt };
  retryOf?: string;
  source: string;
}

interface ReviewedSkillReference {
  skill_id: string;
  commit: string;
  tree: string;
  package_path: string;
  entry: string;
}

function signalKind(value: string | undefined): SkillSignal['kind'] {
  switch (value) {
    case 'correction':
    case 'error':
    case 'retry':
    case 'aborted':
    case 'verified_fix':
    case 'workflow_issue':
      return value;
    default:
      return 'unclassified';
  }
}

async function extractSignals(
  messages: ConversationMessage[], session: string, model: () => LlmClient, evidenceRuns = new Map<string, string[]>(),
): Promise<SkillSignal[]> {
  if (!messages.length) return [];
  const extracted = await extractMemoryInputs(messages, {
    llm: model(), session, agentMemoryPrompt: buildSessionSignalPrompt(),
  });
  const signals: SkillSignal[] = extracted.flatMap(item => item.id && item.sourceMessageIds?.length
    ? [{
        id: item.id, kind: signalKind(item.type), summary: item.content, sources: item.sourceMessageIds,
        runIds: [...new Set(item.sourceMessageIds.flatMap(id => evidenceRuns.get(id) ?? []))].sort(),
      }]
    : []);
  return [...new Map(signals.map(signal => [signal.id, signal])).values()];
}

export async function reviewSkillExecution(wiki: Wiki, project: string, execution: string, model: () => LlmClient) {
  project = requireText(project, 'source project ID');
  execution = requireText(execution, 'Skill execution ID');
  const completion = readSkillExecution(wiki, project, execution);
  validateConversationMessages(completion.messages);
  const messages = completion.messages.map(message => ({ ...message, id: `receipt:${project}:${completion.id}#${message.id}` }));
  if (completion.knowledgeReads) {
    messages.push({
      id: `receipt:${project}:${completion.id}#knowledge-reads`, role: 'tool',
      timestamp: completion.timestamp, content: formatKnowledgeReadsMessage(completion.knowledgeReads),
    });
  }
  return {
    execution, receipt: completion.id, skill: completion.skill, evidence: messages.length,
    signals: await extractSignals(messages, completion.id, model),
  };
}

function readSkillReference(value: unknown): ReviewedSkillReference | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new InputError('Invalid Run Skill reference');
  const source = value as Record<string, unknown>;
  const commit = requireText(source.commit, 'Skill commit');
  const tree = requireText(source.tree, 'Skill tree');
  const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  if (!objectId.test(commit) || !objectId.test(tree)) throw new InputError('Invalid Skill Git object ID');
  return {
    skill_id: requireText(source.skill_id, 'Skill ID'), commit, tree,
    package_path: requireText(source.package_path, 'Skill package path'), entry: requireText(source.entry, 'Skill entry'),
  };
}

function readSkillFiles(value: unknown, run: ReviewedRun): NonNullable<ReviewedRun['skillReads']>['files'] {
  if (!value || typeof value !== 'object') throw new InputError(`Invalid Skill reads for Run ${run.id}`);
  const reads = value as Record<string, unknown>;
  const reference = readSkillReference(reads.reference);
  if (!run.skillRef || !reference || JSON.stringify(reference) !== JSON.stringify(run.skillRef) ||
      !Array.isArray(reads.reads) || !Array.isArray(reads.missing) || reads.missing.length !== 0) {
    throw new InputError(`Skill reads do not match the sealed Run ${run.id}`);
  }
  const files = new Map<string, string>();
  for (const entry of reads.reads) {
    if (!entry || typeof entry !== 'object') throw new InputError(`Invalid Skill read for Run ${run.id}`);
    const path = requireText(entry.path, 'Skill read path');
    const sha256 = requireText(entry.sha256, 'Skill read hash');
    if (path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') ||
        !/\.md$/i.test(path) || !/^sha256:[a-f0-9]{64}$/.test(sha256) ||
        (files.has(path) && files.get(path) !== sha256)) {
      throw new InputError(`Invalid Skill read for Run ${run.id}: ${path}`);
    }
    files.set(path, sha256);
  }
  if (!files.has(reference.entry)) throw new InputError(`Missing Skill entry read for Run ${run.id}`);
  return [...files].map(([path, sha256]) => ({ path, sha256 }));
}

function collectDeterministicNativeSignals(
  root: string,
  session: ReturnType<typeof readEvolveSessions>[number],
): SkillSignal[] {
  const signals: SkillSignal[] = [];
  const signalId = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
  for (const run of session.runs) {
    const src = `evolve:${session.id}#${run.id}`;
    if (run.retry_of_run_id) {
      signals.push({
        id: signalId(['retry', session.id, run.id]),
        kind: 'retry',
        summary: `Run ${run.id} (${run.task.command}) retried ${run.retry_of_run_id}${run.summary ? `: ${run.summary}` : ''}`,
        sources: [src],
        runIds: [run.retry_of_run_id, run.id].sort(),
      });
    }
    if (run.status === 'failed' || run.status === 'blocked' || run.status === 'cancelled') {
      signals.push({
        id: signalId([run.status, session.id, run.id]),
        kind: run.status === 'cancelled' ? 'aborted' : 'error',
        summary: `Run ${run.id} (${run.task.command}) ${run.status}${run.summary ? `: ${run.summary}` : ''}`,
        sources: [src],
        runIds: [run.id],
      });
    } else if (run.verdict === 'done_with_concerns') {
      signals.push({
        id: signalId(['concerns', session.id, run.id]),
        kind: 'workflow_issue',
        summary: `Run ${run.id} (${run.task.command}) finished done_with_concerns${run.summary ? `: ${run.summary}` : ''}`,
        sources: [src],
        runIds: [run.id],
      });
    }
    const retroPath = resolveEvolveStorage(
      root,
      ['runs', session.id, run.id, 'outputs', 'retrospective.json'],
      join(resolve(root), LEGACY_AGENT_MEMORY_DIR, 'workflow', 'runs', session.id, run.id, 'outputs', 'retrospective.json'),
    );
    if (existsSync(retroPath)) {
      try {
        const retro = JSON.parse(readFileSync(retroPath, 'utf8')) as {
          insights?: Array<{ id?: string; lens?: string; summary?: string; route?: string; evidence?: string[] }>;
        };
        for (const insight of retro.insights ?? []) {
          if (!insight.id || !insight.summary || insight.route === 'none' || insight.route === 'skipped') continue;
          signals.push({
            id: signalId(['retro', session.id, insight.id]),
            kind: 'workflow_issue',
            summary: `[retro:${insight.lens ?? 'lens'}:${insight.route ?? 'route'}] ${insight.summary}`,
            sources: Array.isArray(insight.evidence) && insight.evidence.length ? insight.evidence : [src],
            runIds: [run.id],
          });
        }
      } catch {
        // 忽略损坏的 retrospective 文件。
      }
    }
  }
  const memDb = defaultMemoryDbPath(root);
  if (existsSync(memDb)) {
    const store = new MemoryStore(memDb, { readOnly: true });
    try {
      const relevant = new Set(['correction', 'error', 'verified_fix', 'workflow_issue']);
      const list = store.list({ session: session.id, limit: 100 });
      for (const item of list.results) {
        if (!relevant.has(item.type)) continue;
        signals.push({
          id: signalId(['memory', session.id, item.id]),
          kind: signalKind(item.type),
          summary: item.content,
          sources: item.sourceMessageIds.length ? item.sourceMessageIds : [`memory:${item.id}`],
          runIds: [],
        });
      }
    } finally {
      store.close();
    }
  }
  return signals;
}

export async function reviewSession(
  root: string,
  session: string,
  options: { model?: () => LlmClient; transcript?: ConversationMessage[]; deterministicOnly?: boolean },
) {
  session = requireText(session, 'Session ID');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(session)) throw new InputError('Invalid Session ID');
  const [native] = readEvolveSessions(root, session);
  if (native) {
    const evidenceRuns = new Map<string, string[]>();
    const messages: ConversationMessage[] = [];
    const runs: ReviewedRun[] = native.runs.map(run => {
      const timestamp = run.finished_at ?? native.created_at;
      const source = `evolve:${session}#${run.id}`;
      const record = (id: string, content: string, related = [run.id]) => {
        messages.push({ id, timestamp, role: 'tool', content });
        evidenceRuns.set(id, related);
      };
      if (run.summary) record(source, `${run.task.command} ${run.status}. ${run.summary}`);
      if (run.retry_of_run_id) record(source + ':retry', `Run ${run.id} retries ${run.retry_of_run_id}.`, [run.id, run.retry_of_run_id]);
      const files = Object.entries(run.reads).map(([path, sha256]) => ({ path, sha256 }));
      const readSource = source + ':skill-reads';
      if (files.length) record(readSource, 'Opened Skill documents: ' + files.map(file => file.path).join(', '));
      const knowledgeSource = source + ':knowledge-reads';
      if (run.knowledge_reads) record(knowledgeSource, formatKnowledgeReadsMessage(run.knowledge_reads));
      const { skill_id, commit, tree, package_path, entry } = run.skill;
      return {
        id: run.id, command: run.task.command, source, retryOf: run.retry_of_run_id,
        skillRef: { skill_id, commit, tree, package_path, entry },
        ...(files.length ? { skillReads: { source: readSource, files } } : {}),
        ...(run.knowledge_reads ? { knowledgeReads: { source: knowledgeSource, receipt: run.knowledge_reads } } : {}),
      };
    });
    for (const message of options.transcript ?? []) {
      messages.push({ ...message, id: `conversation:${session}#${message.id}` });
    }
    validateConversationMessages(messages);
    const deterministic = collectDeterministicNativeSignals(root, native);
    let llmSignals: SkillSignal[] = [];
    if (!options.deterministicOnly && options.model) {
      try {
        llmSignals = await extractSignals(messages, session, options.model, evidenceRuns);
      } catch {
        // 未配置 LLM 或抽取失败时自动降级保留确定性信号，不阻断 Agent 侧审查。
        if (!deterministic.length) throw new InputError('Session review LLM extraction failed and no deterministic signals were found');
      }
    }
    const merged = [...new Map([...deterministic, ...llmSignals].map(signal => [signal.id, signal])).values()];
    return { session, evidence: messages.length, runs, signals: merged };
  }
  const directory = join(root, '.workflow', 'sessions', session);
  if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new InputError(`Session not found: ${session}`);
  }
  const evidence = new Map<string, ConversationMessage>();
  const evidenceRuns = new Map<string, string[]>();
  const runs = new Map<string, ReviewedRun>();
  const blocked = new Set<string>();
  const summarizedRuns = new Set<string>();
  let completedRefs: string[] | undefined;
  for (const { receipt, result, id } of readSessionTransitions(directory)) {
    if (receipt.target_type === 'orchestration' && receipt.target_id === session && result.status === 'completed') {
      if (result.evolve_transcript_refs !== undefined || Array.isArray(result.evolve_evidence)) {
        completedRefs = readCompletionTranscriptRefs(result.evolve_transcript_refs);
      }
      for (const message of parseReceipt(receipt).messages) {
        const run = /^run:(.+):summary$/.exec(message.id)?.[1];
        if (run && summarizedRuns.has(run)) continue;
        const source = `receipt:${id}#${message.id}`;
        evidence.set(source, { ...message, id: source });
        if (run) evidenceRuns.set(source, [run]);
      }
      continue;
    }
    if (typeof result.run_id !== 'string') continue;
    const run = result.run_id;
    if ((receipt.target_type === 'run' && receipt.target_id === run) ||
        (receipt.target_type === 'orchestration' && receipt.target_id === session)) {
      if (Array.isArray(receipt.evidence_refs)) {
        for (const ref of receipt.evidence_refs) {
          if (typeof ref !== 'string' || !ref.startsWith('transcript:')) continue;
          const linked = evidenceRuns.get(ref) ?? [];
          if (!linked.includes(run)) evidenceRuns.set(ref, [...linked, run]);
        }
      }
    }
    const source = `receipt:${id}#run:${run}`;
    const timestamp = requireText(receipt.recorded_at, 'Run transition time');
    const sealed = result.status === 'sealed' && (
      (receipt.target_type === 'orchestration' && receipt.target_id === session && result.operation === 'run-complete-and-seal') ||
      (receipt.target_type === 'run' && receipt.target_id === run && result.operation === 'run-recovery-seal')
    );
    const reviewedRun = runs.get(run);
    if (sealed && reviewedRun?.skillRef && result.skill_reads !== undefined) {
      const files = readSkillFiles(result.skill_reads, reviewedRun);
      const readSource = `receipt:${id}#skill-reads:${run}`;
      reviewedRun.skillReads = { source: readSource, files };
      evidence.set(readSource, {
        id: readSource, role: 'tool', timestamp,
        content: `Run ${run} opened Skill documents: ${files.map(file => file.path).join(', ')}.`,
      });
      evidenceRuns.set(readSource, [run]);
    }
    if (sealed && reviewedRun && result.knowledge_reads !== undefined) {
      const receipt = validateKnowledgeReads(result.knowledge_reads);
      const knowledgeSource = `receipt:${id}#knowledge-reads:${run}`;
      reviewedRun.knowledgeReads = { source: knowledgeSource, receipt };
      evidence.set(knowledgeSource, {
        id: knowledgeSource, role: 'tool', timestamp, content: formatKnowledgeReadsMessage(receipt),
      });
      evidenceRuns.set(knowledgeSource, [run]);
    }
    const record = (content: string, runIds = [run]) => {
      evidence.set(source, { id: source, content, timestamp, role: 'tool' });
      evidenceRuns.set(source, runIds);
    };
    if (receipt.target_type === 'orchestration' && receipt.target_id === session &&
        result.run_already_created === true && result.task && typeof result.task === 'object') {
      const command = requireText((result.task as Record<string, unknown>).command, 'Run command');
      const retryOf = result.retry_of_run_id === undefined ? undefined : requireText(result.retry_of_run_id, 'prior Run ID');
      const skillRef = readSkillReference(result.skill_ref);
      runs.set(run, { id: run, command, skillRef, retryOf, source });
      if (retryOf) record(`Run ${run} (${command}) retries ${retryOf}.`, [run, retryOf]);
    } else if (receipt.target_type === 'run' && receipt.target_id === run) {
      const status = result.status;
      const recovered = status === 'running' && blocked.delete(run);
      if (status === 'blocked') blocked.add(run);
      if (status === 'blocked' || status === 'failed' || status === 'cancelled' || recovered) {
        record(`Run ${run} ${recovered ? 'resumed after a block' : `became ${status}`}. Reason: ${requireText(receipt.reason, 'Run transition reason')}`);
      }
    } else if (receipt.target_type === 'orchestration' && receipt.target_id === session &&
               result.operation === 'run-complete-and-seal' && result.status === 'sealed' && typeof result.summary === 'string') {
      record(`Run ${run} completed. Summary: ${requireText(result.summary, 'Run summary')}`);
      summarizedRuns.add(run);
    }
  }
  for (const message of readTranscriptSnapshots(directory, completedRefs)) evidence.set(message.id, message);
  for (const message of options.transcript ?? []) {
    const id = `conversation:${session}#${requireText(message.id, 'message ID')}`;
    if (evidence.has(id)) throw new InputError(`Duplicate conversation message: ${message.id}`);
    evidence.set(id, { ...message, id });
  }
  const messages = [...evidence.values()].sort((left, right) =>
    new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
  );
  if (!options.model) throw new InputError('Session review requires an extraction model for legacy sessions');
  return { session, evidence: messages.length, runs: [...runs.values()],
    signals: await extractSignals(messages, session, options.model, evidenceRuns) };
}
