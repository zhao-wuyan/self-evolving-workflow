import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { buildCloseoutHarvestPrompt, buildWikiRelationPrompt } from './agent-memory-prompts.js';
import { InputError, NotFoundError, openDb, requireText, transaction } from './common.js';
import { extractMemoryInputs, validateConversationMessages, type ConversationMessage } from './memory.js';
import { chatWithFormatRetry, extractJsonArray, type LlmClient } from './upstream/llm.js';
import { readWikiPages, type Wiki } from './wiki.js';
import { findHeuristicConflicts } from './knowledge-conflict.js';
import { parseFrontmatter, readSources } from './upstream/frontmatter.js';
import { unionSources } from './upstream/merge.js';
import { readCompletionTranscriptRefs, readTranscriptSnapshots } from './transcript-evidence.js';
import { applyWikiChange, closeoutDbPath, proposeWikiChange } from './wiki-change.js';
import { formatKnowledgeReadsMessage, validateKnowledgeReads, type KnowledgeReadsReceipt } from './knowledge-reads.js';

export interface Completion {
  id: string;
  session: string;
  timestamp: string;
  messages: ConversationMessage[];
  skill?: { id: string; version: string; status: SkillCompletionStatus };
  knowledgeReads?: KnowledgeReadsReceipt;
}

type SkillCompletionStatus = 'succeeded' | 'failed' | 'cancelled';
const terminalStatuses = new Set<unknown>(['succeeded', 'failed', 'cancelled']);
const maintenanceSkills = new Set(['ew-knowledge', 'workflow-closeout', 'workflow-evolve']);

export interface CandidateRouteState {
  route: 'wiki' | 'skill-addition' | 'skill-design' | 'deterministic-check';
  status: 'routed' | 'applied' | 'rolled_back';
  skill_id?: string;
  design_task_id?: string;
  design_receipt_id?: string;
  updated_at: string;
}

interface Candidate {
  id: string;
  content: string;
  sources: string[];
  matched_entry: string | null;
  candidate_kind?: 'constraint' | 'workflow_issue' | 'deterministic_check';
  related_entries?: Array<{ id: string; relation: 'same_content' | 'overlap' | 'conflict'; sources: string[] }>;
  route_state?: CandidateRouteState;
}

async function compareReferences(wiki: Wiki, content: string, model: () => LlmClient): Promise<Candidate['related_entries']> {
  if (!wiki.readableIndexPath() && !wiki.hasWiki()) return undefined;
  const activePages = wiki.hasWiki()
    ? readWikiPages(wiki.root).filter(page => page.entry?.status === 'active')
    : [];
  const heuristic = findHeuristicConflicts(
    { content },
    activePages.map(page => ({
      id: page.id,
      title: page.title,
      content: page.body,
      scope: page.entry?.scope,
      sources: page.sources,
    })),
    { maxResults: 5 },
  ).filter(item => item.relation !== 'same_content');

  const matches = wiki.search(content, { limit: 5, trackUsage: false }).results
    .map(hit => wiki.getEntry(hit.id))
    .filter((entry): entry is NonNullable<typeof entry> => entry?.entry?.status === 'active');

  const related: NonNullable<Candidate['related_entries']> = [];
  if (matches.length) {
    const promptSpec = buildWikiRelationPrompt();
    const parsed = await chatWithFormatRetry(
      model(),
      {
        system: promptSpec.system,
        prompt: JSON.stringify({ content, entries: matches.map(entry => ({
          id: entry.id, body: entry.body, scope: entry.entry?.scope,
        })) }),
        label: promptSpec.label,
      },
      raw => {
        const array = extractJsonArray(raw, ['relations', 'items', 'results', 'data']);
        if (!array) throw new InputError('Wiki comparison did not return a JSON array');
        return array;
      },
      'Return ONLY a JSON array of {"id":"supplied entry ID","relation":"conflict|overlap"} or [].',
    );
    const known = new Map(matches.map(entry => [entry.id, entry]));
    for (const value of parsed) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const { id, relation } = value as Record<string, unknown>;
      if (typeof id !== 'string' || (relation !== 'conflict' && relation !== 'overlap')) continue;
      const entry = known.get(id);
      if (entry && !related.some(item => item.id === id)) related.push({ id, relation, sources: entry.sources });
    }
  }

  for (const item of heuristic) {
    if (!related.some(existing => existing.id === item.id)) {
      related.push({
        id: item.id,
        relation: item.relation === 'conflict' ? 'conflict' : 'overlap',
        sources: item.sources ?? [],
      });
    }
  }
  return related.length ? related : undefined;
}

function appendReferenceSources(wiki: Wiki, closeout: string, candidate: Candidate): boolean {
  if (!candidate.matched_entry || candidate.related_entries?.length) return false;
  const entry = wiki.getEntry(candidate.matched_entry);
  if (!entry || entry.entry?.mode !== 'reference' || entry.entry.status !== 'active' ||
      !entry.entry.scope.includes('project') || entry.entry.scope.some(item => item.startsWith('skill:')) ||
      entry.body.trim() !== candidate.content.trim()) return false;

  const file = join(wiki.root, entry.path);
  if (!lstatSync(file).isFile()) throw new InputError(`Invalid Wiki entry file: ${entry.id}`);
  const original = readFileSync(file, 'utf8');
  const { frontmatter, body, hasFrontmatter } = parseFrontmatter(original);
  if (!hasFrontmatter || frontmatter.locked === true || frontmatter.mode !== 'reference' ||
      !Array.isArray(frontmatter.scope) || !frontmatter.scope.includes('project') ||
      frontmatter.status !== 'active' || body.trim() !== candidate.content.trim()) return false;
  const sources = readSources(original);
  const merged = unionSources(sources, candidate.sources);
  if (merged.every((source, index) => source === sources[index]) && merged.length === sources.length) return true;
  const proposal = proposeWikiChange(wiki, { operation: 'update', entry: entry.id }, [], {
    closeout, id: candidate.id, sources: candidate.sources, related: [],
  });
  applyWikiChange(wiki, proposal.id);
  return true;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Invalid completion record');
  return value as Record<string, unknown>;
}

function appendRunEvidence(completion: Completion, directory: string): void {
  const known = new Set(completion.messages.map(message => message.id));
  for (const { receipt, result } of readSessionTransitions(directory)) {
    if (typeof result.run_id !== 'string' ||
        (receipt.target_type === 'orchestration' && receipt.target_id !== completion.session) ||
        (receipt.target_type === 'run' && receipt.target_id !== result.run_id) ||
        (receipt.target_type !== 'orchestration' && receipt.target_type !== 'run')) continue;
    const run = result.run_id;
    const timestamp = requireText(receipt.recorded_at, 'Run transition time');
    const sealed = result.status === 'sealed' &&
      ((receipt.target_type === 'orchestration' && result.operation === 'run-complete-and-seal') ||
       (receipt.target_type === 'run' && result.operation === 'run-recovery-seal'));
    if (sealed && typeof result.summary === 'string') {
      const id = `run:${run}:summary`;
      if (!known.has(id)) {
        completion.messages.push({ id, role: 'tool', timestamp, content: `Run ${run} completed. Summary: ${requireText(result.summary, 'Run summary')}.` });
        known.add(id);
      }
    }
    if (sealed && result.knowledge_reads !== undefined) {
      const knowledgeReads = validateKnowledgeReads(result.knowledge_reads);
      const id = `run:${run}:knowledge-reads`;
      if (!known.has(id)) {
        completion.messages.push({ id, role: 'tool', timestamp, content: formatKnowledgeReadsMessage(knowledgeReads) });
        known.add(id);
      }
    }
  }
}

export function parseReceipt(value: unknown): Completion {
  const receipt = object(value);
  if (receipt.schema_version === 'evolve-session-completion/1.0') {
    if (!Array.isArray(receipt.messages)) throw new InputError('Invalid Evolve Session completion');
    return {
      id: requireText(receipt.id, 'completion ID'), session: requireText(receipt.session_id, 'Session ID'),
      timestamp: requireText(receipt.recorded_at, 'completion time'), messages: receipt.messages,
    };
  }
  if (receipt.schema_version === 'skill-completion/1.0') {
    if (!terminalStatuses.has(receipt.status) || !Array.isArray(receipt.messages)) {
      throw new InputError('Invalid Skill completion');
    }
    const skill = receipt.skill_id === undefined && receipt.skill_version === undefined ? {} : {
      skill: {
        id: requireText(receipt.skill_id, 'Skill ID'),
        version: requireText(receipt.skill_version, 'Skill version'),
        status: receipt.status as SkillCompletionStatus,
      },
    };
    return {
      id: requireText(receipt.id, 'completion ID'),
      session: requireText(receipt.execution_id, 'execution ID'),
      timestamp: requireText(receipt.recorded_at, 'completion time'),
      messages: receipt.messages,
      ...(receipt.knowledge_reads === undefined ? {} : { knowledgeReads: validateKnowledgeReads(receipt.knowledge_reads) }),
      ...skill,
    };
  }
  const result = object(receipt.result);
  if (receipt.schema_version !== 'transition-receipt/2.0' ||
      receipt.target_type !== 'orchestration' || result.status !== 'completed') {
    throw new InputError('Expected a Maestro Session completion receipt');
  }
  const id = requireText(receipt.transition_id, 'transition ID');
  const session = requireText(receipt.session_id, 'Session ID');
  if (receipt.target_id !== session) throw new InputError('Session completion target does not match');
  const timestamp = requireText(receipt.recorded_at, 'completion time');
  const messages: ConversationMessage[] = Array.isArray(result.evolve_evidence)
    ? result.evolve_evidence.map((value, index) => {
      const evidence = object(value);
      return {
        id: requireText(evidence.id, `evidence ID ${index}`),
        role: 'tool',
        timestamp,
        content: requireText(evidence.content, `evidence content ${index}`),
      };
    }) : [];
  return { id, session, timestamp, messages };
}

export function readSessionTransitions(directory: string) {
  const receipts = join(directory, 'receipts');
  const transitions = join(receipts, 'transitions');
  const requests = join(receipts, 'requests');
  for (const path of [receipts, transitions]) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) return [];
    if (!info.isDirectory()) throw new InputError(`Invalid Session receipt directory: ${path}`);
  }
  const session = basename(directory);
  return readdirSync(transitions, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).flatMap(entry => {
    const match = /^(\d{12})-(tr_[a-z0-9-]+)\.json$/i.exec(entry.name);
    if (!match) return [];
    if (!entry.isFile()) throw new InputError(`Invalid Session transition file: ${entry.name}`);
    const receipt = object(JSON.parse(readFileSync(join(transitions, entry.name), 'utf8')));
    const requestId = requireText(receipt.request_id, 'request ID');
    const participant = requireText(receipt.participant_id, 'participant ID');
    const before = receipt.revision_before;
    if (receipt.schema_version !== 'transition-receipt/2.0' || receipt.session_id !== session ||
        receipt.activity_revision !== Number(match[1]) || Number(match[1]) < 1 || receipt.transition_id !== match[2] ||
        typeof before !== 'number' || !Number.isSafeInteger(before) || before < 0 || receipt.revision_after !== before + 1 ||
        requestId !== receipt.request_id || /[\\/<>:"|?*\p{Cc}]/u.test(requestId) ||
        /[. ]$/.test(requestId) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(requestId)) {
      throw new InputError(`Session transition identity mismatch: ${entry.name}`);
    }
    const requestPath = join(requests, `${requestId}.json`);
    if (!lstatSync(requests, { throwIfNoEntry: false })?.isDirectory() ||
        !lstatSync(requestPath, { throwIfNoEntry: false })?.isFile()) {
      throw new InputError(`Session transition has no matching request receipt: ${entry.name}`);
    }
    const request = object(JSON.parse(readFileSync(requestPath, 'utf8')));
    if (request.schema_version !== 'request-receipt/2.0' || request.request_id !== requestId ||
        request.participant_id !== participant || request.transition_receipt_ref !== `receipts/transitions/${entry.name}` ||
        typeof request.payload_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(request.payload_hash)) {
      throw new InputError(`Invalid Session request receipt: ${requestId}`);
    }
    return [{ receipt, result: object(receipt.result), id: match[2] }];
  });
}

export function* readCompletionReceipts(sourceRoot: string, session?: string, transition?: string) {
  const sessions = join(sourceRoot, '.workflow', 'sessions');
  if (!lstatSync(sessions, { throwIfNoEntry: false })?.isDirectory()) {
    throw new InputError('Cannot locate the Maestro Sessions directory');
  }
  for (const entry of readdirSync(sessions, { withFileTypes: true })) {
    if (!entry.isDirectory() || (session !== undefined && entry.name !== session)) continue;
    const directory = join(sessions, entry.name);
    for (const { receipt, result } of readSessionTransitions(directory)) {
      if (receipt.target_type !== 'orchestration' || receipt.target_id !== entry.name ||
          result.status !== 'completed' || (transition !== undefined && receipt.transition_id !== transition)) continue;
      yield { directory, receipt };
    }
  }
}

function closeoutId(project: string, receipt: string): string {
  return createHash('sha256').update(JSON.stringify([project, receipt])).digest('hex');
}

function skillCompletionId(project: string, execution: string) {
  return `skill-${closeoutId(project, execution)}`;
}

function ledgerPath(wiki: Wiki): string {
  return closeoutDbPath(wiki.root);
}

function closeoutColumns(db: ReturnType<typeof openDb>): Set<string> {
  return new Set((db.prepare('PRAGMA table_info(closeouts)').all() as Array<{ name: string }>).map(column => column.name));
}

function ensureCloseoutsTable(db: ReturnType<typeof openDb>): void {
  db.exec(`CREATE TABLE IF NOT EXISTS closeouts (
    id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, candidates TEXT NOT NULL,
    session_id TEXT, receipt_id TEXT
  )`);
  const columns = closeoutColumns(db);
  if (!columns.has('session_id')) addCloseoutColumn(db, 'session_id');
  if (!columns.has('receipt_id')) addCloseoutColumn(db, 'receipt_id');
}

function addCloseoutColumn(db: ReturnType<typeof openDb>, column: 'session_id' | 'receipt_id'): void {
  try {
    db.exec(`ALTER TABLE closeouts ADD COLUMN ${column} TEXT`);
  } catch (error) {
    if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
  }
}

function ensureCandidateRoutesTable(db: ReturnType<typeof openDb>): void {
  db.exec(`CREATE TABLE IF NOT EXISTS candidate_routes (
    closeout_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    route TEXT NOT NULL,
    status TEXT NOT NULL,
    skill_id TEXT,
    design_task_id TEXT,
    design_receipt_id TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (closeout_id, candidate_id)
  )`);
}

export function recordCandidateRoute(wiki: Wiki, input: {
  closeoutId: string;
  candidateId: string;
  route: CandidateRouteState['route'];
  status: CandidateRouteState['status'];
  skillId?: string;
  designTaskId?: string;
  designReceiptId?: string;
}): CandidateRouteState {
  const path = ledgerPath(wiki);
  mkdirSync(dirname(path), { recursive: true });
  const db = openDb(path);
  try {
    ensureCandidateRoutesTable(db);
    const updatedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO candidate_routes (
        closeout_id, candidate_id, route, status, skill_id, design_task_id, design_receipt_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(closeout_id, candidate_id) DO UPDATE SET
        route = excluded.route,
        status = excluded.status,
        skill_id = COALESCE(excluded.skill_id, candidate_routes.skill_id),
        design_task_id = COALESCE(excluded.design_task_id, candidate_routes.design_task_id),
        design_receipt_id = COALESCE(excluded.design_receipt_id, candidate_routes.design_receipt_id),
        updated_at = excluded.updated_at
    `).run(
      input.closeoutId,
      input.candidateId,
      input.route,
      input.status,
      input.skillId ?? null,
      input.designTaskId ?? null,
      input.designReceiptId ?? null,
      updatedAt,
    );
    return {
      route: input.route,
      status: input.status,
      ...(input.skillId ? { skill_id: input.skillId } : {}),
      ...(input.designTaskId ? { design_task_id: input.designTaskId } : {}),
      ...(input.designReceiptId ? { design_receipt_id: input.designReceiptId } : {}),
      updated_at: updatedAt,
    };
  } finally {
    db.close();
  }
}

export function readHarvest(wiki: Wiki, project: string, receipt: string) {
  const id = closeoutId(requireText(project, 'source project ID'), requireText(receipt, 'completion receipt ID'));
  const path = ledgerPath(wiki);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) throw new NotFoundError('Completion has not been harvested');
  const db = openDb(path, true);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'closeouts' AND type = 'table'").get()) {
      throw new NotFoundError('Completion has not been harvested');
    }
    const columns = closeoutColumns(db);
    const metadata = columns.has('session_id') && columns.has('receipt_id') ? ', session_id, receipt_id' : '';
    const row = db.prepare(`SELECT candidates${metadata} FROM closeouts WHERE id = ?`).get(id) as {
      candidates: string;
      session_id?: string | null;
      receipt_id?: string | null;
    } | undefined;
    if (!row) throw new NotFoundError('Completion has not been harvested');
    const candidates = JSON.parse(String(row.candidates)) as Candidate[];
    const hasRoutes = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'candidate_routes' AND type = 'table'").get());
    if (hasRoutes) {
      const routes = db.prepare('SELECT candidate_id, route, status, skill_id, design_task_id, design_receipt_id, updated_at FROM candidate_routes WHERE closeout_id = ?')
        .all(id) as Array<{
          candidate_id: string; route: CandidateRouteState['route']; status: CandidateRouteState['status'];
          skill_id: string | null; design_task_id: string | null; design_receipt_id: string | null; updated_at: string;
        }>;
      const routeMap = new Map(routes.map(item => [item.candidate_id, item]));
      for (const candidate of candidates) {
        const state = routeMap.get(candidate.id);
        if (state) {
          candidate.route_state = {
            route: state.route,
            status: state.status,
            ...(state.skill_id ? { skill_id: state.skill_id } : {}),
            ...(state.design_task_id ? { design_task_id: state.design_task_id } : {}),
            ...(state.design_receipt_id ? { design_receipt_id: state.design_receipt_id } : {}),
            updated_at: state.updated_at,
          };
        }
      }
    }
    return {
      id,
      candidates,
      ...(row.session_id ? { session_id: row.session_id } : {}),
      ...(row.receipt_id ? { receipt_id: row.receipt_id } : {}),
    };
  } finally {
    db.close();
  }
}

export function recordSkillCompletion(wiki: Wiki, project: string, input: {
  execution: string;
  skill: string;
  version: string;
  status: string;
  messages: ConversationMessage[];
  session?: string;
  knowledgeReads?: KnowledgeReadsReceipt;
}) {
  project = requireText(project, 'source project ID');
  const execution = requireText(input.execution, 'Skill execution ID');
  const skill = requireText(input.skill, 'Skill ID');
  const version = requireText(input.version, 'Skill version');
  if (!terminalStatuses.has(input.status)) throw new InputError('Expected succeeded, failed, or cancelled Skill status');
  if (maintenanceSkills.has(skill)) return { ignored: 'maintenance-skill' as const };
  if (input.session !== undefined) return { ignored: 'session-owned' as const, session: requireText(input.session, 'Session ID') };
  validateConversationMessages(input.messages);
  const messages = input.messages.map(({ id, role, timestamp, content }) => ({ id, role, timestamp, content }));
  const id = skillCompletionId(project, execution);
  const payload = {
    schema_version: 'skill-completion/1.0', id, execution_id: execution, skill_id: skill,
    skill_version: version, status: input.status, messages,
    ...(input.knowledgeReads ? { knowledge_reads: validateKnowledgeReads(input.knowledgeReads) } : {}),
  };
  const normalized = JSON.stringify(payload);
  const path = ledgerPath(wiki);
  mkdirSync(dirname(path), { recursive: true });
  const db = openDb(path);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS skill_completions (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, payload TEXT NOT NULL, recorded_at TEXT NOT NULL
    )`);
    return transaction(db, () => {
      const row = db.prepare('SELECT payload, recorded_at FROM skill_completions WHERE id = ?').get(id);
      if (row && row.payload !== normalized) throw new InputError(`Skill completion changed: ${execution}`);
      const recorded_at = row ? String(row.recorded_at) : new Date().toISOString();
      if (!row) db.prepare('INSERT INTO skill_completions VALUES (?, ?, ?, ?)').run(id, project, normalized, recorded_at);
      return { receipt: { ...payload, recorded_at } };
    });
  } finally {
    db.close();
  }
}

export function readSkillCompletions(wiki: Wiki, project: string, id?: string) {
  const path = ledgerPath(wiki);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return [];
  const db = openDb(path, true);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'skill_completions' AND type = 'table'").get()) return [];
    const columns = 'SELECT id, payload, recorded_at FROM skill_completions WHERE project = ?';
    const receipts = id === undefined
      ? db.prepare(columns + ' ORDER BY recorded_at, id').all(project)
      : db.prepare(columns + ' AND id = ?').all(project, id);
    return receipts.map(row => ({ id: String(row.id), receipt: {
        ...object(JSON.parse(String(row.payload))), recorded_at: row.recorded_at,
      } }));
  } finally {
    db.close();
  }
}

export function readSkillExecution(wiki: Wiki, project: string, execution: string) {
  const id = skillCompletionId(project, execution);
  const saved = readSkillCompletions(wiki, project, id)[0];
  if (!saved) throw new NotFoundError('Standalone Skill completion receipt not found');
  const completion = parseReceipt(saved.receipt);
  if (completion.id !== id || completion.session !== execution || !completion.skill) {
    throw new InputError('Standalone Skill receipt does not match the recorded execution');
  }
  return { ...completion, skill: completion.skill };
}

export async function harvestConversation(
  wiki: Wiki,
  project: string,
  conversation: { host: string; session: string; messages: ConversationMessage[] },
  model: () => LlmClient,
) {
  if (!conversation.messages.length) throw new InputError('Conversation has no extractable messages');
  validateConversationMessages(conversation.messages);
  const hash = createHash('sha256').update(JSON.stringify(conversation.messages)).digest('hex').slice(0, 12);
  const rawTimestamp = conversation.messages.at(-1)!.timestamp;
  const parsedTime = new Date(rawTimestamp);
  const timestamp = Number.isFinite(parsedTime.getTime()) ? parsedTime.toISOString() : new Date().toISOString();
  const completion: Completion = {
    id: `conv-${conversation.host}-${conversation.session}-${hash}`,
    session: conversation.session,
    timestamp,
    messages: conversation.messages,
  };
  return harvestResolvedCompletion(wiki, project, completion, model);
}

export async function harvestCompletion(wiki: Wiki, project: string, value: unknown, model: () => LlmClient,
  sessionDirectory?: string) {
  const completion = parseReceipt(value);
  const receipt = object(value);
  if (receipt.schema_version === 'transition-receipt/2.0') {
    const refs = object(receipt.result).evolve_transcript_refs;
    if (refs !== undefined) {
      if (!sessionDirectory) throw new InputError('Use closeout session to resolve anchored transcript evidence from the Maestro project');
      completion.messages.push(...readTranscriptSnapshots(sessionDirectory, readCompletionTranscriptRefs(refs)));
    }
    if (sessionDirectory) appendRunEvidence(completion, sessionDirectory);
  }
  return harvestResolvedCompletion(wiki, project, completion, model);
}

async function harvestResolvedCompletion(wiki: Wiki, project: string, completion: Completion, model: () => LlmClient) {
  project = requireText(project, 'source project ID');
  if (completion.skill && maintenanceSkills.has(completion.skill.id)) {
    throw new InputError('Maintenance Skill completions are excluded from harvesting');
  }
  if (!Number.isFinite(Date.parse(completion.timestamp))) throw new InputError('Invalid completion time');
  const identity = closeoutId(project, completion.id);
  const payloadHash = createHash('sha256').update(JSON.stringify(completion)).digest('hex');
  const ledger = ledgerPath(wiki);
  mkdirSync(dirname(ledger), { recursive: true });
  const db = openDb(ledger);
  try {
    ensureCloseoutsTable(db);
    const lookup = db.prepare('SELECT payload_hash, candidates FROM closeouts WHERE id = ?');
    const metadata = { session_id: completion.session, receipt_id: completion.id };
    const previous = () => {
      const row = lookup.get(identity);
      if (!row) return undefined;
      if (row.payload_hash !== payloadHash) throw new InputError(`Completion receipt changed: ${completion.id}`);
      return JSON.parse(String(row.candidates)) as Candidate[];
    };
    const saved = previous();
    if (saved) return { id: identity, replayed: true, candidates: saved, ...metadata };
    const extracted = completion.messages.length ? await extractMemoryInputs(completion.messages, {
      llm: model(), session: completion.session, agentMemoryPrompt: buildCloseoutHarvestPrompt(),
    }) : [];
    const proposals: Array<Pick<Candidate, 'id' | 'content' | 'sources' | 'candidate_kind'> & {
      related: Candidate['related_entries'];
    }> = [];
    const grouped = new Map<string, Omit<(typeof proposals)[number], 'related'>>();
    for (const item of extracted) {
      if (!item.sourceMessageIds?.length) continue;
      const kind = item.type === 'constraint' || item.type === 'workflow_issue' || item.type === 'deterministic_check' ? item.type : undefined;
      const key = JSON.stringify([kind ?? 'reference', item.content.trim()]);
      const sources = item.sourceMessageIds.map(source => `receipt:${project}:${completion.id}#${source}`);
      const existing = grouped.get(key);
      if (existing) existing.sources = [...new Set([...existing.sources, ...sources])];
      else grouped.set(key, {
        id: createHash('sha256').update(JSON.stringify([identity, item.id])).digest('hex'),
        content: item.content,
        ...(kind ? { candidate_kind: kind } : {}),
        sources: [...new Set(sources)],
      });
    }
    for (const proposal of grouped.values()) proposals.push({
      ...proposal,
      related: wiki.getEntriesByExactBody(proposal.content).length === 0 ? await compareReferences(wiki, proposal.content, model) : undefined,
    });    const replay = previous();
    if (replay) return { id: identity, replayed: true, candidates: replay, ...metadata };
    const candidates: Candidate[] = proposals.map(({ related, ...proposal }) => {
      const exact = wiki.getEntriesByExactBody(proposal.content);
      return {
        ...proposal,
        matched_entry: exact.length === 1 ? exact[0].id : null,
        ...(exact.length > 1 || related ? {
          related_entries: [
            ...(exact.length > 1 ? exact.map(({ id, sources }) => ({ id, sources, relation: 'same_content' as const })) : []),
            ...(related ?? []).filter(entry => !exact.some(hit => hit.id === entry.id)),
          ],
        } : {}),
      };
    });
    const pending = candidates.filter(candidate => candidate.candidate_kind !== undefined || !appendReferenceSources(wiki, identity, candidate));
    if (pending.length !== candidates.length && !wiki.readableIndexPath()) wiki.build();
    const result = transaction(db, () => {
      const savedReplay = previous();
      if (savedReplay) return { id: identity, replayed: true, candidates: savedReplay, ...metadata };
      db.prepare('INSERT INTO closeouts (id, payload_hash, candidates, session_id, receipt_id) VALUES (?, ?, ?, ?, ?)')
        .run(identity, payloadHash, JSON.stringify(pending), metadata.session_id, metadata.receipt_id);
      return { id: identity, replayed: false, candidates: pending, ...metadata };
    });
    return result;
  } finally {
    db.close();
  }
}

export function readCloseoutCandidate(wiki: Wiki, closeoutId: string, candidateId: string): Candidate {
  if (!/^[a-f0-9]{64}$/.test(closeoutId) || !/^[a-f0-9]{64}$/.test(candidateId)) {
    throw new InputError('Expected exact closeout and candidate IDs');
  }
  const ledger = ledgerPath(wiki);
  const db = openDb(ledger, true);
  let candidate: Candidate | undefined;
  try {
    const row = db.prepare('SELECT candidates FROM closeouts WHERE id = ?').get(closeoutId);
    if (row) candidate = (JSON.parse(String(row.candidates)) as Candidate[]).find(item => item.id === candidateId);
  } finally {
    db.close();
  }
  if (!candidate) throw new InputError('Candidate does not belong to the selected closeout');
  return candidate;
}

export function publishReference(wiki: Wiki, closeoutId: string, candidateId: string, title: string, entry?: string) {
  title = requireText(title, 'reference title');
  const candidate = readCloseoutCandidate(wiki, closeoutId, candidateId);
  if (candidate.candidate_kind) throw new InputError('Classified constraint or process candidate requires explicit review and routing before publication');
  const id = entry === undefined ? `entries/${candidateId}` : requireText(entry, 'Wiki entry ID');
  if (candidate.matched_entry || candidate.related_entries?.length) {
    throw new InputError('Candidate has related Wiki entries; review the relationship and stage a Wiki change');
  }
  const proposal = proposeWikiChange(wiki, {
    operation: 'create', entry: id, title, mode: 'reference', body: candidate.content,
  }, [], { closeout: closeoutId, id: candidate.id, sources: candidate.sources, related: [] });
  const applied = applyWikiChange(wiki, proposal.id);
  return { id, replayed: applied.replayed };
}
