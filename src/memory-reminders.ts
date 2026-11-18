import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { evolvePath, InputError, openDb } from './common.js';
import { memoryModelSettings, type MemoryHost } from './memory-config.js';
import { withMemoryFileTransaction } from './memory-file-lock.js';
import { readMemoryHookJobs } from './memory-hook-jobs.js';
import type { ConversationMessage } from './memory.js';
import { closeoutDbPath } from './wiki-change.js';
import { evolveSessionReceipt, readEvolveSessions, sessionEvolveSignals } from './workflow-runtime.js';

export type ReminderKind = 'evolve_signal' | 'closeout_candidate';

export interface MemoryReminder {
  id: string;
  kind: ReminderKind;
  session_id: string;
  host?: MemoryHost;
  summary: string;
  signals: string[];
  evidence_ids: string[];
  recommended_command: string;
  created_at: string;
  acknowledged?: boolean;
}

interface ReminderStoreFile {
  schema_version: 'evolve-reminders/1.0';
  items: MemoryReminder[];
}

export interface UnharvestedSession {
  id: string;
  completed_at: string;
  has_evolve_signals: boolean;
  evolve_signals: string[];
  closeout_command: string;
  review_command: string;
}

const MAX_ACTIVE_REMINDERS = 20;
const CORRECTION_PATTERN = /(?:不对|不是这样|搞错了|做错了|不要再|别再|重新来|为什么还是|没生效|漏掉了|你忘了|\b(?:wrong|incorrect|stop doing|instead|still failing|not working|forgot to|missed)\b)/i;
const ERROR_PATTERN = /(?:SyntaxError|TypeError|ReferenceError|ENOENT|SQLITE_|unable to open database|timed out|HTTP 5\d\d|\bexit(?:ed)? with code [1-9])/i;
const CLOSEOUT_PATTERN = /(?:修复了|已解决|根因|真正原因|最佳实践|约束|规范|教训|踩坑|\b(?:root cause|workaround|invariant|fixed the|lesson learned)\b)/i;

export function remindersPath(root: string): string {
  return evolvePath(root, 'pending-reminders.json');
}

function loadStore(root: string): ReminderStoreFile {
  const path = remindersPath(root);
  if (!existsSync(path)) return { schema_version: 'evolve-reminders/1.0', items: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Partial<ReminderStoreFile>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
      throw new InputError(`Invalid reminders file: ${path}`);
    }
    return { schema_version: 'evolve-reminders/1.0', items: parsed.items };
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`Invalid JSON in ${path}`);
  }
}

function saveStore(root: string, store: ReminderStoreFile): void {
  const path = remindersPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(store, null, 2) + '\n', { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function summarize(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > 120 ? singleLine.slice(0, 117) + '...' : singleLine;
}

function stableId(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/**
 * 确定性扫描单批对话中的纠正、重复失败与沉淀候选信号，不依赖 LLM 响应。
 */
export function recordConversationSignals(
  root: string,
  params: { host: MemoryHost; session: string; messages: ConversationMessage[]; errorCount?: number },
): MemoryReminder[] {
  const { host, session, messages, errorCount = 0 } = params;
  if (!messages.length && errorCount < 2) return [];
  const corrections = messages.filter(item => item.role === 'user' && CORRECTION_PATTERN.test(item.content));
  const errors = messages.filter(item => item.role !== 'user' && ERROR_PATTERN.test(item.content));
  const closeouts = messages.filter(item => item.content.trim().length >= 25 && CLOSEOUT_PATTERN.test(item.content));

  const created: MemoryReminder[] = [];
  const now = new Date().toISOString();

  if (corrections.length > 0 || errorCount >= 2 || (errors.length > 0 && messages.length >= 2)) {
    const signals = [
      ...(corrections.length > 0 ? ['user_correction'] : []),
      ...(errorCount >= 2 || errors.length > 0 ? ['tool_or_runtime_error'] : []),
    ];
    const evidence = [...corrections, ...errors].slice(0, 4);
    const id = stableId(['evolve_signal', host, session, ...signals, ...evidence.map(item => item.id)]);
    const anchor = evidence[0]?.content ?? `${errorCount} error steps recorded`;
    created.push({
      id,
      kind: 'evolve_signal',
      session_id: session,
      host,
      summary: summarize(anchor),
      signals,
      evidence_ids: evidence.map(item => item.id),
      recommended_command: `evolve kb harvest conversation ${session} --host ${host} --project <project-id>`,
      created_at: now,
    });
  }

  if (closeouts.length > 0) {
    const evidence = closeouts.slice(0, 4);
    const id = stableId(['closeout_candidate', host, session, ...evidence.map(item => item.id)]);
    created.push({
      id,
      kind: 'closeout_candidate',
      session_id: session,
      host,
      summary: summarize(evidence[0].content),
      signals: ['reusable_finding'],
      evidence_ids: evidence.map(item => item.id),
      recommended_command: `evolve kb harvest conversation ${session} --host ${host} --project <project-id>`,
      created_at: now,
    });
  }

  if (!created.length) return [];
  return withMemoryFileTransaction(remindersPath(root), () => {
    const store = loadStore(root);
    const existingIds = new Set(store.items.map(item => item.id));
    const fresh = created.filter(item => !existingIds.has(item.id));
    if (!fresh.length) return [];

    const merged = [...store.items, ...fresh];
    const active = merged.filter(item => !item.acknowledged).slice(-MAX_ACTIVE_REMINDERS);
    const acked = merged.filter(item => item.acknowledged).slice(-MAX_ACTIVE_REMINDERS);
    saveStore(root, { schema_version: 'evolve-reminders/1.0', items: [...acked, ...active] });
    return fresh;
  });
}

export function readReminders(root: string, includeAcked = false): MemoryReminder[] {
  const { items } = loadStore(root);
  return (includeAcked ? items : items.filter(item => !item.acknowledged)).map(item => ({
    ...item,
    recommended_command: item.recommended_command.replace(/^evolve closeout conversation /, 'evolve kb harvest conversation '),
  }));
}

export function acknowledgeReminders(root: string, id?: string): { acknowledged: number; remaining: number } {
  return withMemoryFileTransaction(remindersPath(root), () => {
    const store = loadStore(root);
    let acknowledged = 0;
    for (const item of store.items) {
      if (!item.acknowledged && (id === undefined || item.id === id)) {
        item.acknowledged = true;
        acknowledged++;
      }
    }
    if (acknowledged > 0) saveStore(root, store);
    return {
      acknowledged,
      remaining: store.items.filter(item => !item.acknowledged).length,
    };
  });
}

/**
 * 以只读方式扫描已完成但尚未进入 closeout.db 收获账本的 Evolve Session。
 */
export function findUnharvestedSessions(root: string): UnharvestedSession[] {
  const completed = readEvolveSessions(root).filter(session => session.status === 'completed');
  if (!completed.length) return [];

  const harvestedReceipts = new Set<string>();
  const harvestedSessions = new Set<string>();
  const ledger = closeoutDbPath(root);
  if (existsSync(ledger)) {
    const db = openDb(ledger, true);
    try {
      const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'closeouts'").get();
      if (hasTable) {
        const columns = new Set(
          (db.prepare('PRAGMA table_info(closeouts)').all() as Array<{ name: string }>).map(col => col.name),
        );
        if (columns.has('session_id') && columns.has('receipt_id')) {
          const rows = db.prepare('SELECT session_id, receipt_id FROM closeouts').all() as Array<{
            session_id?: string | null;
            receipt_id?: string | null;
          }>;
          for (const row of rows) {
            if (row.session_id) harvestedSessions.add(row.session_id);
            if (row.receipt_id) harvestedReceipts.add(row.receipt_id);
          }
        }
      }
    } finally {
      db.close();
    }
  }

  return completed.flatMap(session => {
    const receipt = evolveSessionReceipt(session);
    if (harvestedSessions.has(session.id) || harvestedReceipts.has(receipt.id)) return [];
    const evolveSignals = sessionEvolveSignals(session);
    return [{
      id: session.id,
      completed_at: session.completed_at ?? session.created_at,
      has_evolve_signals: evolveSignals.length > 0,
      evolve_signals: evolveSignals,
      closeout_command: `evolve kb harvest session ${session.id} --project <project-id>`,
      review_command: `evolve session review ${session.id}`,
    }];
  });
}

export function buildSessionStartNotice(root: string, host: MemoryHost): string | undefined {
  const reminders = readReminders(root);
  const unharvested = findUnharvestedSessions(root);
  const model = memoryModelSettings(root);
  const hasModel = Boolean(model.baseUrl && model.model);
  const lines: string[] = [];
  const jobs = readMemoryHookJobs(root);
  const failedJobs = jobs.filter(job => job.state === 'failed');
  const activeJobs = jobs.filter(job => job.state === 'pending' || job.state === 'running');

  if (failedJobs.length > 0) {
    const summary = failedJobs.slice(-3).map(job => `[${job.session}] ${summarize(job.last_error ?? 'Extraction failed')}`).join(' | ');
    lines.push(`- Memory extraction failed (${failedJobs.length}): ${summary}. Inspect \`evolve kb hook-jobs\`, then retry with \`evolve kb hook-jobs retry\`.`);
  }
  if (activeJobs.length > 0) {
    lines.push(`- Memory extraction pending or running (${activeJobs.length}). Inspect progress with \`evolve kb hook-jobs\`.`);
  }

  const evolveReminders = reminders.filter(item => item.kind === 'evolve_signal').slice(-3);
  const closeoutReminders = reminders.filter(item => item.kind === 'closeout_candidate').slice(-3);

  if (unharvested.length > 0) {
    const summary = unharvested.slice(0, 3).map(item =>
      item.has_evolve_signals ? `${item.id} (${item.evolve_signals.join(', ')})` : item.id,
    ).join('; ');
    lines.push(`- Pending Evolve session closeout (${unharvested.length}): ${summary}. Run \`evolve kb harvest session <id> --project <project-id>\`${unharvested.some(s => s.has_evolve_signals) ? ' and `evolve session review <id>` (`workflow-evolve`)' : ''}.`);
  }
  if (evolveReminders.length > 0) {
    lines.push(`- Self-evolution signals (${evolveReminders.length}): ${evolveReminders.map(item => `[${item.session_id}] ${item.summary}`).join(' | ')}. Consider invoking \`workflow-evolve\` or reviewing the affected Skill.`);
  }
  if (closeoutReminders.length > 0) {
    const candidates = closeoutReminders.map(item =>
      `[${item.session_id}] ${item.summary}. Record via \`${item.recommended_command}\``).join(' | ');
    lines.push(`- Knowledge closeout candidates (${closeoutReminders.length}): ${candidates}. Or record via \`evolve kb add --kind episodic\`, then run \`evolve kb reminders ack\`.`);
  }
  if (!hasModel && (reminders.length > 0 || existsSync(evolvePath(root)) || existsSync(join(root, 'wiki')))) {
    lines.push(`- Memory extraction LLM is unconfigured (\`baseUrl\` / \`model\`). Configure once via \`evolve kb config --yes --scope global --host ${host} --base-url <url> --model <model>\` or \`AGENT_MEMORY_LLM_*\`.`);
  }
  if (!lines.length) return undefined;
  return ['[Evolve Knowledge & Self-Evolution Reminder]', ...lines].join('\n');
}
