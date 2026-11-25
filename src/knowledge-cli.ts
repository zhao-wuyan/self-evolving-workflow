import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CodeGraph } from './code.js';

import {
  configureMemory, inspectMemoryHooks, installCodexMemoryHook, memoryModelSettings,
  parseMemoryHosts,
} from './memory-config.js';
import {
  handleMemoryHook, handleSessionStartHook, listAgentHistory, memoryHookTarget,
  readHostConversationMessages, readMemoryConversation, searchAgentHistory, showAgentHistory,
  syncMemoryHost, type HistoryEntryRole,
} from './memory-history.js';
import {
  collectHistorySignals, queryCollectedSignals, readHistoryCursorMap, type SignalSourceKind,
} from './history-signals.js';
import { acknowledgeReminders, findUnharvestedSessions, readReminders } from './memory-reminders.js';
import {
  drainMemoryHookJobs, enqueueMemoryHook, hasPendingMemoryHookJobs, readMemoryHookInput,
  readMemoryHookJobs, retryMemoryHookJobs, startMemoryHookWorker,
} from './memory-hook-jobs.js';
import { InputError, NotFoundError, evolveDir, evolvePath, requireText } from './common.js';
import { defaultMemoryDbPath, MemoryStore, type ConversationMessage } from './memory.js';
import { unifiedSearch } from './search.js';
import { KnowledgeStore, type KnowledgeFilters, type KnowledgeInput, type KnowledgeLayer, type KnowledgeMutationOptions } from './kb.js';
import { initWiki, Wiki } from './wiki.js';
import {
  harvestCompletion, harvestConversation, publishReference, readCloseoutCandidate, readCompletionReceipts,
  readHarvest, readSkillCompletions, recordCandidateRoute, recordSkillCompletion,
} from './closeout.js';
import { reviewSession, reviewSkillExecution } from './retrospective.js';
import { draftSkillAddition, draftSkillRetirement } from './skill-addition.js';
import { changeSkillVersion, replaySkillAddition } from './skill-replay.js';
import { migrateLegacyWiki } from './wiki-migration.js';
import { isRepositoryId, isWikiCategory } from './wiki-entry.js';
import { applyWikiChange, listWikiChanges, proposeWikiChange } from './wiki-change.js';
import { KnowledgeReads, validateKnowledgeReads, type KnowledgeQueryItem } from './knowledge-reads.js';
import {
  formatUnifiedContextJson,
  formatUnifiedMergedJson,
  projectCodeGraphItem,
  projectKnowledgeHit,
  renderCodeSearchCompact,
  renderHistoryListCompact,
  renderHistorySearchCompact,
  renderHistoryShowCompact,
  renderKbGetCompact,
  renderKbSearchCompact,
  renderUnifiedContextCompact,
  renderUnifiedMergedCompact,
  type OutputFormat,
  type RawCodeGraphItem,
} from './search-format.js';
import { decideSkillRoute } from './skill-route.js';
import { lintKnowledge, renderKbLintCompact } from './knowledge-lint.js';
import { learningBloat, readSkillLearnings, skillLearningUsage } from './skill-learnings.js';
import { evolveSessionReceipt, readEvolveSessions, workflowDbPath } from './workflow-runtime.js';
import { readNativeCloseoutJobs } from './workflow-runtime.js';
import { drainNativeCloseouts, hasPendingNativeCloseouts, nativeCloseoutStatus, processNativeCloseout } from './native-closeout.js';
import { migrateKnowledgeStorage } from './storage-migration.js';
import {
  applySkillDesign, createSkillDesignTask, readSkillDesignTask, replaySkillDesign,
  resolveSkillEntry, reviewSkillDesign, runSkillDesign,
} from './skill-design.js';
import { createModelClient } from './model-client.js';
import { openKnowledgeSources, type KnowledgeSources } from './knowledge-sources.js';
import { appendRemoteReads } from './openviking/evidence.js';
import { readProject } from './openviking/config.js';
import { FrozenMemoryReader } from './openviking/frozen.js';
import { createOpenVikingSyncTracker, withOpenVikingSync, type OpenVikingSyncTracker } from './openviking/publication-hint.js';
import { parseRemoteMemoryId } from './openviking/memory.js';

export function knowledgeHelp(invocation: 'evolve' = 'evolve') {
  return `Usage: ${invocation} <command> [options]

  search <query>                           Aggregate knowledge and code (--from kb,code|all)
                                           --mode merged|context --scope project|global|local
  kb add <text>                            Add a record (--kind episodic|reference|constraint)
  kb get <id>...                           Read complete record(s) and provenance (--pick <n,...>)
  kb list                                  List records with filters and stable pagination
  kb search <query>                        Search knowledge records only
  kb update <id> [text]                     Update a record without replacing omitted fields
  kb delete <id>                           Delete episodic data or propose retiring formal knowledge
  kb init|build|ingest <file>               Initialize, index or ingest knowledge documents
  kb lint                                  Audit knowledge freshness, conflicts and anchors
  kb import [source]                       Preview legacy knowledge migration (--project, --apply)
  kb propose <change.json>                  Stage a governed knowledge change (--evidence)
  kb changes [change-id]                    Inspect staged changes and application receipts
  kb apply <change-id>                      Apply an approved change
  kb config                                Configure extraction and host hooks (--scope project|global)
  kb sync                                  Extract saved host conversations (--host codex|claude|agy|all)
  kb extract <messages.json>               Extract episodic records (--session, --mode chat|code)
  kb reminders [ack [id]]                   List or acknowledge knowledge/evolution reminders
  kb hook-jobs [retry [id]]                 Inspect background extraction jobs or retry failures
  kb hook-worker                          Drain queued hook events without host stdin
  kb closeouts                            Inspect durable Session closeout jobs
  kb doctor                               Inspect hooks, model configuration and knowledge backlog (--llm probes the model)
  kb storage                              Preview legacy database migration (--apply to migrate)
  kb feedback <id>                        Record actual use of a read entry (--reads, --outcome, --evidence)
  kb harvest pending                       Process pending and retry failed Session closeouts
  kb sources <id>                          Read original messages and transcript locations
  kb history <id>                          Read archived versions of an episodic record
  kb conversation <id>                     Read a conversation page (--host, --page, --limit)
  kb harvest session|conversation|skill|receipt|scan <id>
                                           Extract review candidates (--project)
  kb candidates show|route|publish <id>     Inspect, route or publish reviewed candidates
  code build|sync                          Build or update the project code graph
  code search <query>                      Find code symbols
  code graph <id> [to-id]                   Follow callers/callees or trace a path (--direction, --depth)
  history collect                          Incrementally collect signals from transcripts, memory, wiki, or LLM
  history list                             List Codex, Claude Code and Agy sessions in this project
  history search [<query>]                 Search collected signals and host transcripts (--signals-only, --role)
  history show <session-id>                Inspect full messages and tool calls around an --anchor
  session review <id>                      Review Session execution signals
  skill review|draft|replay|apply|rollback   Review and evolve a Skill from evidence
                                           draft --supersedes <learning-id> replaces an existing learning
  skill retire <entry> <learning-id>...     Draft removal of learnings (--evidence, --reason)
  skill learnings <entry>                   Report learning usage and consolidation pressure
  skill design task|run|review|replay|apply|rollback <id>
                                           Execute the governed Skill design chain

Options:
  --root <dir>          Project root (default current directory)
  --wiki-root <dir>     Override the project Wiki root (OpenViking pins the release Wiki)
  --scope <scope>       project: project only; global: user knowledge only; local: both (default)
  --kind <kind>         episodic, reference or constraint
  --status <status>     active, deprecated, needs_review or all
  --task <kind>         Filter applicability; maps to episodic scene
  --path <path>         Filter applicable file/dir paths (repeatable)
  --category <cat>      Filter formal knowledge categories (repeatable)
  --session <id>        Filter records; context mode binds the Run context identifier
  --memory-session <id> Filter episodic records independently in context mode
  --workflow-session <id> Pin OpenViking reads to an Evolve Session release
  --memory-backend <local|openviking> Select the Memory reader (writes remain local)
  --context-file <path> Load shared task, path and Wiki filters from JSON
  --limit <n>           Maximum results (default 10); context keeps all applicable constraints
  --page <n>            Page number for merged search, kb list/search or conversation
  --hop <n>             Knowledge graph expansion depth
  --title <text>        Formal knowledge title
  --content <text>      Record content (or supply positional text)
  --entry-scope <scope> Formal applicability: project, task:<kind> or path:<glob> (repeatable)
  --evidence <ref>      Evidence for formal knowledge writes (repeatable)
  --apply               Apply a formal change; otherwise writes return a proposal
  --db <path>           Override the project episodic database
  --namespace <name>    Episodic namespace (default default)
  --reads <path>        Persist a knowledge_reads receipt across calls
  --trace-file <path>   Compatibility alias for --reads
  --from-search <id>    Associate an exact read with a recorded search (or q-N query ID)
  --pick <n[,m...]>     Select item index(es) from the recorded search when using --reads
  --trace               Include knowledge_reads in the result
  --resolved            Read Wiki references using the active scope context
  --format <mode>       Output format: json (default) or compact (plain text)
  --verbose             Return full unslimmed debug fields and pretty JSON
  --help                Show this message

Writes default to project; --scope global selects user knowledge. Formal writes use governed proposals.
Context defaults to episodic + formal knowledge + code. --from kb excludes code.
Task/category/session filters apply to knowledge; --path also filters code file paths.
Set an OpenAI-compatible extraction endpoint with kb config or AGENT_MEMORY_LLM_BASE_URL,
AGENT_MEMORY_LLM_MODEL and, when required, AGENT_MEMORY_LLM_API_KEY.
Message files contain an array of {id, role, timestamp, content}. Commands return compact JSON by default (pass --verbose for full fields or --format compact for plain text).
`;
}

export const knowledgeOptions = {
  root: { type: 'string' },
  'wiki-root': { type: 'string' },
  db: { type: 'string' },
  namespace: { type: 'string' },
  scope: { type: 'string' },
  from: { type: 'string' },
  kind: { type: 'string' },
  title: { type: 'string' },
  content: { type: 'string' },
  'entry-scope': { type: 'string', multiple: true },
  direction: { type: 'string' },
  global: { type: 'boolean' },
  limit: { type: 'string' },
  page: { type: 'string' },
  depth: { type: 'string' },
  hop: { type: 'string' },
  type: { type: 'string' },
  scene: { type: 'string' },
  session: { type: 'string' },
  'memory-session': { type: 'string' },
  'workflow-session': { type: 'string' },
  'memory-backend': { type: 'string' },
  'context-file': { type: 'string' },
  id: { type: 'string' },
  priority: { type: 'string' },
  mode: { type: 'string' },
  host: { type: 'string' },
  'base-url': { type: 'string' },
  model: { type: 'string' },
  yes: { type: 'boolean' },
  skill: { type: 'string' }, // 收尾路由和执行回执的 Skill 标识。
  task: { type: 'string' },
  category: { type: 'string', multiple: true },
  keyword: { type: 'string' },
  repository: { type: 'string' },
  'include-path-scoped': { type: 'boolean' },
  'include-memory': { type: 'boolean' },
  trace: { type: 'boolean' },
  'trace-file': { type: 'string' },
  reads: { type: 'string' },
  'from-search': { type: 'string' },
  resolved: { type: 'boolean' },
  path: { type: 'string', multiple: true },
  history: { type: 'boolean' },
  project: { type: 'string' },
  uid: { type: 'string' },
  'knowhow-only': { type: 'boolean' },
  apply: { type: 'boolean' },
  transcript: { type: 'string' },
  'knowledge-receipt': { type: 'string' },
  receipt: { type: 'string' },
  'skill-version': { type: 'string' },
  'repeat-count': { type: 'string' },
  'step-count': { type: 'string' },
  'signal-kind': { type: 'string', multiple: true },
  'cross-skill': { type: 'boolean' },
  'new-contract': { type: 'boolean' },
  'new-artifacts': { type: 'boolean' },
  'requires-routing': { type: 'boolean' },
  'skill-intent': { type: 'boolean' },
  status: { type: 'string' },
  'record-only': { type: 'boolean' },
  evidence: { type: 'string', multiple: true },
  entry: { type: 'string' },
  closeout: { type: 'string' },
  candidate: { type: 'string' },
  when: { type: 'string' },
  supersedes: { type: 'string', multiple: true },
  reason: { type: 'string' },
  runner: { type: 'string' },
  scenarios: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  format: { type: 'string' },
  verbose: { type: 'boolean' },
  pick: { type: 'string' },
  'root-b64': { type: 'string' },
  'timeout-ms': { type: 'string' },
  'no-global': { type: 'boolean' },
  background: { type: 'boolean' },
  purpose: { type: 'string' },
  schema: { type: 'string' },
  force: { type: 'boolean' },
  propose: { type: 'boolean' },
  since: { type: 'string' },
  'signals-only': { type: 'boolean' },
  regex: { type: 'boolean' },
  role: { type: 'string' },
  source: { type: 'string' },
  llm: { type: 'boolean' },
  'all-projects': { type: 'boolean' },
  anchor: { type: 'string' },
  context: { type: 'string' },
  'include-tools': { type: 'boolean' },
  'no-llm': { type: 'boolean' },
  outcome: { type: 'string' },
  'content-hash': { type: 'string' },
} as const;



interface CliWikiContext {
  skill?: string;
  task?: string;
  paths?: string[];
  categories?: string[];
  repository?: string;
  repositoryExplicit?: boolean;
  keyword?: string;
  includePathScoped?: boolean;
}

function readContextFile(path: string): CliWikiContext {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Context file must contain a JSON object');
  const input = value as Record<string, unknown>;
  const list = (field: 'paths' | 'categories'): string[] | undefined => {
    if (input[field] === undefined) return undefined;
    if (!Array.isArray(input[field]) || input[field].some(item => typeof item !== 'string' || !item.trim())) {
      throw new InputError(`Context file ${field} must be a list of non-empty strings`);
    }
    return [...new Set((input[field] as string[]).map(item => item.trim()))];
  };
  const text = (field: 'task' | 'repository' | 'keyword'): string | undefined => {
    if (input[field] === undefined) return undefined;
    if (typeof input[field] !== 'string' || !input[field].trim()) throw new InputError(`Context file ${field} must be a non-empty string`);
    return input[field].trim();
  };
  if (input.includePathScoped !== undefined && typeof input.includePathScoped !== 'boolean') {
    throw new InputError('Context file includePathScoped must be boolean');
  }
  return {
    task: text('task'), paths: list('paths'), categories: list('categories'),
    repository: text('repository'), keyword: text('keyword'),
    ...(input.includePathScoped === undefined ? {} : { includePathScoped: input.includePathScoped as boolean }),
  };
}

function detectRepositoryId(root: string): string | undefined {
  for (const candidate of [evolvePath(root, 'repository.json'), join(resolve(root), '.workflow', 'repository.json')]) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '')) as { repo_id?: unknown };
      if (isRepositoryId(parsed?.repo_id)) return parsed.repo_id;
    } catch {
      // 忽略无法解析的仓储元数据，保留显式参数控制。
    }
  }
  return undefined;
}

function cliWikiContext(values: Record<string, unknown>, root: string): CliWikiContext {
  const file = typeof values['context-file'] === 'string' ? readContextFile(values['context-file']) : {};
  const paths = Array.isArray(values.path) ? values.path as string[] : file.paths;
  const categories = Array.isArray(values.category) ? values.category as string[] : file.categories;
  const explicitRepository = typeof values.repository === 'string' ? values.repository : file.repository;
  const repository = explicitRepository ?? detectRepositoryId(root);
  return {
    task: typeof values.task === 'string' ? values.task : file.task,
    paths, categories,
    repository,
    repositoryExplicit: explicitRepository !== undefined,
    keyword: typeof values.keyword === 'string' ? values.keyword : file.keyword,
    includePathScoped: typeof values['include-path-scoped'] === 'boolean'
      ? values['include-path-scoped'] : file.includePathScoped,
  };
}

function decodeWorkspaceCandidate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (value.startsWith('file:')) {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

function resolveHookRoot(rawRoot: string, input: unknown): string | undefined {
  if (rawRoot !== 'auto') return resolve(rawRoot);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const event = input as Record<string, unknown>;
  const candidate = decodeWorkspaceCandidate(event.cwd)
    ?? (Array.isArray(event.workspacePaths) ? decodeWorkspaceCandidate(event.workspacePaths[0]) : undefined);
  return candidate && existsSync(candidate) ? resolve(candidate) : undefined;
}

function commandFlags(flags: Record<string, string | number | boolean | undefined>) {
  return Object.entries(flags).flatMap(([key, value]) => {
    if (value === undefined || value === false) return [];
    if (value === true) return [`--${key}`];
    if (String(value).startsWith('-')) return [`--${key}=${value}`];
    return [`--${key}`, String(value)];
  });
}

function hasOtherPage(pagination: { previousPage: number | null; nextPage: number | null }) {
  return pagination.previousPage !== null || pagination.nextPage !== null;
}

function numberOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InputError(label + ' must be a non-negative integer');
  return Number(value);
}

function buildQueryItemsForContext(
  result: Awaited<ReturnType<typeof unifiedSearch>> & { mode: 'context' },
  knowledgeReads: KnowledgeReads,
): { items: KnowledgeQueryItem[]; indices: Map<string, number> } {
  const items: KnowledgeQueryItem[] = [];
  const indices = new Map<string, number>();
  let idx = 0;
  for (const item of result.constraints) {
    idx++;
    indices.set(`${item.kind}:${item.id}`, idx);
    items.push({ idx, kind: 'wiki', id: item.rawId, scope: item.scope });
  }
  for (const item of result.references) {
    idx++;
    indices.set(`${item.kind}:${item.id}`, idx);
    items.push({
      idx, kind: 'wiki', id: item.rawId, scope: item.scope,
      from_search_id: knowledgeReads.findSearchId('wiki', item.rawId, item.scope),
    });
  }
  for (const item of result.episodic) {
    idx++;
    indices.set(`${item.kind}:${item.id}`, idx);
    items.push({
      idx, kind: 'memory', id: item.rawId, scope: item.scope,
      from_search_id: knowledgeReads.findSearchId('memory', item.rawId, item.scope),
    });
  }
  for (const item of result.code) {
    idx++;
    indices.set(`code:${item.id}`, idx);
    items.push({
      idx, kind: 'code', id: item.id, scope: 'project',
      from_search_id: knowledgeReads.findSearchId('code', item.id, 'project'),
    });
  }
  return { items, indices };
}

function buildQueryItemsForMerged(
  result: Awaited<ReturnType<typeof unifiedSearch>> & { mode: 'merged' },
  knowledgeReads: KnowledgeReads,
): { items: KnowledgeQueryItem[]; indices: Map<string, number> } {
  const items: KnowledgeQueryItem[] = [];
  const indices = new Map<string, number>();
  result.results.forEach((item, index) => {
    const idx = index + 1;
    if (item.source === 'code') {
      indices.set(`code:${item.id}`, idx);
      items.push({
        idx, kind: 'code', id: item.id, scope: 'project',
        from_search_id: knowledgeReads.findSearchId('code', item.id, 'project'),
      });
    } else {
      indices.set(`${item.kind}:${item.id}`, idx);
      items.push({
        idx, kind: item.storageKind, id: item.rawId, scope: item.scope,
        from_search_id: knowledgeReads.findSearchId(item.storageKind, item.rawId, item.scope),
      });
    }
  });
  return { items, indices };
}

type GetTarget = { directId: string } | { picked: KnowledgeQueryItem };

function resolveGetTargets(
  args: string[],
  pick: string | undefined,
  fromSearch: string | undefined,
  knowledgeReads: KnowledgeReads | undefined,
): GetTarget[] {
  if (pick !== undefined) {
    if (!knowledgeReads) throw new InputError('--pick requires --reads <path> or --trace');
    if (args.length) throw new InputError('Do not combine positional record IDs with --pick');
    const rawIndices = pick.split(',').map(item => item.trim()).filter(Boolean);
    if (!rawIndices.length) throw new InputError('--pick must specify at least one positive integer');
    return rawIndices.map(raw => {
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new InputError(`Invalid pick index: ${raw}`);
      return { picked: knowledgeReads.resolvePick(fromSearch, Number(raw)) };
    });
  }
  if (!args.length) throw new InputError('record ID must be a non-empty string');
  return args.map(raw => {
    const id = requireText(raw, 'record ID');
    const ref = /^(q-\d+|search-\d+):(\d+)$/.exec(id);
    if (ref) {
      if (!knowledgeReads) throw new InputError(`${id} requires --reads <path> or --trace`);
      return { picked: knowledgeReads.resolvePick(ref[1], Number(ref[2])) };
    }
    return { directId: id };
  });
}

async function executeGetTargets(
  targets: GetTarget[],
  context: {
    kb: KnowledgeStore;
    root: string;
    filters: KnowledgeFilters;
    knowledgeReads?: KnowledgeReads;
    fromSearch?: string;
    getRemote?: (id: string, fromSearchId?: string) => Promise<unknown>;
  },
) {
  const { kb, root, filters, knowledgeReads, fromSearch, getRemote } = context;
  let codeGraph: CodeGraph | undefined;
  const getCodeGraph = () => (codeGraph ??= new CodeGraph(root));
  const recordCodeSymbol = (symbol: Awaited<ReturnType<CodeGraph['getSymbol']>>, resolvedFromSearch?: string) => {
    if (knowledgeReads) {
      knowledgeReads.recordRead({
        kind: 'code', id: symbol.id, fromSearchId: resolvedFromSearch, content: symbol.content,
      });
    }
    return symbol;
  };
  const results: Array<unknown> = [];
  for (const target of targets) {
    const id = 'picked' in target ? target.picked.id : target.directId;
    if (id.startsWith('ov:') && getRemote) {
      const resolvedFromSearch = ('picked' in target ? target.picked.from_search_id : undefined) ??
        knowledgeReads?.resolveFromSearch(fromSearch, 'memory', id, 'project');
      results.push(await getRemote(id, resolvedFromSearch) ?? null);
      continue;
    }
    if ('picked' in target) {
      const picked = target.picked;
      if (picked.kind === 'code') {
        const symbol = await getCodeGraph().getSymbol(picked.id);
        results.push(recordCodeSymbol(symbol, picked.from_search_id));
        continue;
      }
      const storageKind = picked.kind === 'memory' ? 'memory' : picked.kind === 'wiki' ? 'wiki' : filters.storageKind;
      const resolvedFromSearch = picked.from_search_id ??
        knowledgeReads?.resolveFromSearch(fromSearch, picked.kind, picked.id, picked.scope);
      const record = kb.get(picked.id, {
        ...filters,
        ...(picked.scope ? { scope: picked.scope } : {}),
        ...(storageKind ? { storageKind } : {}),
        fromSearchId: resolvedFromSearch,
      });
      results.push(record ?? null);
      continue;
    }

    const peek = kb.get(target.directId, { ...filters, knowledgeReads: undefined, trackUsage: false });
    if (!peek) {
      if (filters.kind === undefined && filters.scope !== 'global' && CodeGraph.hasIndex(root)) {
        try {
          const symbol = await getCodeGraph().getSymbol(target.directId);
          const resolvedFromSearch = knowledgeReads?.resolveFromSearch(fromSearch, 'code', symbol.id, 'project');
          results.push(recordCodeSymbol(symbol, resolvedFromSearch));
          continue;
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
      results.push(null);
      continue;
    }
    const resolvedFromSearch = knowledgeReads?.resolveFromSearch(fromSearch, peek.storageKind, peek.rawId, peek.scope);
    const record = kb.get(peek.rawId, {
      ...filters,
      storageKind: peek.storageKind,
      scope: peek.scope,
      fromSearchId: resolvedFromSearch,
    });
    results.push(record ?? null);
  }
  if (targets.length === 1) return results[0];
  return {
    results: results.map((item, index) => {
      if (item !== null) return item;
      const target = targets[index];
      return { id: 'directId' in target ? target.directId : target.picked.id, not_found: true };
    }),
  };
}

export async function runKnowledgeCli(argv: string[], invocation: 'evolve' = 'evolve') {
  const { values, positionals } = parseArgs({ args: argv, options: knowledgeOptions, allowPositionals: true });
  const [command, action, ...args] = positionals;
  if (command && !['kb', 'search', 'code', 'history', 'session', 'skill'].includes(command)) {
    throw new InputError('Unknown command: ' + command);
  }
  if (values.help || !command) {
    process.stdout.write(knowledgeHelp(invocation));
    return;
  }
  const format = (values.format ?? 'json') as OutputFormat;
  if (format !== 'json' && format !== 'compact') throw new InputError('format must be json or compact');
  if (values.json && values.format === 'compact') throw new InputError('Use either --json or --format compact, not both');
  const verbose = Boolean(values.verbose);
  let openvikingSyncTracker: OpenVikingSyncTracker | undefined;
  const print = (result: unknown, pretty = verbose) => {
    const output = withOpenVikingSync(result, openvikingSyncTracker);
    process.stdout.write(JSON.stringify(output, null, pretty ? 2 : 0) + '\n');
  };
  const isHookCommand = command === 'kb' && ['codex-hook', 'host-hook', 'session-start-hook'].includes(action ?? '');
  const hookInput: unknown = isHookCommand ? await readMemoryHookInput() : undefined;
  const rawRoot = values['root-b64'] !== undefined
    ? Buffer.from(values['root-b64'], 'base64url').toString('utf8') : values.root ?? '.';
  const root = isHookCommand ? resolveHookRoot(rawRoot, hookInput) : resolve(rawRoot);
  if (!root) return print(action === 'host-hook' && values.host === 'agy' ? { decision: 'stop' } : {});
  const globalRoot = evolveDir(homedir());
  const explicitIsolation = values.db !== undefined || values['wiki-root'] !== undefined;
  const scope = values.scope ?? (values.global ? 'global' : (values['no-global'] || explicitIsolation) ? 'project' : 'local');
  if (scope !== 'project' && scope !== 'global' && scope !== 'local') throw new InputError('scope must be project, global or local');
  if (values.global && values.scope && values.scope !== 'global') throw new InputError('--global requires --scope global');
  const writeScope = scope === 'global' ? 'global' : 'project';
  const writeRoot = writeScope === 'global' ? globalRoot : root;
  const wiki = new Wiki(process.env.EVOLVE_KNOWLEDGE_SNAPSHOT ?? values['wiki-root'] ?? writeRoot);
  const modelClient = () => createModelClient(root);
  const contextValues = cliWikiContext(values as Record<string, unknown>, root);
  if (contextValues.categories && !contextValues.categories.every(isWikiCategory)) throw new InputError('Unknown knowledge category');
  if (contextValues.repository && !isRepositoryId(contextValues.repository)) throw new InputError('Expected a persisted repository UUID');
  const limit = numberOption(values.limit, 'limit');
  const page = numberOption(values.page, 'page');
  const hop = numberOption(values.hop, 'hop');
  const kind = values.kind;
  if (kind !== undefined && kind !== 'episodic' && kind !== 'reference' && kind !== 'constraint') {
    throw new InputError('kind must be episodic, reference or constraint');
  }
  const status = values.status;
  const filteringRecords = command === 'search' || (command === 'kb' && ['get', 'list', 'search'].includes(action));
  if (filteringRecords && status !== undefined && !['active', 'deprecated', 'needs_review', 'all'].includes(status)) throw new InputError('Invalid knowledge status');
  if (values.reads && values['trace-file'] && values.reads !== values['trace-file']) throw new InputError('Use either --reads or --trace-file, not both');
  const traceFile = values.reads ?? values['trace-file'];
  const initialTrace = traceFile && existsSync(traceFile)
    ? validateKnowledgeReads(JSON.parse(readFileSync(traceFile, 'utf8').replace(/^\uFEFF/, ''))) : undefined;
  const knowledgeReads = values.trace || traceFile ? new KnowledgeReads(initialTrace) : undefined;
  const backend = values['memory-backend'];
  if (backend !== undefined && backend !== 'local' && backend !== 'openviking') throw new InputError('memory-backend must be local or openviking');
  const workflowSession = values['workflow-session'] ??
    (command === 'search' && values.mode === 'context' ? values.session : undefined);
  const frozen = process.env.EVOLVE_KNOWLEDGE_SNAPSHOT;
  const frozenWrites: Record<string, true> = {
    add: true, update: true, delete: true, init: true, build: true, import: true, propose: true, apply: true, ingest: true,
    config: true, sync: true, extract: true, 'codex-hook': true, 'host-hook': true, 'codex-sync': true, 'hook-jobs': true,
    'hook-worker': true, 'session-start-hook': true, 'codex-install': true, harvest: true, candidates: true,
  };
  if (frozen && command === 'kb' && (action !== undefined && frozenWrites[action] || (action === 'reminders' && args[0] === 'ack'))) {
    throw new InputError('Frozen knowledge is read-only');
  }
  openvikingSyncTracker = createOpenVikingSyncTracker({
    command, action, args, apply: values.apply, root, writeScope, wiki, frozen: Boolean(frozen),
  });
  let activeKnowledge: KnowledgeSources | undefined;
  let readSourcesPending: Promise<KnowledgeSources> | undefined;
  const readSources = () => readSourcesPending ??= openKnowledgeSources(root, {
    session: workflowSession, db: values.db, namespace: values.namespace,
    wikiRoot: values['wiki-root'], traceFile, memoryBackend: backend, includeMemory: true,
  });
  const persistTrace = () => {
    if (!knowledgeReads || !traceFile) return;
    mkdirSync(dirname(resolve(traceFile)), { recursive: true });
    writeFileSync(traceFile, JSON.stringify(knowledgeReads.toJSON(), null, 2) + '\n');
  };
  const withTrace = (result: unknown) => {
    const remoteReads = activeKnowledge?.memory?.drainRemoteReads?.() ?? [];
    if (traceFile && activeKnowledge?.releaseId && activeKnowledge.repositoryId && remoteReads.length) {
      appendRemoteReads(traceFile + '.openviking.json', activeKnowledge.repositoryId, activeKnowledge.releaseId, remoteReads);
    }
    if (activeKnowledge?.backend?.configured === 'openviking') result = result && typeof result === 'object' && !Array.isArray(result)
      ? { ...result, knowledge_backend: activeKnowledge.backend, ...(remoteReads.length ? { openviking_reads: remoteReads } : {}) }
      : { result, knowledge_backend: activeKnowledge.backend, ...(remoteReads.length ? { openviking_reads: remoteReads } : {}) };
    if (!knowledgeReads) return result;
    persistTrace();
    return result && typeof result === 'object' && !Array.isArray(result)
      ? { ...result, knowledge_reads: knowledgeReads.toJSON() } : { result, knowledge_reads: knowledgeReads.toJSON() };
  };
  const filters: KnowledgeFilters = {
    scope, kind, status: filteringRecords ? status as KnowledgeFilters['status'] : undefined,
    task: contextValues.task, paths: contextValues.paths, categories: contextValues.categories,
    repository: contextValues.repository, keyword: contextValues.keyword,
    includePathScoped: contextValues.includePathScoped, includeHistory: values.history, resolved: values.resolved,
    type: values.type, scene: values.scene, session: values['memory-session'] ?? values.session,
    limit, page, hop, knowledgeReads, fromSearchId: values['from-search'],
  };
  const stores: MemoryStore[] = [];
  const openMemory = (layerRoot: string, readOnly: boolean, projectLayer: boolean) => {
    const db = frozen
      ? process.env.AGENT_MEMORY_DB ?? join(frozen, 'memory.db')
      : projectLayer && values.db !== undefined ? values.db : defaultMemoryDbPath(layerRoot);
    const memory = new MemoryStore(db, { namespace: values.namespace, readOnly: readOnly || Boolean(frozen) });
    stores.push(memory);
    return memory;
  };
  const openKnowledge = async (writable = false) => {
    const layers: KnowledgeLayer[] = [];
    if (frozen) {
      const db = process.env.AGENT_MEMORY_DB ?? join(frozen, 'memory.db');
      const memory = new MemoryStore(db, { namespace: values.namespace, readOnly: true });
      stores.push(memory);
      layers.push({
        scope: 'project', wiki: new Wiki(frozen), memory,
        memoryReader: new FrozenMemoryReader(frozen, db, values.namespace),
      });
      return new KnowledgeStore(layers);
    }
    const sources = !writable && scope !== 'global' ? await readSources() : undefined;
    if (sources) {
      activeKnowledge = sources;
      if (sources.repositoryId && contextValues.repository === undefined) {
        contextValues.repository = sources.repositoryId;
        if (command === 'search' && values.mode === 'context') filters.repository = sources.repositoryId;
      }
    }
    const addLayer = (layerScope: 'project' | 'global', layerRoot: string, layerSources?: KnowledgeSources) => {
      const layerWiki = layerSources?.wiki ?? new Wiki(layerScope === 'project' ? values['wiki-root'] ?? layerRoot : layerRoot);
      layers.push({
        scope: layerScope,
        wiki: writable || layerWiki.hasWiki() || layerWiki.readableIndexPath() ? layerWiki : undefined,
        memory: openMemory(layerRoot, !writable || layerScope !== writeScope, layerScope === 'project'),
        ...(layerSources?.memory && !(layerSources.memory instanceof MemoryStore) ? { memoryReader: layerSources.memory } : {}),
      });
    };
    if (scope !== 'global') addLayer('project', root, sources);
    if (scope !== 'project' && (resolve(root) !== resolve(globalRoot) || scope === 'global')) addLayer('global', globalRoot);
    return new KnowledgeStore(layers);
  };
  const prefix = () => [invocation, 'kb', ...commandFlags({
    root, scope, db: values.db, namespace: values.namespace,
  })];
  try {
    if (command === 'search') {
      const from = values.from ?? 'all';
      const selected = from.split(',').map(item => item.trim());
      if (!selected.length || selected.some(item => !['kb', 'code', 'all'].includes(item))) throw new InputError('from must select kb, code or all');
      const mode = values.mode ?? 'merged';
      if (mode !== 'merged' && mode !== 'context') throw new InputError('mode must be merged or context');
      const useKb = selected.some(item => item === 'kb' || item === 'all');
      const hasCode = scope !== 'global' && selected.some(item => item === 'code' || item === 'all');
      let preferredMemoryTypes: string[] | undefined;
      if (mode === 'context' && values.session && existsSync(workflowDbPath(root))) {
        const activeSession = readEvolveSessions(root, values.session)[0];
        preferredMemoryTypes = activeSession?.runs.findLast(item => item.status === 'running')?.skill.search_profile?.memory;
      }
      const queryText = requireText([action, ...args].join(' '), 'query');
      const result = await unifiedSearch({
        kb: useKb ? await openKnowledge() : undefined,
        code: hasCode ? new CodeGraph(root, { autoRefresh: true }) : undefined,
      }, queryText, {
        ...filters,
        repository: useKb || contextValues.repositoryExplicit ? filters.repository : undefined,
        from, mode, preferredMemoryTypes,
        session: mode === 'context' ? undefined : filters.session,
        memorySession: values['memory-session'],
        contextScope: {
          ...(values.session ? { session_id: values.session } : {}),
          ...(contextValues.task ? { task_kind: contextValues.task } : {}),
          ...(contextValues.paths?.length ? { paths: contextValues.paths } : {}),
        },
      });
      let searchId: string | undefined;
      let indices: Map<string, number> | undefined;
      if (knowledgeReads) {
        const mapped = result.mode === 'context'
          ? buildQueryItemsForContext(result, knowledgeReads)
          : buildQueryItemsForMerged(result, knowledgeReads);
        indices = mapped.indices;
        searchId = knowledgeReads.recordQuery(result.query, mapped.items);
      }
      const formatted = result.mode === 'context'
        ? formatUnifiedContextJson(result, { searchId, indices, verbose })
        : formatUnifiedMergedJson(result, { searchId, indices, verbose });
      if (format === 'compact') {
        withTrace(formatted);
        const text = result.mode === 'context'
          ? renderUnifiedContextCompact(formatted as ReturnType<typeof formatUnifiedContextJson>)
          : renderUnifiedMergedCompact(formatted as ReturnType<typeof formatUnifiedMergedJson>);
        process.stdout.write(text);
        return;
      }
      return print(withTrace(formatted));
    }
    if (command === 'kb' && ['add', 'get', 'list', 'search', 'update', 'delete'].includes(action)) {
      const targets = action === 'get' ? resolveGetTargets(args, values.pick, values['from-search'], knowledgeReads) : [];
      if (!frozen && traceFile && !workflowSession && !existsSync(traceFile + '.openviking.json')) {
        const remoteId = targets.map(target => 'picked' in target ? target.picked.id : target.directId)
          .find(id => id.startsWith('ov:'));
        if (remoteId) {
          const profile = readProject(root);
          if (profile?.enabled !== false && profile) {
            appendRemoteReads(traceFile + '.openviking.json', profile.project_id, parseRemoteMemoryId(remoteId).release);
          }
        }
      }
      const kb = await openKnowledge(['add', 'update', 'delete'].includes(action));
      const mutationOptions: KnowledgeMutationOptions = { scope: writeScope, kind, evidence: values.evidence, apply: values.apply,
        knowledgeReads, fromSearchId: values['from-search'] };
      const input = (content: string | undefined): KnowledgeInput => ({
        kind, id: values.id, title: values.title, content,
        type: values.type, scene: values.scene ?? values.task, session: values.session,
        priority: numberOption(values.priority, 'priority'), scope: values['entry-scope'], categories: values.category,
        sources: values.evidence,
      });
      if (action === 'add') return print(withTrace(await kb.add(input(values.content ?? args.join(' ')), mutationOptions)));
      if (action === 'get') {
        const payload = await executeGetTargets(targets, {
          kb, root, filters, knowledgeReads, fromSearch: values['from-search'],
          ...(!frozen ? { getRemote: async (id: string, fromSearchId?: string) => {
            const sources = await readSources();
            activeKnowledge = sources;
            if (!sources.memory) throw new InputError('Memory reader is not configured');
            if (!sources.releaseId && readProject(root)) throw new InputError('OPENVIKING_REMOTE_ID_UNAVAILABLE');
            return sources.memory.get(id, { knowledgeReads, fromSearchId });
          } } : {}),
        });
        if (format === 'compact') {
          withTrace(payload);
          process.stdout.write(renderKbGetCompact(payload));
          return;
        }
        return print(withTrace(payload));
      }
      if (action === 'update') return print(withTrace(await kb.update(requireText(args[0], 'record ID'), input(values.content ?? (args.length > 1 ? args.slice(1).join(' ') : undefined)), mutationOptions)));
      if (action === 'delete') return print(withTrace(await kb.delete(requireText(args[0], 'record ID'), mutationOptions)));
      const result = action === 'list' ? await kb.list(filters) : await kb.search(requireText(args.join(' '), 'query'), filters);
      const queryLabel = action === 'list' ? 'kb:list' : args.join(' ');
      let searchId: string | undefined;
      if (knowledgeReads) {
        const items: KnowledgeQueryItem[] = result.results.map((record, index) => ({
          idx: index + 1,
          kind: record.storageKind,
          id: record.rawId,
          scope: record.scope,
          ...(action === 'search' ? { from_search_id: knowledgeReads.findSearchId(record.storageKind, record.rawId, record.scope) } : {}),
        }));
        searchId = knowledgeReads.recordQuery(queryLabel, items);
      }
      if (verbose) {
        const results = result.results.map((record, index) => {
          const itemSearchId = knowledgeReads?.findSearchId(record.storageKind, record.rawId, record.scope);
          return { ...record, ...(searchId ? { idx: index + 1 } : {}), ...(itemSearchId ? { search_id: itemSearchId } : {}) };
        });
        const commands = {
          prefix: prefix(),
          get: ['get', '--kind', { arg: 'kind' }, ...commandFlags({ reads: traceFile, trace: values.trace }),
            ...(traceFile && action === 'search' ? ['--from-search', { arg: 'search_id' }] : []), '--', { arg: 'id' }],
          sources: ['sources', '--', { arg: 'id' }],
          ...(hasOtherPage(result.pagination) ? { page: [action, ...commandFlags({
            kind, status: values.status, task: values.task, session: values.session, type: values.type, scene: values.scene,
            limit: result.pagination.limit, reads: traceFile, trace: values.trace,
          }), ...((values.path ?? []).flatMap(value => ['--path', value])),
            ...((values.category ?? []).flatMap(value => ['--category', value])),
            '--verbose', '--page', { arg: 'page' }, ...(action === 'search' ? ['--', args.join(' ')] : [])] } : {}),
        };
        const payload = { ...(searchId ? { search_id: searchId } : {}), ...result, results, commands };
        if (format === 'compact') {
          withTrace(payload);
          process.stdout.write(renderKbSearchCompact(payload as Parameters<typeof renderKbSearchCompact>[0]));
          return;
        }
        return print(withTrace(payload));
      }
      const allIds = result.results.map(record => record.id);
      const compactResults = result.results.map((record, index) =>
        projectKnowledgeHit(record, { idx: searchId ? index + 1 : undefined, allIds }));
      const payload = {
        ...(searchId ? { search_id: searchId } : {}),
        results: compactResults,
        pagination: result.pagination,
      };
      if (format === 'compact') {
        withTrace(payload);
        process.stdout.write(renderKbSearchCompact(payload));
        return;
      }
      return print(withTrace(payload));
    }
    if (command === 'kb' && action === 'config') {
      return print(await configureMemory(root, {
        scope: writeScope === 'global' ? 'user' : 'project', host: values.host,
        baseUrl: values['base-url'], model: values.model,
        timeoutMs: numberOption(values['timeout-ms'], 'timeout-ms'), yes: values.yes,
      }));
    }
    if (command === 'kb' && action === 'closeouts') {
      if (args[0] && values.verbose) return print(readNativeCloseoutJobs(root, args[0]));
      return print({ jobs: nativeCloseoutStatus(root).filter(job => !args[0] || job.session_id === args[0]),
        unharvested: findUnharvestedSessions(root).filter(job => !args[0] || job.id === args[0]) });
    }
    if (command === 'kb' && action === 'feedback') {
      if (!traceFile || !initialTrace || !knowledgeReads) throw new InputError('Feedback requires an existing --reads receipt');
      const result = knowledgeReads.recordFeedback(requireText(args[0], 'full knowledge ID'),
        requireText(values.outcome, 'outcome'), values.evidence ?? [], values['content-hash']);
      persistTrace();
      return print(withTrace(result));
    }
    if (command === 'kb' && action === 'storage') {
      if (scope === 'global' || values.db || values['wiki-root']) throw new InputError('Storage migration targets the project root');
      return print(migrateKnowledgeStorage(root, Boolean(values.apply)));
    }
    if (command === 'kb' && action === 'doctor') {
      const settings = memoryModelSettings(root);
      const configured = Boolean(settings.baseUrl && settings.model);
      let probe: { ok: boolean; error?: string } | undefined;
      if (values.llm) {
        try {
          await modelClient().chat({ system: 'Reply with a JSON empty array only.', prompt: '[]', label: 'doctor' });
          probe = { ok: true };
        } catch (error) { probe = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      }
      const hookJobs = readMemoryHookJobs(root);
      const sessions = readEvolveSessions(root);
      const memory = openMemory(root, true, true);
      const traces = sessions.flatMap(session => session.runs.filter(run => run.status === 'sealed' && run.knowledge_reads).map(run => run.knowledge_reads!));
      const feedback = traces.flatMap(trace => trace.feedback ?? []);
      const latest = memory.list({ limit: 1 }).results[0];
      return print({
        model: { configured, ...(probe ? { probe } : {}) },
        hosts: inspectMemoryHooks(root).map(host => ({
          ...host, last_job: hookJobs.filter(job => job.host === host.host)
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(job => ({
              state: job.state, updated_at: job.updated_at, attempts: job.attempts,
            }))[0] ?? null,
        })),
        memory: { top_ranked_record_updated: latest?.updatedAt ?? null, pending_hook_jobs: hookJobs.filter(job => job.state === 'pending' || job.state === 'running').length,
          failed_hook_jobs: hookJobs.filter(job => job.state === 'failed').length },
        closeouts: nativeCloseoutStatus(root), unharvested: findUnharvestedSessions(root),
        sessions: { total: sessions.length, completed: sessions.filter(session => session.status === 'completed').length },
        knowledge_use: {
          sealed_run_receipts: traces.length,
          searches: traces.reduce((n, trace) => n + trace.searches.length, 0),
          read_records: traces.reduce((n, trace) => n + trace.reads.length, 0),
          feedback_records: feedback.length,
          adopted: feedback.filter(item => ['adopted', 'helpful', 'ineffective'].includes(item.outcome)).length,
          helpful: feedback.filter(item => item.outcome === 'helpful').length,
          ineffective: feedback.filter(item => item.outcome === 'ineffective').length,
          conflict: feedback.filter(item => item.outcome === 'conflict').length,
        },
        history_index_present: existsSync(evolvePath(root, 'history-signals.db')),
        storage: migrateKnowledgeStorage(root),
        reminders: readReminders(root).length,
      });
    }
    if (command === 'kb' && action === 'reminders') {
      if (args[0] === 'ack') return print(acknowledgeReminders(writeRoot, args[1]));
      const hookJobs = readMemoryHookJobs(root).map(({ event, ...job }) => job);
      return print({ reminders: readReminders(writeRoot, values.history), hook_jobs: hookJobs, closeouts: nativeCloseoutStatus(root) });
    }
    if (command === 'kb' && action === 'hook-jobs') {
      if (args.length > 2 || (args.length && args[0] !== 'retry')) throw new InputError('Usage: evolve kb hook-jobs [retry [id]]');
      const retried = args[0] === 'retry' ? await retryMemoryHookJobs(root, args[1]) : undefined;
      if (retried) await startMemoryHookWorker(root);
      return print({ jobs: readMemoryHookJobs(root).map(({ event, ...job }) => job), ...(retried === undefined ? {} : { retried }) });
    }
    if (command === 'kb' && action === 'hook-worker') {
      const result = await drainMemoryHookJobs(root, async job => {
        const memory = new MemoryStore(job.db ?? defaultMemoryDbPath(root), { namespace: job.namespace });
        try {
          // Index deterministic evidence independently of the model extraction cursor.
          const signals = await collectHistorySignals({ root, hosts: [job.host], session: job.session, sources: ['transcript'] });
          if (signals.failures.length) throw new InputError(JSON.stringify(signals.failures));
          return await handleMemoryHook(job.host, job.event, { root, memory, model: modelClient });
        } finally {
          memory.close();
        }
      });
      const closeouts = hasPendingNativeCloseouts(root) ? await drainNativeCloseouts(root, modelClient) : undefined;
      if (result.failed || closeouts?.errors.length) process.exitCode = 1;
      return print(closeouts ? { ...result, closeouts } : result);
    }
    if (command === 'kb' && action === 'session-start-hook') {
      const hosts = parseMemoryHosts(requireText(values.host, 'host'));
      if (hosts.length !== 1) throw new InputError('Choose one host for the hook');
      const result = handleSessionStartHook(hosts[0], hookInput, { root });
      if (Object.keys(result).length) {
        const settings = memoryModelSettings(root);
        const closeouts = Boolean(settings.baseUrl && settings.model && hasPendingNativeCloseouts(root));
        if (hasPendingMemoryHookJobs(root) || closeouts) await startMemoryHookWorker(root, closeouts);
      }
      return print(result);
    }
    if (command === 'kb' && action === 'codex-install') return print(installCodexMemoryHook(root));
    if (command === 'kb' && values.background && (action === 'codex-hook' || action === 'host-hook')) {
      const hosts = parseMemoryHosts(action === 'codex-hook' ? 'codex' : requireText(values.host, 'host'));
      if (hosts.length !== 1) throw new InputError('Choose one host for the hook');
      const host = hosts[0];
      const target = memoryHookTarget(host, hookInput, root);
      if (target) {
        await enqueueMemoryHook(root, host, hookInput, target, {
          db: resolve(values.db ?? defaultMemoryDbPath(writeRoot)), namespace: values.namespace,
        });
        await startMemoryHookWorker(root);
      }
      return print(host === 'agy' ? { decision: 'stop' } : {});
    }
    if (command === 'kb' && ['sources', 'history', 'conversation', 'extract', 'codex-hook', 'host-hook', 'codex-sync', 'sync'].includes(action)) {
      const readOnly = action === 'sources' || action === 'history' || action === 'conversation';
      const memory = openMemory(writeRoot, readOnly, writeScope === 'project');
      if (action === 'history') {
        // 已删除的记录不再出现在当前视图中，回退到写入层直接查询历史。
        const id = requireText(args[0], 'record ID');
        const selected = (await openKnowledge()).get(id, { ...filters, kind: 'episodic' });
        const store = selected ? openMemory(selected.scope === 'global' ? globalRoot : root, true, selected.scope === 'project') : memory;
        return print({ id, current: selected ?? null, history: store.history(selected?.rawId ?? id) });
      }
      if (action === 'sources') {
        const id = requireText(args[0], 'record ID');
        const selected = (await openKnowledge()).get(id, { ...filters, kind: 'episodic' });
        if (!selected) return print([]);
        const selectedRoot = selected.scope === 'global' ? globalRoot : root;
        return print(openMemory(selectedRoot, true, selected.scope === 'project').sources(selected.rawId));
      }
      if (action === 'conversation') {
        const hosts = values.host === undefined ? [] : parseMemoryHosts(values.host);
        if (hosts.length > 1) throw new InputError('Choose one host for the conversation');
        const target = requireText(args[0], 'session or record ID');
        const selected = (await openKnowledge()).get(target, { ...filters, kind: 'episodic' });
        const selectedMemory = selected?.scope === 'global' ? openMemory(globalRoot, true, false) : memory;
        const result = await readMemoryConversation(selected?.rawId ?? target, { root, memory: selectedMemory, host: hosts[0], page, limit });
        const commands = hasOtherPage(result.pagination) ? {
          prefix: prefix(), page: ['conversation', '--host', result.host, '--limit', String(result.pagination.limit), '--page', { arg: 'page' }, '--', target],
        } : undefined;
        return print({ ...result, ...(commands ? { commands } : {}) });
      }
      if (action === 'extract') {
        const messages: unknown = JSON.parse(readFileSync(requireText(args[0], 'messages file'), 'utf8').replace(/^\uFEFF/, ''));
        if (!Array.isArray(messages)) throw new InputError('Messages file must contain a JSON array');
        const mode = values.mode ?? 'chat';
        if (mode !== 'chat' && mode !== 'code') throw new InputError('mode must be chat or code');
        return print(await memory.extract(messages as ConversationMessage[], { session: requireText(values.session, 'session'), mode, llm: modelClient() }));
      }
      if (action === 'codex-hook' || action === 'host-hook') {
        const hosts = parseMemoryHosts(action === 'codex-hook' ? 'codex' : requireText(values.host, 'host'));
        if (hosts.length !== 1) throw new InputError('Choose one host for the hook');
        return print(await handleMemoryHook(hosts[0], hookInput, { root, memory, model: modelClient, allowUnconfiguredModel: true }));
      }
      const hosts = parseMemoryHosts(action === 'codex-sync' ? 'codex' : values.host ?? 'all');
      const results = [];
      for (const host of hosts) {
        const result = await syncMemoryHost(host, { root, memory, model: modelClient }, values.session);
        if (result.failures.length) process.exitCode = 1;
        results.push({ host, ...result });
      }
      return print(action === 'codex-sync' ? results[0] : { hosts: results });
    }
    if (command === 'kb') {
      if (action === 'init') return print(initWiki(values['wiki-root'] ?? writeRoot, { purpose: values.purpose, schema: values.schema, force: values.force }));
      if (action === 'build') return print(wiki.build());
      if (action === 'lint') {
        const kb = await openKnowledge(false);
        const report = lintKnowledge({ root, scope, layers: kb.getLayers() });
        if (format === 'compact') {
          process.stdout.write(renderKbLintCompact(report));
          return;
        }
        return print(report);
      }
      if (action === 'import') {
        if (args.length > 1) throw new InputError('Usage: evolve kb import [source] [--scope project|global] [--apply]');
        const source = realpathSync(args[0] ?? (scope === 'global' ? join(homedir(), '.maestro') : root));
        const project = values.project ?? (scope === 'global' && !args[0] ? 'maestro-global' : 'legacy-' + createHash('sha256').update(source).digest('hex').slice(0, 16));
        const entries = migrateLegacyWiki(wiki, source, project, values.apply, { scope: writeScope, knowhowOnly: values['knowhow-only'] });
        return print({ source, destination: wiki.root, project, scope: writeScope, applied: values.apply ?? false,
          new_entries: entries.filter(entry => !entry.existing).length,
          existing_entries: entries.filter(entry => entry.existing).length,
          needs_review: entries.filter(entry => entry.status === 'needs_review').length, entries });
      }
      if (action === 'propose') {
        const change: unknown = JSON.parse(readFileSync(requireText(args[0], 'change file'), 'utf8').replace(/^\uFEFF/, ''));
        if (values.closeout !== undefined || values.candidate !== undefined) {
          const closeout = requireText(values.closeout, 'candidate receipt ID');
          const candidate = readCloseoutCandidate(wiki, closeout, requireText(values.candidate, 'candidate ID'));
          return print(proposeWikiChange(wiki, change, values.evidence ?? [], {
            closeout, id: candidate.id, sources: candidate.sources,
            related: [...(candidate.matched_entry ? [candidate.matched_entry] : []), ...(candidate.related_entries ?? []).map(entry => entry.id)],
          }));
        }
        return print(proposeWikiChange(wiki, change, values.evidence ?? []));
      }
      if (action === 'changes') return print(listWikiChanges(wiki, { id: args[0], entry: values.entry }));
      if (action === 'apply') return print(applyWikiChange(wiki, requireText(args[0], 'change ID')));
      if (action === 'ingest') return print(await wiki.ingest(requireText(args[0], 'source file'), { llm: modelClient(), propose: values.propose }));
    }
    if (command === 'code') {
      const code = new CodeGraph(root, { autoRefresh: true });
      const formatGraphList = (items: RawCodeGraphItem[]) => {
        if (verbose) return items;
        const allIds = items.map(item => item.node.id);
        return items.map(item => projectCodeGraphItem(item, allIds));
      };
      switch (action) {
        case 'build': return print(await code.build());
        case 'sync': return print(await code.sync());
        case 'search': {
          const query = args.join(' ');
          const result = await code.search(query, limit);
          let searchId: string | undefined;
          if (knowledgeReads) {
            const subSearchId = knowledgeReads.recordSearch({
              source: 'code', query,
              returnedIds: result.flatMap(item => typeof item.node?.id === 'string' ? [item.node.id] : []),
            });
            const queryItems: KnowledgeQueryItem[] = result.flatMap((item, index) =>
              typeof item.node?.id === 'string'
                ? [{ idx: index + 1, kind: 'code' as const, id: item.node.id, scope: 'project' as const, from_search_id: subSearchId }]
                : []);
            searchId = knowledgeReads.recordQuery(query, queryItems);
          }
          const allIds = result.map(item => item.node.id);
          const projected = verbose
            ? result.map((item, index) => ({ ...(searchId ? { idx: index + 1 } : {}), ...item }))
            : (result as unknown as RawCodeGraphItem[]).map((item, index) =>
              projectCodeGraphItem(item, allIds, searchId ? index + 1 : undefined));
          if (format === 'compact') {
            persistTrace();
            process.stdout.write(renderCodeSearchCompact({
              search_id: searchId,
              results: projected as Array<Record<string, unknown>>,
            }));
            return;
          }
          if (knowledgeReads) {
            return print(withTrace({ ...(searchId ? { search_id: searchId } : {}), results: projected }));
          }
          return print(projected);
        }
        case 'graph': {
          const raw = args.length > 1
            ? await code.trace(requireText(args[0], 'from id'), requireText(args[1], 'to id'))
            : await (async () => {
              const direction = values.direction ?? 'callers';
              if (direction !== 'callers' && direction !== 'callees') throw new InputError('direction must be callers or callees');
              return code.neighbors(requireText(args[0], 'symbol id'), direction, numberOption(values.depth, 'depth') ?? 1);
            })();
          const formatted = formatGraphList(raw as unknown as RawCodeGraphItem[]);
          if (format === 'compact') {
            process.stdout.write(renderCodeSearchCompact({ results: formatted as Array<Record<string, unknown>> }));
            return;
          }
          return print(formatted);
        }
        case 'callers':
        case 'callees': {
          const raw = await code.neighbors(requireText(args[0], 'symbol id'), action, Number(values.depth ?? '1'));
          const formatted = formatGraphList(raw as unknown as RawCodeGraphItem[]);
          if (format === 'compact') {
            process.stdout.write(renderCodeSearchCompact({ results: formatted as Array<Record<string, unknown>> }));
            return;
          }
          return print(formatted);
        }
        case 'trace': {
          const raw = await code.trace(requireText(args[0], 'from id'), requireText(args[1], 'to id'));
          const formatted = formatGraphList(raw as unknown as RawCodeGraphItem[]);
          if (format === 'compact') {
            process.stdout.write(renderCodeSearchCompact({ results: formatted as Array<Record<string, unknown>> }));
            return;
          }
          return print(formatted);
        }
        default:
          throw new InputError(`Unknown code command: ${action ?? ''}. Expected build, sync, search, graph, callers, callees or trace`);
      }
    }
    if (command === 'kb' && (action === 'harvest' || action === 'candidates')) {
      const [operation, ...targets] = args;
      const allowed = action === 'harvest' ? ['receipt', 'session', 'conversation', 'skill', 'scan', 'pending'] : ['show', 'route', 'publish'];
      if (!operation || !allowed.includes(operation)) throw new InputError('Unknown kb ' + action + ' operation');
      if (operation === 'publish') return print(publishReference(
        wiki, requireText(targets[0], 'closeout ID'), requireText(targets[1], 'candidate ID'), targets.slice(2).join(' '), values.entry,
      ));
      if (operation === 'route') {
        const candidate = readCloseoutCandidate(wiki, requireText(targets[0], 'closeout ID'), requireText(targets[1], 'candidate ID'));
        const closeoutId = requireText(targets[0], 'closeout ID');
        const candidateId = requireText(targets[1], 'candidate ID');
        if (candidate.candidate_kind === 'deterministic_check') {
          recordCandidateRoute(wiki, { closeoutId, candidateId, route: 'deterministic-check', status: 'routed' });
          return print({ route: 'deterministic-check', confidence: 'medium', reasons: ['Review reproducible rule for code, lint, test or hook; do not add Skill prose'], invoke_meta_skill: false });
        }
        if (candidate.candidate_kind === 'constraint') {
          recordCandidateRoute(wiki, { closeoutId, candidateId, route: 'wiki', status: 'routed' });
          return print({ route: 'wiki', confidence: 'medium', reasons: ['Durable constraint requires governed proposal and explicit approval'], invoke_meta_skill: false });
        }
        if (candidate.candidate_kind === 'workflow_issue' && !values.skill && !values['skill-intent']) {
          return print({ route: 'review-required', confidence: 'low', reasons: ['Select the responsible Skill/version or confirm deterministic code remediation before routing'], invoke_meta_skill: false });
        }
        const skillEntry = values.skill ? resolve(root, resolveSkillEntry(root, values.skill)) : undefined;
        const decision = decideSkillRoute({
          content: candidate.content,
          sources: candidate.sources,
          matchedEntry: candidate.matched_entry,
          relatedEntries: candidate.related_entries?.map(entry => entry.id),
          skillId: values.skill,
          skillVersion: values['skill-version'],
          signalKinds: [...(values['signal-kind'] ?? []), ...(candidate.candidate_kind === 'workflow_issue' ? ['workflow_issue'] : [])],
          repeatCount: values['repeat-count'] === undefined ? undefined : Number(values['repeat-count']),
          stepCount: values['step-count'] === undefined ? undefined : Number(values['step-count']),
          crossSkill: values['cross-skill'],
          requiresNewContract: values['new-contract'],
          requiresNewArtifacts: values['new-artifacts'],
          requiresRouting: values['requires-routing'],
          explicitSkillIntent: values['skill-intent'],
          ...(skillEntry && existsSync(skillEntry) ? { learnings: learningBloat(readSkillLearnings(skillEntry)) } : {}),
        });
        if (decision.route !== 'skill-design') {
          recordCandidateRoute(wiki, {
            closeoutId,
            candidateId,
            route: decision.route,
            status: 'routed',
            ...(values.skill ? { skillId: values.skill } : {}),
          });
          return print(decision);
        }
        const task = createSkillDesignTask(root, {
          closeoutId, candidateId, content: candidate.content, sources: candidate.sources,
          decision, skillId: values.skill, skillVersion: values['skill-version'],
        });
        recordCandidateRoute(wiki, {
          closeoutId,
          candidateId,
          route: 'skill-design',
          status: 'routed',
          ...(values.skill ? { skillId: values.skill } : {}),
          designTaskId: task.id,
        });
        return print({ ...decision, design_task: task });
      }
      if (operation === 'pending') {
        if (writeScope !== 'project' || values['wiki-root'] !== undefined) throw new InputError('Pending closeouts belong to the source project Wiki');
        const result = await drainNativeCloseouts(root, modelClient, true);
        if (result.errors.length) process.exitCode = 1;
        return print(result);
      }
      if (operation === 'session' && writeScope === 'project' && values['wiki-root'] === undefined) {
        const session = requireText(targets[0], 'Session ID');
        const [job] = readNativeCloseoutJobs(root, session);
        if (job) {
          if (values.receipt && values.receipt !== job.receipt_id) throw new InputError('Evolve Session receipt ID mismatch');
          if (values.project && values.project !== job.project) {
            throw new InputError('Frozen closeout uses project ID ' + job.project + '; use that ID or omit --project');
          }
          return print(await processNativeCloseout(root, session, modelClient));
        }
      }
      const project = requireText(values.project, 'source project ID');
      if (operation === 'receipt') {
        const source = requireText(targets[0], 'receipt path or ID');
        if (existsSync(source)) {
          return print(await harvestCompletion(
            wiki, project, JSON.parse(readFileSync(source, 'utf8').replace(/^\uFEFF/, '')), modelClient,
          ));
        }
        const saved = readSkillCompletions(wiki, project, source)[0];
        if (!saved) throw new InputError(`Standalone Skill completion receipt not found: ${source}`);
        return print(await harvestCompletion(wiki, project, saved.receipt, modelClient));
      }
      if (operation === 'show') return print(readHarvest(wiki, project, requireText(targets[0], 'completion receipt ID')));
      if (operation === 'session') {
        const session = requireText(targets[0], 'Session ID');
        const [native] = readEvolveSessions(root, session);
        if (native) {
          const receipt = readNativeCloseoutJobs(root, session)[0]?.receipt ?? evolveSessionReceipt(native);
          if (values.receipt && values.receipt !== receipt.id) throw new InputError('Evolve Session receipt ID mismatch');
          return print(await harvestCompletion(wiki, project, receipt, modelClient));
        }
        const receipts = [...readCompletionReceipts(root, session, values.receipt)];
        if (receipts.length !== 1) {
          throw new InputError(`Expected one committed completion receipt for ${session}, found ${receipts.length}`);
        }
        const [{ receipt, directory }] = receipts;
        return print(await harvestCompletion(wiki, project, receipt, modelClient, directory));
      }
      if (operation === 'conversation') {
        const hosts = values.host === undefined ? undefined : parseMemoryHosts(values.host);
        if (hosts && hosts.length > 1) throw new InputError('Choose one host for conversation closeout');
        const conversation = await readHostConversationMessages(root, requireText(targets[0], 'conversation session ID'), hosts?.[0]);
        return print(await harvestConversation(wiki, project, conversation, modelClient));
      }
      if (operation === 'skill') {
        const transcript = values.transcript ? JSON.parse(readFileSync(values.transcript, 'utf8').replace(/^\uFEFF/, '')) : [];
        if (!Array.isArray(transcript)) throw new InputError('Transcript must be a JSON message array');
        const knowledgeReads = values['knowledge-receipt']
          ? validateKnowledgeReads(JSON.parse(readFileSync(values['knowledge-receipt'], 'utf8').replace(/^\uFEFF/, '')))
          : undefined;
        const recorded = recordSkillCompletion(wiki, project, {
          execution: requireText(targets[0], 'Skill execution ID'),
          skill: requireText(values.skill, 'Skill ID'), version: requireText(values['skill-version'], 'Skill version'),
          status: requireText(values.status, 'Skill status'), messages: transcript, session: values.session, knowledgeReads,
        });
        if (!('receipt' in recorded)) return print(recorded);
        if (values['record-only']) return print({ receipt: recorded.receipt.id });
        return print({ receipt: recorded.receipt.id, ...await harvestCompletion(wiki, project, recorded.receipt, modelClient) });
      }
      if (operation === 'scan') {
        const results: Awaited<ReturnType<typeof harvestCompletion>>[] = [];
        const errors: Array<{ receipt: string; error: string }> = [];
        const sessionSource = targets[0] ?? root;
        const hasHistoricalSessions = existsSync(join(sessionSource, '.workflow', 'sessions'));
        if (targets[0] && !hasHistoricalSessions && !existsSync(workflowDbPath(sessionSource))) {
          throw new InputError('Cannot locate Evolve or historical Sessions in the source project');
        }
        const sessionReceipts = hasHistoricalSessions
          ? readCompletionReceipts(sessionSource) : [];
        const consume = async (id: string, receipt: unknown, directory?: string) => {
          try {
            results.push(await harvestCompletion(wiki, project, receipt, modelClient, directory));
          } catch (error) {
            errors.push({ receipt: id, error: error instanceof Error ? error.message : String(error) });
          }
        };
        for (const { receipt, directory } of sessionReceipts) {
          await consume(requireText(receipt.transition_id, 'transition ID'), receipt, directory);
        }
        for (const session of readEvolveSessions(sessionSource).filter(item => item.status === 'completed')) {
          const [job] = readNativeCloseoutJobs(sessionSource, session.id);
          const receipt = job?.receipt ?? evolveSessionReceipt(session);
          if (job && resolve(sessionSource) === root && writeScope === 'project' && values['wiki-root'] === undefined) {
            try { results.push(await processNativeCloseout(root, session.id, modelClient)); }
            catch (error) { errors.push({ receipt: receipt.id, error: error instanceof Error ? error.message : String(error) }); }
          } else await consume(receipt.id, receipt);
        }
        for (const { id, receipt } of readSkillCompletions(wiki, project)) {
          await consume(id, receipt);
        }
        if (errors.length > 0) {
          process.exitCode = 1;
          return print({ results, errors });
        }
        return print(results);
      }
    }

    if (command === 'history') {
      const hosts = values.host === undefined ? undefined : parseMemoryHosts(values.host);
      if (action === 'collect') {
        const requestedSources = values.source
          ? values.source.split(',').map(item => item.trim()).filter(Boolean)
          : ['transcript', 'memory', 'wiki'];
        if (values.llm && !requestedSources.includes('llm')) requestedSources.push('llm');
        const validSources = new Set<SignalSourceKind>(['transcript', 'memory', 'wiki', 'llm']);
        if (!requestedSources.length || requestedSources.some(item => !validSources.has(item as SignalSourceKind))) {
          throw new InputError('source must be transcript, memory, wiki, or llm');
        }
        const stats = await collectHistorySignals({
          root,
          hosts,
          session: values.session,
          sources: requestedSources as SignalSourceKind[],
          allProjects: Boolean(values['all-projects']),
          ...(requestedSources.includes('llm') ? { llm: modelClient } : {}),
        });
        if (stats.failures.length > 0) process.exitCode = 1;
        return print(stats);
      }
      if (action === 'list') {
        const summaries = await listAgentHistory({
          root,
          hosts,
          session: values.session,
          since: values.since,
          signalsOnly: Boolean(values['signals-only']),
          allProjects: Boolean(values['all-projects']),
          limit,
        });
        const cursors = readHistoryCursorMap(root);
        const enriched = summaries.map(item => {
          const cursor = cursors.get(`${item.host}:${item.session}`);
          return {
            ...item,
            collected_offset: cursor?.byte_offset ?? 0,
            collected_signals: cursor?.signal_count ?? 0,
            has_new_bytes: !cursor || cursor.path !== item.path || cursor.file_size > cursor.byte_offset,
          };
        });
        if (format === 'compact') {
          process.stdout.write(renderHistoryListCompact(enriched as Array<Record<string, unknown>>));
          return;
        }
        return print(enriched);
      }
      if (action === 'search') {
        const query = args.join(' ').trim() || undefined;
        const roles = values.role
          ? values.role.split(',').map(item => item.trim()).filter(Boolean) as HistoryEntryRole[]
          : undefined;
        if (roles?.some(role => !['user', 'assistant', 'tool', 'error'].includes(role))) {
          throw new InputError('role must be user, assistant, tool, or error');
        }
        const sourceSpec = (values.source ?? 'all').split(',').map(item => item.trim()).filter(Boolean);
        const validSearchSources = new Set(['all', 'signals', 'transcript', 'memory', 'wiki', 'llm']);
        if (!sourceSpec.length || sourceSpec.some(item => !validSearchSources.has(item))) {
          throw new InputError('source must be all, signals, transcript, memory, wiki, or llm');
        }
        const searchLimitValue = limit ?? 20;
        const searchPage = page ?? 1;
        const specificSignalKinds = sourceSpec.filter((item): item is SignalSourceKind =>
          ['memory', 'wiki', 'llm'].includes(item));
        const onlyCollectedSignals = sourceSpec.includes('signals') ||
          (specificSignalKinds.length > 0 && !sourceSpec.includes('all') && !sourceSpec.includes('transcript'));
        if (onlyCollectedSignals) {
          const sourceKinds: SignalSourceKind[] | undefined = sourceSpec.includes('signals')
            ? (specificSignalKinds.length ? specificSignalKinds : undefined)
            : specificSignalKinds;
          const result = queryCollectedSignals(root, {
            query,
            regex: Boolean(values.regex),
            hosts: hosts as string[] | undefined,
            session: values.session,
            sourceKinds,
            roles,
            skill: values.skill,
            since: values.since,
            limit: searchLimitValue,
            page: searchPage,
          });
          if (format === 'compact') {
            process.stdout.write(renderHistorySearchCompact(result));
            return;
          }
          return print(result);
        }
        if (sourceSpec.includes('transcript') && !sourceSpec.includes('all')) {
          const result = await searchAgentHistory({
            root,
            query,
            regex: Boolean(values.regex),
            hosts,
            session: values.session,
            roles,
            skill: values.skill,
            signalsOnly: Boolean(values['signals-only']),
            since: values.since,
            allProjects: Boolean(values['all-projects']),
            includeTools: values['include-tools'] ?? true,
            limit: searchLimitValue,
            page: searchPage,
          });
          if (format === 'compact') {
            process.stdout.write(renderHistorySearchCompact(result));
            return;
          }
          return print(result);
        }
        // source === 'all': 合并已收集信号（transcript/memory/wiki/llm）与实时日志扫描并按事件维度去重。
        const collected = queryCollectedSignals(root, {
          query,
          regex: Boolean(values.regex),
          hosts: hosts as string[] | undefined,
          session: values.session,
          roles,
          skill: values.skill,
          since: values.since,
          limit: 100,
          page: 1,
        });
        const live = (query || values['signals-only'] || values.skill || values.session || roles?.length)
          ? await searchAgentHistory({
              root,
              query,
              regex: Boolean(values.regex),
              hosts,
              session: values.session,
              roles,
              skill: values.skill,
              signalsOnly: Boolean(values['signals-only']),
              since: values.since,
              allProjects: Boolean(values['all-projects']),
              includeTools: values['include-tools'] ?? true,
              limit: 100,
              page: 1,
            })
          : { total: 0, results: [] };
        const mergedMap = new Map<string, Record<string, unknown>>();
        const transcriptSignalAnchors = new Set<string>();
        for (const sig of collected.results) {
          if (sig.source_kind === 'transcript') transcriptSignalAnchors.add(sig.anchor);
          mergedMap.set(`${sig.anchor}::${sig.source_kind}::${sig.signal_type}`, { ...sig });
        }
        for (const hit of live.results) {
          if (!transcriptSignalAnchors.has(hit.anchor)) {
            mergedMap.set(`${hit.anchor}::live`, { source_kind: 'transcript', ...hit });
          }
        }
        const merged = [...mergedMap.values()].sort((left, right) =>
          String(right.timestamp).localeCompare(String(left.timestamp)));
        const start = (searchPage - 1) * searchLimitValue;
        const paged = merged.slice(start, start + searchLimitValue);
        const result = {
          total: merged.length,
          results: paged,
          pagination: {
            page: searchPage,
            limit: searchLimitValue,
            previousPage: searchPage > 1 ? searchPage - 1 : null,
            nextPage: start + searchLimitValue < merged.length ? searchPage + 1 : null,
          },
        };
        if (format === 'compact') {
          process.stdout.write(renderHistorySearchCompact(result));
          return;
        }
        return print(result);
      }
      if (action === 'show') {
        if (hosts && hosts.length > 1) throw new InputError('Choose one host for history show');
        const result = await showAgentHistory({
          root,
          session: requireText(args[0] ?? values.session, 'Session ID'),
          host: hosts?.[0],
          anchor: values.anchor,
          context: numberOption(values.context, 'context'),
          includeTools: values['include-tools'] ?? true,
          allProjects: Boolean(values['all-projects']),
          page,
          limit,
        });
        if (format === 'compact') {
          process.stdout.write(renderHistoryShowCompact(result as unknown as {
            host: string; session: string; entries: Array<Record<string, unknown>>;
          }));
          return;
        }
        return print(result);
      }
      throw new InputError(`Unknown history command: ${action ?? ''}. Expected collect, list, search or show`);
    }

    if (command === 'session' && action === 'review') {
      const transcript = values.transcript ? JSON.parse(readFileSync(values.transcript, 'utf8')) : undefined;
      if (transcript !== undefined && !Array.isArray(transcript)) throw new InputError('Transcript must be a JSON message array');
      return print(await reviewSession(root, requireText(args[0], 'Session ID'), {
        model: modelClient, transcript, deterministicOnly: Boolean(values['no-llm']),
      }));
    }

    if (command === 'skill' && action === 'review') {
      return print(await reviewSkillExecution(
        wiki, requireText(values.project, 'source project ID'), requireText(args[0], 'Skill execution ID'), modelClient,
      ));
    }

    if (command === 'skill' && action === 'draft') {
      const priority = values.priority;
      if (priority !== 'high' && priority !== 'normal' && priority !== 'low') throw new InputError('Unknown Skill priority');
      return print(draftSkillAddition({
        entry: requireText(args[0], 'Skill entry path'),
        priority,
        instruction: args.slice(1).join(' '),
        sources: values.evidence ?? [],
        when: values.when,
        supersedes: values.supersedes,
      }));
    }
    if (command === 'skill' && action === 'retire') {
      return print(draftSkillRetirement({
        entry: requireText(args[0], 'Skill entry path'),
        retire: args.slice(1),
        sources: values.evidence ?? [],
        reason: values.reason,
      }));
    }
    if (command === 'skill' && action === 'learnings') {
      return print(skillLearningUsage(root, requireText(args[0], 'Skill entry path')));
    }
    if (command === 'skill' && action === 'replay') {
      const draft: unknown = JSON.parse(readFileSync(requireText(args[0], 'draft file'), 'utf8').replace(/^\uFEFF/, ''));
      const scenarios: unknown = JSON.parse(readFileSync(requireText(values.scenarios, 'scenarios file'), 'utf8').replace(/^\uFEFF/, ''));
      return print(replaySkillAddition(root, draft, { runner: requireText(values.runner, 'replay runner'), scenarios }));
    }
    if (command === 'skill' && (action === 'apply' || action === 'rollback')) {
      return print(changeSkillVersion(root, requireText(args[0], 'replay receipt ID'), action === 'rollback'));
    }
    if (command === 'skill' && action === 'design') {
      const [designAction, ...designArgs] = args;
      if (designAction === 'task') return print(readSkillDesignTask(root, requireText(designArgs[0], 'Skill design task ID')));
      if (designAction === 'run') return print(runSkillDesign(root, requireText(designArgs[0], 'Skill design task ID'), requireText(values.runner, 'design runner')));
      if (designAction === 'review') return print(reviewSkillDesign(root, requireText(designArgs[0], 'Skill design receipt ID')));
      if (designAction === 'replay') {
        const scenarios: unknown = JSON.parse(readFileSync(requireText(values.scenarios, 'scenarios file'), 'utf8').replace(/^\uFEFF/, ''));
        return print(replaySkillDesign(root, requireText(designArgs[0], 'Skill design receipt ID'), {
          runner: requireText(values.runner, 'replay runner'), scenarios,
        }));
      }
      if (designAction === 'apply' || designAction === 'rollback') {
        return print(applySkillDesign(root, requireText(designArgs[0], 'Skill design receipt ID'), designAction === 'rollback'));
      }
    }
    throw new InputError(`Unknown command. Run ${invocation} --help`);
  } finally {
    activeKnowledge?.memory?.close?.();
    for (const memory of stores) memory.close();
  }
}
