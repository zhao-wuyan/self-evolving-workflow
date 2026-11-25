import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildSessionSignalPrompt } from './agent-memory-prompts.js';
import {
  evolvePath, InputError, LEGACY_AGENT_MEMORY_DIR, openDb, pageOffset, pagination,
  resolveEvolveStorage, searchLimit, transaction,
} from './common.js';
import { defaultMemoryDbPath, extractMemoryInputs, MemoryStore, type ConversationMessage } from './memory.js';
import type { MemoryHost } from './memory-config.js';
import {
  discoverHostTranscripts, parseSinceMs, readHostHistoryEntries,
  type HistoryEntry, type HostTranscriptRef,
} from './memory-history.js';
import type { LlmClient } from './upstream/llm.js';
import { readWikiPages, Wiki } from './wiki.js';
import { readEvolveSessions, sessionEvolveSignals, workflowDbPath } from './workflow-runtime.js';

export type SignalSourceKind = 'transcript' | 'memory' | 'wiki' | 'llm';

export interface CollectedSignalRecord {
  id: string;
  source_kind: SignalSourceKind;
  host: string;
  session: string;
  anchor: string;
  signal_type: string;
  summary: string;
  snippet: string;
  skill_id?: string;
  timestamp: string;
  evidence: string[];
  created_at: string;
}

export interface HistoryCursorRecord {
  host: string;
  session: string;
  path: string;
  byte_offset: number;
  file_size: number;
  mtime_ms: number;
  updated_at: string;
  signal_count: number;
}

const SKILL_MENTION_RE = /\b(ew-(?:[a-z0-9]+-)*[a-z0-9]+|workflow-evolve)\b|skills\/([a-z0-9-]+)\//i;

export function historySignalsDbPath(root: string): string {
  return evolvePath(root, 'history-signals.db');
}

function openSignalsDb(root: string, readOnly = false) {
  const path = historySignalsDbPath(root);
  if (readOnly && !existsSync(path)) return undefined;
  if (!readOnly) mkdirSync(dirname(path), { recursive: true });
  const db = openDb(path, readOnly);
  if (!readOnly) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS history_cursors (
        host TEXT NOT NULL,
        session TEXT NOT NULL,
        path TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        file_size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (host, session)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_cursors (
        source_key TEXT PRIMARY KEY,
        version_token TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS history_signals (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        host TEXT NOT NULL,
        session TEXT NOT NULL,
        anchor TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        snippet TEXT NOT NULL,
        skill_id TEXT,
        timestamp TEXT NOT NULL,
        evidence TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_history_signals_session ON history_signals (host, session, timestamp);
      CREATE INDEX IF NOT EXISTS idx_history_signals_kind ON history_signals (source_kind, signal_type, timestamp);
    `);
  }
  return db;
}

function stableSignalId(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

function projectSkillIdSet(root: string): Set<string> {
  const ids = new Set<string>();
  const skillsDir = join(root, 'skills');
  if (!existsSync(skillsDir)) return ids;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(skillsDir, entry.name, 'SKILL.md'))) ids.add(entry.name.toLowerCase());
    if (entry.name === 'ew-orchestrate') {
      const stepsDir = join(skillsDir, 'ew-orchestrate', 'steps');
      if (existsSync(stepsDir)) {
        for (const step of readdirSync(stepsDir, { withFileTypes: true })) {
          if (step.isDirectory() && existsSync(join(stepsDir, step.name, 'SKILL.md'))) {
            ids.add(step.name.toLowerCase());
          }
        }
      }
    }
  }
  return ids;
}

function detectSkillMention(text: string, knownSkills?: ReadonlySet<string>): string | undefined {
  let bestIndex = Infinity;
  let bestId: string | undefined;
  const consider = (id: string | undefined, idx: number) => {
    if (!id || idx < 0 || idx >= bestIndex) return;
    bestIndex = idx;
    bestId = id.toLowerCase();
  };
  const builtin = SKILL_MENTION_RE.exec(text);
  if (builtin) consider(builtin[1] ?? builtin[2], builtin.index);
  if (knownSkills?.size) {
    const lower = text.toLowerCase();
    for (const id of knownSkills) {
      const idx = lower.indexOf(id);
      if (idx < 0 || idx >= bestIndex) continue;
      const before = idx === 0 ? ' ' : lower[idx - 1];
      const after = idx + id.length >= lower.length ? ' ' : lower[idx + id.length];
      if (!/[a-z0-9_-]/.test(before) && !/[a-z0-9_-]/.test(after)) {
        consider(id, idx);
      }
    }
  }
  return bestId;
}

function clipSummary(text: string, max = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : normalized.slice(0, max - 1) + '…';
}

function clipSnippet(text: string, max = 300): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : normalized.slice(0, max - 1) + '…';
}

function toTranscriptSignalRows(entries: HistoryEntry[], knownSkills?: ReadonlySet<string>): CollectedSignalRecord[] {
  const now = new Date().toISOString();
  const rows: CollectedSignalRecord[] = [];
  for (const entry of entries) {
    const skillId = detectSkillMention(entry.content, knownSkills);
    const types = [...entry.signals];
    if (entry.role === 'error' && !types.includes('tool_or_runtime_error')) types.push('tool_or_runtime_error');
    if (skillId && !types.length && entry.kind === 'tool_call') types.push('skill_invocation');
    if (!types.length) continue;
    for (const signalType of types) {
      rows.push({
        id: stableSignalId(['transcript', entry.host, entry.session, entry.id, signalType]),
        source_kind: 'transcript',
        host: entry.host,
        session: entry.session,
        anchor: entry.id,
        signal_type: signalType,
        summary: clipSummary(entry.content),
        snippet: clipSnippet(entry.content),
        ...(skillId ? { skill_id: skillId } : {}),
        timestamp: entry.timestamp,
        evidence: [entry.id],
        created_at: now,
      });
    }
  }
  return rows;
}

function upsertSignals(
  db: NonNullable<ReturnType<typeof openSignalsDb>>,
  rows: CollectedSignalRecord[],
): number {
  if (!rows.length) return 0;
  const stmt = db.prepare(`
    INSERT INTO history_signals (
      id, source_kind, host, session, anchor, signal_type, summary, snippet, skill_id, timestamp, evidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      summary = excluded.summary,
      snippet = excluded.snippet,
      skill_id = excluded.skill_id,
      timestamp = excluded.timestamp,
      evidence = excluded.evidence
  `);
  let inserted = 0;
  for (const row of rows) {
    const changes = stmt.run(
      row.id,
      row.source_kind,
      row.host,
      row.session,
      row.anchor,
      row.signal_type,
      row.summary,
      row.snippet,
      row.skill_id ?? null,
      row.timestamp,
      JSON.stringify(row.evidence),
      row.created_at,
    ).changes;
    if (changes > 0) inserted += 1;
  }
  return inserted;
}

function readSourceCursor(
  db: NonNullable<ReturnType<typeof openSignalsDb>>,
  key: string,
): string | undefined {
  const row = db.prepare('SELECT version_token FROM source_cursors WHERE source_key = ?').get(key) as
    | { version_token: string }
    | undefined;
  return row?.version_token;
}

function writeSourceCursor(
  db: NonNullable<ReturnType<typeof openSignalsDb>>,
  key: string,
  token: string,
): void {
  db.prepare(`
    INSERT INTO source_cursors (source_key, version_token, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET version_token = excluded.version_token, updated_at = excluded.updated_at
  `).run(key, token, new Date().toISOString());
}

function collectMemorySignals(
  root: string,
  db: NonNullable<ReturnType<typeof openSignalsDb>>,
  knownSkills?: ReadonlySet<string>,
): {
  checked: number;
  skipped: number;
  collected: number;
} {
  const memPath = defaultMemoryDbPath(root);
  if (!existsSync(memPath)) return { checked: 0, skipped: 0, collected: 0 };
  const store = new MemoryStore(memPath, { readOnly: true });
  let checked = 0;
  let skipped = 0;
  let collected = 0;
  try {
    const relevantTypes = new Set(['correction', 'error', 'verified_fix', 'work_method', 'workflow_issue']);
    const pendingRows: CollectedSignalRecord[] = [];
    const cursorUpdates: Array<[string, string]> = [];
    for (let page = 1; ; page++) {
      const batch = store.list({ limit: 100, page });
      for (const record of batch.results) {
        if (!relevantTypes.has(record.type)) continue;
        checked += 1;
        const cursorKey = `memory:${record.id}`;
        const token = `${record.version}:${record.updatedAt}`;
        if (readSourceCursor(db, cursorKey) === token) {
          skipped += 1;
          continue;
        }
        const skillId = detectSkillMention(`${record.scene ?? ''} ${record.content}`, knownSkills);
        pendingRows.push({
          id: stableSignalId(['memory', record.id]),
          source_kind: 'memory',
          host: 'memory',
          session: record.session ?? 'standalone',
          anchor: `memory:${record.id}`,
          signal_type: record.type,
          summary: clipSummary(record.content),
          snippet: clipSnippet(record.content),
          ...(skillId ? { skill_id: skillId } : {}),
          timestamp: record.updatedAt,
          evidence: record.sourceMessageIds.length ? record.sourceMessageIds : [`memory:${record.id}`],
          created_at: new Date().toISOString(),
        });
        cursorUpdates.push([cursorKey, token]);
      }
      if (!batch.pagination || batch.pagination.nextPage === null) break;
    }
    if (pendingRows.length) {
      transaction(db, () => {
        collected += upsertSignals(db, pendingRows);
        for (const [key, token] of cursorUpdates) writeSourceCursor(db, key, token);
      });
    }
  } finally {
    store.close();
  }
  return { checked, skipped, collected };
}

function collectWikiAndSessionSignals(
  root: string,
  db: NonNullable<ReturnType<typeof openSignalsDb>>,
  knownSkills?: ReadonlySet<string>,
): {
  checked: number;
  skipped: number;
  collected: number;
} {
  let checked = 0;
  let skipped = 0;
  let collected = 0;
  const now = new Date().toISOString();
  const pendingRows: CollectedSignalRecord[] = [];
  const cursorUpdates: Array<[string, string]> = [];

  const wiki = new Wiki(root);
  if (wiki.hasWiki()) {
    for (const page of readWikiPages(root)) {
      const needsAttention = page.entry?.status === 'needs_review' ||
        page.entry?.confidence === 'contested' ||
        Boolean(page.entry?.conflictsWith?.length);
      if (!needsAttention) continue;
      checked += 1;
      const token = createHash('sha256').update(JSON.stringify([
        page.entry?.status, page.entry?.confidence, page.entry?.conflictsWith, page.body,
      ])).digest('hex').slice(0, 16);
      const cursorKey = `wiki:${page.id}`;
      if (readSourceCursor(db, cursorKey) === token) {
        skipped += 1;
        continue;
      }
      const signalType = page.entry?.conflictsWith?.length || page.entry?.confidence === 'contested'
        ? 'wiki_conflict'
        : 'wiki_needs_review';
      const skillId = detectSkillMention(`${page.title} ${page.body}`, knownSkills);
      pendingRows.push({
        id: stableSignalId(['wiki', page.id, signalType]),
        source_kind: 'wiki',
        host: 'wiki',
        session: 'wiki',
        anchor: page.id,
        signal_type: signalType,
        summary: clipSummary(`${page.title}: ${page.body}`),
        snippet: clipSnippet(page.body),
        ...(skillId ? { skill_id: skillId } : {}),
        timestamp: now,
        evidence: page.sources.length ? page.sources : [page.id],
        created_at: now,
      });
      cursorUpdates.push([cursorKey, token]);
    }
  }

  if (existsSync(workflowDbPath(root))) {
    for (const session of readEvolveSessions(root)) {
      checked += 1;
      const cursorKey = `evolve-session:${session.id}`;
      const token = `${session.revision}:${session.status}`;
      if (readSourceCursor(db, cursorKey) === token) {
        skipped += 1;
        continue;
      }
      const evolveSignals = sessionEvolveSignals(session);
      for (const sig of evolveSignals) {
        const affectedRun = session.runs.find(run =>
          (sig === 'run_retry' && Boolean(run.retry_of_run_id)) ||
          (sig === 'non_clean_run' && ['failed', 'blocked', 'cancelled'].includes(run.status)) ||
          (sig === 'done_with_concerns' && run.verdict === 'done_with_concerns') ||
          sig === 'empty_knowledge_reads');
        const skillId = affectedRun?.skill.skill_id;
        pendingRows.push({
          id: stableSignalId(['evolve-session', session.id, sig]),
          source_kind: 'wiki',
          host: 'evolve',
          session: session.id,
          anchor: affectedRun ? `evolve:${session.id}#${affectedRun.id}` : `evolve:${session.id}`,
          signal_type: sig,
          summary: clipSummary(`${session.objective} (${sig}${affectedRun ? `: ${affectedRun.task.command} ${affectedRun.status}` : ''})`),
          snippet: clipSnippet(affectedRun?.summary ?? session.objective),
          ...(skillId ? { skill_id: skillId } : {}),
          timestamp: affectedRun?.finished_at ?? session.completed_at ?? session.created_at,
          evidence: [affectedRun ? `evolve:${session.id}#${affectedRun.id}` : `evolve:${session.id}`],
          created_at: now,
        });
      }
      // 读取 Run 已落盘的 retrospective.json 洞察（若存在）。
      for (const run of session.runs) {
        const retroPath = resolveEvolveStorage(
          root,
          ['runs', session.id, run.id, 'outputs', 'retrospective.json'],
          join(resolve(root), LEGACY_AGENT_MEMORY_DIR, 'workflow', 'runs', session.id, run.id, 'outputs', 'retrospective.json'),
        );
        if (!existsSync(retroPath)) continue;
        try {
          const retro = JSON.parse(readFileSync(retroPath, 'utf8')) as {
            insights?: Array<{ id?: string; lens?: string; summary?: string; route?: string; evidence?: string[] }>;
          };
          for (const insight of retro.insights ?? []) {
            if (!insight.id || !insight.summary || insight.route === 'none' || insight.route === 'skipped') continue;
            const skillId = detectSkillMention(insight.summary, knownSkills);
            pendingRows.push({
              id: stableSignalId(['retrospective', session.id, insight.id]),
              source_kind: 'wiki',
              host: 'evolve',
              session: session.id,
              anchor: `retro:${session.id}:${run.id}#${insight.id}`,
              signal_type: `retro_${insight.route ?? 'insight'}`,
              summary: clipSummary(`[${insight.lens ?? 'retro'}] ${insight.summary}`),
              snippet: clipSnippet(insight.summary),
              ...(skillId ? { skill_id: skillId } : {}),
              timestamp: run.finished_at ?? session.completed_at ?? now,
              evidence: Array.isArray(insight.evidence) && insight.evidence.length ? insight.evidence : [`evolve:${session.id}#${run.id}`],
              created_at: now,
            });
          }
        } catch {
          // 忽略损坏的 retrospective 输出。
        }
      }
      cursorUpdates.push([cursorKey, token]);
    }
  }

  if (pendingRows.length || cursorUpdates.length) {
    transaction(db, () => {
      collected += upsertSignals(db, pendingRows);
      for (const [key, token] of cursorUpdates) writeSourceCursor(db, key, token);
    });
  }
  return { checked, skipped, collected };
}

async function collectIncrementalLlmSignals(
  ref: HostTranscriptRef,
  entries: HistoryEntry[],
  lastOffset: number,
  db: NonNullable<ReturnType<typeof openSignalsDb>>,
  model: () => LlmClient,
  knownSkills?: ReadonlySet<string>,
): Promise<number> {
  const cursorKey = `llm-v2:${ref.host}:${ref.session}`;
  const messages: ConversationMessage[] = entries
    .filter(item => item.kind === 'message' || item.role === 'error')
    .map(item => ({
      id: item.id,
      role: item.role === 'error' ? 'tool' : item.role === 'user' ? 'user' : 'assistant',
      timestamp: item.timestamp,
      content: item.content,
    }));
  const rows: CollectedSignalRecord[] = [];
  // Process all messages in bounded batches, not just the last 40.
  for (let start = 0; start < messages.length; start += 40) {
    const batch = messages.slice(start, start + 40);
    const extracted = await extractMemoryInputs(batch, {
      llm: model(), session: ref.session, agentMemoryPrompt: buildSessionSignalPrompt(),
    });
    const now = new Date().toISOString();
    for (const item of extracted) {
      if (!item.id || !item.sourceMessageIds?.length) continue;
      const skillId = detectSkillMention(item.content, knownSkills);
      rows.push({
        id: stableSignalId(['llm', ref.host, ref.session, item.id]),
        source_kind: 'llm', host: ref.host, session: ref.session,
        anchor: item.sourceMessageIds[0], signal_type: item.type ?? 'workflow_issue',
        summary: clipSummary(item.content), snippet: clipSnippet(item.content),
        ...(skillId ? { skill_id: skillId } : {}),
        timestamp: batch.at(-1)!.timestamp as string, evidence: item.sourceMessageIds, created_at: now,
      });
    }
  }
  return transaction(db, () => {
    const count = upsertSignals(db, rows);
    writeSourceCursor(db, cursorKey, JSON.stringify({ path: ref.path, offset: lastOffset, size: ref.size, mtime: ref.mtimeMs }));
    return count;
  });
}

interface TranscriptCursor { path: string; offset: number; size: number; mtime: number }

function pendingOffset(ref: HostTranscriptRef, cursor?: TranscriptCursor): number | undefined {
  if (!cursor || cursor.path !== ref.path || cursor.size > ref.size ||
      (cursor.size === ref.size && cursor.mtime !== ref.mtimeMs)) return 0;
  return cursor.offset >= ref.size ? undefined : cursor.offset;
}

export async function collectHistorySignals(options: {
  root: string;
  hosts?: readonly MemoryHost[];
  session?: string;
  sources?: readonly SignalSourceKind[];
  allProjects?: boolean;
  llm?: () => LlmClient;
}) {
  const sources = new Set<SignalSourceKind>(
    options.sources?.length ? options.sources : ['transcript', 'memory', 'wiki'],
  );
  const knownSkills = projectSkillIdSet(options.root);
  const db = openSignalsDb(options.root, false)!;
  const stats = {
    sessions_checked: 0,
    sessions_incremental: 0,
    sessions_skipped: 0,
    new_signals: 0,
    by_source: {
      transcript: 0,
      memory: 0,
      wiki: 0,
      llm: 0,
    },
    failures: [] as Array<{ host: string; session: string; error: string }>,
  };
  try {
    if (sources.has('transcript') || sources.has('llm')) {
      const refs = await discoverHostTranscripts(options.root, {
        hosts: options.hosts,
        session: options.session,
        allProjects: options.allProjects,
      });
      const getCursor = db.prepare('SELECT path, byte_offset, file_size, mtime_ms FROM history_cursors WHERE host = ? AND session = ?');
      const setCursor = db.prepare(`
        INSERT INTO history_cursors (host, session, path, byte_offset, file_size, mtime_ms, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(host, session) DO UPDATE SET
          path = excluded.path, byte_offset = excluded.byte_offset, file_size = excluded.file_size,
          mtime_ms = excluded.mtime_ms, updated_at = excluded.updated_at
      `);
      for (const ref of refs) {
        stats.sessions_checked += 1;
        const cursor = getCursor.get(ref.host, ref.session) as
          | { path: string; byte_offset: number; file_size: number; mtime_ms: number }
          | undefined;
        const transcriptOffset = sources.has('transcript') ? pendingOffset(ref, cursor && {
          path: cursor.path, offset: cursor.byte_offset, size: cursor.file_size, mtime: cursor.mtime_ms,
        }) : undefined;
        const llmToken = readSourceCursor(db, `llm-v2:${ref.host}:${ref.session}`);
        const llmCursor = llmToken ? JSON.parse(llmToken) as TranscriptCursor : undefined;
        const llmOffset = sources.has('llm') && options.llm ? pendingOffset(ref, llmCursor) : undefined;
        if (transcriptOffset === undefined && llmOffset === undefined) {
          stats.sessions_skipped += 1;
          continue;
        }
        const reads = new Map<number, Awaited<ReturnType<typeof readHostHistoryEntries>>>();
        const read = async (offset: number) => {
          const cached = reads.get(offset);
          if (cached) return cached;
          const result = await readHostHistoryEntries(ref, { fromOffset: offset, includeTools: true });
          reads.set(offset, result);
          return result;
        };
        let advanced = false;
        const failed = (error: unknown) => stats.failures.push({
          host: ref.host, session: ref.session, error: error instanceof Error ? error.message : String(error),
        });
        if (transcriptOffset !== undefined) {
          try {
            const { entries, lastOffset } = await read(transcriptOffset);
            const rows = toTranscriptSignalRows(entries, knownSkills);
            const added = transaction(db, () => {
              const count = upsertSignals(db, rows);
              setCursor.run(ref.host, ref.session, ref.path, lastOffset, ref.size, ref.mtimeMs, new Date().toISOString());
              return count;
            });
            stats.by_source.transcript += added;
            stats.new_signals += added;
            advanced ||= lastOffset > transcriptOffset;
          } catch (error) { failed(error); }
        }
        if (llmOffset !== undefined && options.llm) {
          try {
            const { entries, lastOffset } = await read(llmOffset);
            const added = await collectIncrementalLlmSignals(ref, entries, lastOffset, db, options.llm, knownSkills);
            stats.by_source.llm += added;
            stats.new_signals += added;
            advanced ||= lastOffset > llmOffset;
          } catch (error) { failed(error); }
        }
        if (advanced) stats.sessions_incremental += 1;
        else stats.sessions_skipped += 1;
      }    }

    if (sources.has('memory')) {
      const memStats = collectMemorySignals(options.root, db, knownSkills);
      stats.by_source.memory += memStats.collected;
      stats.new_signals += memStats.collected;
    }

    if (sources.has('wiki')) {
      const wikiStats = collectWikiAndSessionSignals(options.root, db, knownSkills);
      stats.by_source.wiki += wikiStats.collected;
      stats.new_signals += wikiStats.collected;
    }

    return stats;
  } finally {
    db.close();
  }
}

export function readHistoryCursorMap(root: string): Map<string, HistoryCursorRecord> {
  const map = new Map<string, HistoryCursorRecord>();
  const db = openSignalsDb(root, true);
  if (!db) return map;
  try {
    const cursors = db.prepare('SELECT host, session, path, byte_offset, file_size, mtime_ms, updated_at FROM history_cursors').all() as Array<{
      host: string; session: string; path: string; byte_offset: number; file_size: number; mtime_ms: number; updated_at: string;
    }>;
    const counts = db.prepare('SELECT host, session, COUNT(*) AS cnt FROM history_signals GROUP BY host, session').all() as Array<{
      host: string; session: string; cnt: number;
    }>;
    const countMap = new Map(counts.map(row => [`${row.host}:${row.session}`, Number(row.cnt)]));
    for (const row of cursors) {
      map.set(`${row.host}:${row.session}`, {
        ...row,
        signal_count: countMap.get(`${row.host}:${row.session}`) ?? 0,
      });
    }
    return map;
  } finally {
    db.close();
  }
}

function signalMatchesRoles(signalType: string, anchor: string, roles?: readonly string[]): boolean {
  if (!roles?.length) return true;
  for (const role of roles) {
    if (role === 'error' && (
      signalType === 'tool_or_runtime_error' || signalType === 'non_clean_run' ||
      signalType === 'error' || anchor.endsWith(':error')
    )) return true;
    if (role === 'tool' && (
      signalType === 'skill_invocation' || anchor.includes(':tool:') ||
      anchor.endsWith(':call') || anchor.endsWith(':out') || anchor.includes(':result:')
    )) return true;
    if (role === 'user' && (signalType === 'user_correction' || signalType === 'correction')) return true;
    if (role === 'assistant' && (signalType === 'verified_fix' || signalType === 'work_method')) return true;
  }
  return false;
}

export function queryCollectedSignals(root: string, options: {
  query?: string;
  regex?: boolean;
  hosts?: readonly string[];
  session?: string;
  sourceKinds?: readonly SignalSourceKind[];
  signalTypes?: readonly string[];
  roles?: readonly string[];
  skill?: string;
  since?: string;
  limit?: number;
  page?: number;
} = {}) {
  const limit = searchLimit(options.limit ?? 20);
  const page = options.page ?? 1;
  const offset = pageOffset(page, limit);
  const sinceMs = parseSinceMs(options.since);
  const db = openSignalsDb(root, true);
  if (!db) {
    return { total: 0, results: [] as CollectedSignalRecord[], pagination: pagination(page, limit, false) };
  }
  try {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.session) {
      where.push('session = ?');
      params.push(options.session);
    }
    if (options.hosts?.length) {
      where.push(`host IN (${options.hosts.map(() => '?').join(',')})`);
      params.push(...options.hosts);
    }
    if (options.sourceKinds?.length) {
      where.push(`source_kind IN (${options.sourceKinds.map(() => '?').join(',')})`);
      params.push(...options.sourceKinds);
    }
    if (options.signalTypes?.length) {
      where.push(`signal_type IN (${options.signalTypes.map(() => '?').join(',')})`);
      params.push(...options.signalTypes);
    }
    if (options.skill) {
      where.push('(lower(coalesce(skill_id, \'\')) = ? OR lower(summary) LIKE ? OR lower(snippet) LIKE ?)');
      const s = options.skill.trim().toLowerCase();
      params.push(s, `%${s}%`, `%${s}%`);
    }
    const sql = `SELECT id, source_kind, host, session, anchor, signal_type, summary, snippet, skill_id, timestamp, evidence, created_at
      FROM history_signals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY timestamp DESC, id ASC`;
    const all = db.prepare(sql).all(...params) as Array<{
      id: string; source_kind: SignalSourceKind; host: string; session: string; anchor: string;
      signal_type: string; summary: string; snippet: string; skill_id: string | null;
      timestamp: string; evidence: string; created_at: string;
    }>;

    const queryText = options.query?.trim() ?? '';
    let regex: RegExp | undefined;
    if (queryText && options.regex) {
      try {
        regex = new RegExp(queryText, 'i');
      } catch {
        throw new InputError(`Invalid search regex: ${queryText}`);
      }
    }
    const needle = queryText.toLowerCase();

    const filtered: CollectedSignalRecord[] = [];
    for (const row of all) {
      if (!signalMatchesRoles(row.signal_type, row.anchor, options.roles)) continue;
      if (sinceMs !== undefined) {
        const ts = Date.parse(row.timestamp);
        if (Number.isFinite(ts) && ts < sinceMs) continue;
      }
      if (queryText) {
        const haystack = `${row.summary}\n${row.snippet}\n${row.signal_type}\n${row.skill_id ?? ''}`;
        if (regex ? !regex.test(haystack) : !haystack.toLowerCase().includes(needle)) continue;
      }
      filtered.push({
        id: row.id,
        source_kind: row.source_kind,
        host: row.host,
        session: row.session,
        anchor: row.anchor,
        signal_type: row.signal_type,
        summary: row.summary,
        snippet: row.snippet,
        ...(row.skill_id ? { skill_id: row.skill_id } : {}),
        timestamp: row.timestamp,
        evidence: JSON.parse(row.evidence) as string[],
        created_at: row.created_at,
      });
    }
    const paged = filtered.slice(offset, offset + limit);
    return {
      total: filtered.length,
      results: paged,
      pagination: pagination(page, limit, offset + limit < filtered.length),
    };
  } finally {
    db.close();
  }
}
