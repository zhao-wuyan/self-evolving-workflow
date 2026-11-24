import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError, NotFoundError, openDb, pageOffset, pagination, searchLimit } from './common.js';
import { memoryHosts, memoryModelSettings, parseMemoryHosts, type MemoryHost } from './memory-config.js';
import { buildSessionStartNotice, detectEntrySignals, recordConversationSignals } from './memory-reminders.js';
import type { ConversationMessage, MemoryStore } from './memory.js';
import type { LlmClient } from './upstream/llm.js';

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function projectContains(root: string, cwd: unknown): boolean {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false;
  const path = relative(root, existsSync(cwd) ? realpathSync(cwd) : cwd);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

interface TranscriptRow { row: Record<string, unknown> | undefined; start: number; end: number }

async function* transcriptRows(path: string, from: number, size: number): AsyncGenerator<TranscriptRow> {
  if (from >= size) return;
  let offset = from;
  let parts: Buffer[] = [];
  const stream = createReadStream(path, { start: from, end: size - 1 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let start = 0;
    for (let end = chunk.indexOf(10, start); end >= 0; end = chunk.indexOf(10, start)) {
      parts.push(chunk.subarray(start, end));
      const line = Buffer.concat(parts);
      const text = line.toString('utf8').replace(/^\uFEFF/, '');
      const rowOffset = offset;
      offset += line.length + 1;
      parts = [];
      start = end + 1;
      if (!text.trim()) continue;
      let row: Record<string, unknown> | undefined;
      try {
        row = object(JSON.parse(text));
      } catch {
        throw new InputError(`Invalid transcript JSON at byte ${rowOffset}`);
      }
      yield { row, start: rowOffset, end: offset };
    }
    if (start < chunk.length) parts.push(chunk.subarray(start));
  }
  // 活跃会话可能还在写入最后一行，下一次从已提交的位置重新读取。
}

interface ImportOptions {
  root: string;
  memory: MemoryStore;
  model: () => LlmClient;
  allowUnconfiguredModel?: boolean;
}

interface Transcript {
  path: string;
  session?: string;
  lastAssistant?: string;
}

function readableText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function messageText(parts: unknown, kind: string): string {
  if (!Array.isArray(parts)) return '';
  return parts.flatMap(part => {
    if (part?.type !== kind || !readableText(part.text)) return [];
    if (kind === 'input_text' && /^(?:# AGENTS\.md instructions for |<(?:environment_context|recommended_plugins)>)/.test(part.text.trimStart())) return [];
    return [part.text];
  }).join('\n');
}

async function codexSession({ path, session }: Transcript, root: string, size: number) {
  for await (const { row } of transcriptRows(path, 0, size)) {
    const header = row?.type === 'session_meta' ? object(row.payload) : undefined;
    if (header && readableText(header.id) && (session === undefined || session === header.id) &&
        projectContains(root, header.cwd) && object(header.source)?.subagent === undefined) return header.id;
    return;
  }
}

function codexMessage({ row, start }: TranscriptRow, session: string, path: string): ConversationMessage | undefined {
  const payload = object(row?.payload);
  if (row?.type !== 'response_item' || payload?.type !== 'message' || !readableText(row.timestamp)) return;
  const role = payload.role;
  if (role !== 'user' && role !== 'assistant') return;
  const content = messageText(payload.content, role === 'user' ? 'input_text' : 'output_text');
  if (content) return { id: `codex:${session}:${start}`, role, timestamp: row.timestamp, content, location: { path, byteOffset: start } };
}

function codexCompletedMessage({ row, start }: TranscriptRow, session: string, path: string): ConversationMessage | undefined {
  const payload = object(row?.payload);
  if (row?.type === 'event_msg' && payload?.type === 'task_complete' && !payload.error &&
      readableText(payload.last_agent_message) && readableText(row.timestamp)) {
    return { id: `codex:${session}:${start}`, role: 'assistant', timestamp: row.timestamp,
      content: payload.last_agent_message, location: { path, byteOffset: start } };
  }
}

async function* codexTurns({ path, lastAssistant }: Transcript, session: string, offset: number, size: number) {
  let messages: ConversationMessage[] = [];
  for await (const entry of transcriptRows(path, offset, size)) {
    const payload = object(entry.row?.payload);
    if (entry.row?.type === 'event_msg' && (payload?.type === 'task_started' || payload?.type === 'turn_aborted')) messages = [];
    const item = codexMessage(entry, session, path);
    if (item?.role === 'user') { messages.push(item); continue; }
    const final = item && payload?.phase !== 'commentary' && (payload?.phase === 'final_answer' || item.content === lastAssistant)
      ? item : codexCompletedMessage(entry, session, path);
    if (!final || !messages.length) continue;
    messages.push(final);
    yield { end: entry.end, messages };
    messages = [];
  }
}

function claudeChat(row: Record<string, unknown> | undefined) {
  if (!row || (row.type !== 'user' && row.type !== 'assistant') ||
      row.isSidechain || row.isMeta || row.isCompactSummary || row.isApiErrorMessage) return;
  const message = object(row.message);
  if (message?.role === row.type) return { role: row.type, message } as const;
}

async function claudeSession({ path, session }: Transcript, root: string, size: number) {
  for await (const { row } of transcriptRows(path, 0, size)) {
    if (!row || !claudeChat(row) || !readableText(row.sessionId) || !readableText(row.cwd)) continue;
    if ((session === undefined || row.sessionId === session) && projectContains(root, row.cwd)) return row.sessionId;
    return;
  }
}

function claudeMessage({ row, start }: TranscriptRow, session: string, path: string) {
  const chat = row?.sessionId === session ? claudeChat(row) : undefined;
  if (!chat || !readableText(row?.timestamp)) return;
  const parts = chat.message.content;
  const content = typeof parts === 'string' ? parts : messageText(parts, 'text');
  const hasToolData = Array.isArray(parts) && parts.some(part => ['tool_result', 'tool_use', 'server_tool_use'].includes(part?.type));
  if (chat.role === 'user' && (hasToolData || !content.trim())) return;
  const id = `claude:${session}:${readableText(row.uuid) ? row.uuid : start}`;
  return { item: { id, role: chat.role, timestamp: row.timestamp, content, location: { path, byteOffset: start } },
    key: chat.message.id, stopReason: chat.message.stop_reason, hasToolData };
}

async function* claudeTurns({ path, lastAssistant }: Transcript, session: string, offset: number, size: number) {
  let users: ConversationMessage[] = [];
  let reply: { key: unknown; messages: ConversationMessage[]; end: number; complete: boolean } | undefined;
  const ready = () => reply?.complete || (reply && reply.messages.map(message => message.content).join('\n') === lastAssistant);
  for await (const entry of transcriptRows(path, offset, size)) {
    const chat = claudeMessage(entry, session, path);
    if (!chat) continue;
    const { item, key, stopReason, hasToolData } = chat;
    if (item.role === 'user' || (reply && reply.key !== key)) {
      if (reply && users.length && ready()) {
        yield { end: reply.end, messages: [...users, ...reply.messages] };
        users = [];
      }
      reply = undefined;
    }
    if (item.role === 'user') {
      users.push(item);
      continue;
    }
    if (hasToolData || stopReason === 'tool_use') {
      reply = undefined;
      continue;
    }
    if (!item.content.trim() || !users.length) continue;
    reply ??= { key, messages: [], end: entry.end, complete: false };
    reply.messages.push(item);
    reply.end = entry.end;
    reply.complete ||= ['end_turn', 'stop_sequence'].includes(String(stopReason));
  }
  if (reply && users.length && ready()) yield { end: reply.end, messages: [...users, ...reply.messages] };
}

function agyMessage({ row, start }: TranscriptRow, session: string, path: string) {
  if (!row || typeof row.step_index !== 'number' || !Number.isSafeInteger(row.step_index) ||
      row.status !== 'DONE' || !readableText(row.created_at) || !readableText(row.content)) return;
  const id = `agy:${session}:${row.step_index}`;
  const location = { path, byteOffset: start };
  if (row.type === 'USER_INPUT' && row.source === 'USER_EXPLICIT') {
    // Antigravity 的完整日志会把宿主附加说明拼在用户正文之外。
    const wrapped = /^<USER_REQUEST>\r?\n([\s\S]*?)\r?\n<\/USER_REQUEST>(?=\s*(?:<[A-Z][A-Z0-9_]*>|$))/.exec(row.content);
    const content = wrapped?.[1] ?? row.content;
    if (readableText(content)) return { step: row.step_index, hasToolData: false,
      item: { id, role: 'user' as const, timestamp: row.created_at, content, location } };
  } else if (row.type === 'PLANNER_RESPONSE' && row.source === 'MODEL') {
    return { step: row.step_index, hasToolData: Array.isArray(row.tool_calls) && row.tool_calls.length > 0,
      item: { id, role: 'assistant' as const, timestamp: row.created_at, content: row.content, location } };
  }
}

function resolveAgyTranscriptPath(path: string): string {
  if (basename(path) !== 'transcript.jsonl') return path;
  const fullPath = join(dirname(path), 'transcript_full.jsonl');
  return existsSync(fullPath) ? fullPath : path;
}

async function countAgyErrorSteps(path: string, fromStep: number, size: number): Promise<number> {
  let errors = 0;
  for await (const { row } of transcriptRows(path, 0, size)) {
    if (row && typeof row.step_index === 'number' && row.step_index >= fromStep && row.status === 'ERROR') {
      errors++;
    }
  }
  return errors;
}

async function* agyTurns({ path }: Transcript, session: string, offset: number, size: number) {
  let messages: ConversationMessage[] = [];
  for await (const entry of transcriptRows(path, 0, size)) {
    const chat = agyMessage(entry, session, path);
    if (!chat || chat.step < offset) continue;
    if (chat.item.role === 'user') messages.push(chat.item);
    else if (messages.length && !chat.hasToolData) {
      messages.push(chat.item);
      yield { end: chat.step + 1, messages };
      messages = [];
    }
  }
}

const turnReaders = { codex: codexTurns, claude: claudeTurns, agy: agyTurns };

async function importTranscript(
  host: MemoryHost, transcript: Transcript, { root, memory, model, allowUnconfiguredModel }: ImportOptions,
) {
  const path = host === 'agy' ? resolveAgyTranscriptPath(transcript.path) : transcript.path;
  const target = { ...transcript, path };
  const info = statSync(path);
  if (!info.isFile()) throw new InputError('Transcript must be a file');
  const session = host === 'codex' ? await codexSession(target, root, info.size)
    : host === 'claude' ? await claudeSession(target, root, info.size) : target.session;
  if (!session) return;
  let offset = memory.extractionOffset(host, session);
  if (host !== 'agy' && offset > info.size) throw new InputError('Transcript is shorter than its saved extraction offset');
  const errorCount = host === 'agy' ? await countAgyErrorSteps(path, offset, info.size) : 0;
  const settings = allowUnconfiguredModel ? memoryModelSettings(root) : undefined;
  const skipModel = Boolean(allowUnconfiguredModel && settings?.provider !== 'omp' && (!settings?.baseUrl || !settings?.model));
  let remembered = 0;
  let processed = 0;
  for await (const turn of turnReaders[host](target, session, offset, info.size)) {
    recordConversationSignals(root, { host, session, messages: turn.messages, errorCount });
    if (!skipModel && memory.extractionOffset(host, session) === offset) {
      const records = await memory.extractIncremental(turn.messages, {
        source: host, from: offset, to: turn.end, llm: model(), session, mode: 'code',
      });
      if (records) {
        remembered += records.length;
        processed++;
      }
    }
    offset = turn.end;
  }
  return { session, processed, remembered };
}

export function memoryHookTarget(
  host: MemoryHost, input: unknown, projectRoot: string,
): { session: string; path: string; lastAssistant?: string } | undefined {
  const event = object(input);
  const root = realpathSync(projectRoot);
  const candidateCwd = event?.cwd ?? (Array.isArray(event?.workspacePaths) ? event.workspacePaths[0] : undefined);
  const cwd = typeof candidateCwd === 'string' ? workspacePath(candidateCwd) ?? candidateCwd : candidateCwd;
  if (!projectContains(root, cwd)) return;
  if (host === 'agy') {
    if (readableText(event?.conversationId) && readableText(event.transcriptPath) && !event.error) {
      return { session: event.conversationId, path: resolveAgyTranscriptPath(resolve(root, event.transcriptPath)) };
    }
    return;
  }
  if (event?.hook_event_name === 'Stop' && readableText(event.transcript_path) && readableText(event.session_id)) {
    return { session: event.session_id, path: resolve(root, event.transcript_path),
      ...(readableText(event.last_assistant_message) ? { lastAssistant: event.last_assistant_message } : {}) };
  }
}

export async function handleMemoryHook(host: MemoryHost, input: unknown, options: ImportOptions) {
  const root = realpathSync(options.root);
  const target = memoryHookTarget(host, input, root);
  if (target) await importTranscript(host, target, { ...options, root });
  return host === 'agy' ? { decision: 'stop' } : {};
}

export function handleSessionStartHook(host: MemoryHost, input: unknown, options: { root: string }) {
  const event = object(input);
  const root = realpathSync(options.root);
  const candidateCwd = event?.cwd ?? (Array.isArray(event?.workspacePaths) ? event.workspacePaths[0] : undefined);
  if (candidateCwd !== undefined && !projectContains(root, workspacePath(String(candidateCwd)) ?? candidateCwd)) {
    return {};
  }
  const currentSession = readableText(event?.conversationId) ? event.conversationId
    : readableText(event?.session_id) ? event.session_id : undefined;
  const notice = buildSessionStartNotice(root, host, currentSession);
  if (!notice) return {};
  if (host === 'agy') {
    return { injectSteps: [{ systemMessage: { systemMessage: notice } }] };
  }
  return { systemMessage: notice,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: notice } };
}

function workspacePath(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return;
  try {
    return fileURLToPath(uri);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // 宿主可能保留其他平台上的路径，当前系统只能导入能解析的工作区。
    return;
  }
}

function* agyTranscripts(
  root: string,
  session: string | undefined,
  _full: boolean,
  allProjects = false,
): Generator<Transcript & { cwd?: string }> {
  const seen = new Set<string>();
  for (const dirName of ['antigravity-cli', 'antigravity']) {
    const home = join(homedir(), '.gemini', dirName);
    const index = join(home, 'conversation_summaries.db');
    if (!existsSync(index)) continue;
    const db = openDb(index, true);
    try {
      const select = db.prepare(`SELECT conversation_id, workspace_uris FROM conversation_summaries
        WHERE coalesce(parent_conversation_id, '') = ''${session === undefined ? '' : ' AND conversation_id = ?'}`);
      for (const row of select.iterate(...(session === undefined ? [] : [session]))) {
        const { conversation_id: id, workspace_uris: raw } = row;
        if (typeof id !== 'string' || !/^[\w-]+$/.test(id) || seen.has(id) || !readableText(raw)) continue;
        const uris: unknown = JSON.parse(raw);
        const firstUri = Array.isArray(uris) && typeof uris[0] === 'string' ? workspacePath(uris[0]) : undefined;
        if (!allProjects && !projectContains(root, firstUri)) continue;
        const directory = join(home, 'brain', id, '.system_generated', 'logs');
        const names = ['transcript_full.jsonl', 'transcript.jsonl'];
        const path = names.map(name => join(directory, name)).find(existsSync);
        if (path) {
          seen.add(id);
          yield { path, session: id, ...(firstUri ? { cwd: firstUri } : {}) };
        }
      }
    } finally {
      db.close();
    }
  }
}

function* savedTranscripts(
  host: MemoryHost,
  root: string,
  session?: string,
  full = false,
  allProjects = false,
): Generator<Transcript & { cwd?: string }> {
  if (host === 'agy') return yield* agyTranscripts(root, session, full, allProjects);
  if (host === 'claude') {
    const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
    if (!existsSync(projects)) return;
    for (const project of readdirSync(projects, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const directory = join(projects, project.name);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl') && (!session || basename(entry.name, '.jsonl') === session)) {
          yield { path: join(directory, entry.name), session: session ?? basename(entry.name, '.jsonl') };
        }
      }
    }
    return;
  }
  const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  for (const name of ['sessions', 'archived_sessions']) {
    const directory = join(home, name);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name) && (!session || entry.name.endsWith(`-${session}.jsonl`))) {
        yield { path: join(entry.parentPath, entry.name), session };
      }
    }
  }
}

export type HistoryEntryRole = 'user' | 'assistant' | 'tool' | 'error';
export type HistoryEntryKind = 'message' | 'tool_call' | 'tool_result' | 'error';

export interface HistoryEntry {
  id: string;
  host: MemoryHost;
  session: string;
  role: HistoryEntryRole;
  kind: HistoryEntryKind;
  timestamp: string;
  content: string;
  toolName?: string;
  signals: string[];
  location: { path: string; byteOffset: number };
}

export interface HostTranscriptRef {
  host: MemoryHost;
  session: string;
  cwd?: string;
  path: string;
  size: number;
  mtimeMs: number;
}

export interface HistorySessionSummary {
  host: MemoryHost;
  session: string;
  cwd?: string;
  path: string;
  started_at?: string;
  updated_at: string;
  title?: string;
  message_count: number;
  tool_count: number;
  error_count: number;
  signals: string[];
}

export interface HistorySearchHit {
  host: MemoryHost;
  session: string;
  anchor: string;
  role: HistoryEntryRole;
  kind: HistoryEntryKind;
  timestamp: string;
  toolName?: string;
  signals?: string[];
  snippet: string;
  truncated: boolean;
}

export function parseSinceMs(since?: string): number | undefined {
  if (!since) return undefined;
  const relativeMatch = /^(\d+)([mhdw])$/i.exec(since.trim());
  if (relativeMatch) {
    const count = Number(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    const mult = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000;
    return Date.now() - count * mult;
  }
  const parsed = Date.parse(since);
  if (!Number.isFinite(parsed)) throw new InputError(`Invalid --since value: ${since}`);
  return parsed;
}

function serializeCompact(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clipText(text: string, max = 300, matchIndex = 0): { snippet: string; truncated: boolean } {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return { snippet: normalized, truncated: false };
  const start = matchIndex > 60 ? Math.max(0, Math.min(matchIndex - 60, normalized.length - max)) : 0;
  const slice = normalized.slice(start, start + max);
  const snippet = (start > 0 ? '…' : '') + slice + (start + max < normalized.length ? '…' : '');
  return { snippet, truncated: true };
}

async function inspectHostTranscript(
  host: MemoryHost,
  transcript: Transcript & { cwd?: string },
  root: string,
  size: number,
  allProjects: boolean,
): Promise<{ session: string; cwd?: string } | undefined> {
  if (host === 'agy') {
    return transcript.session ? { session: transcript.session, cwd: transcript.cwd } : undefined;
  }
  if (host === 'codex') {
    for await (const { row } of transcriptRows(transcript.path, 0, size)) {
      const header = row?.type === 'session_meta' ? object(row.payload) : undefined;
      if (header && readableText(header.id) &&
          (transcript.session === undefined || transcript.session === header.id) &&
          (allProjects || projectContains(root, header.cwd)) &&
          object(header.source)?.subagent === undefined) {
        return { session: header.id, cwd: readableText(header.cwd) ? header.cwd : undefined };
      }
      return undefined;
    }
    return undefined;
  }
  for await (const { row } of transcriptRows(transcript.path, 0, size)) {
    if (!row || !readableText(row.sessionId) || !readableText(row.cwd)) continue;
    if ((transcript.session === undefined || row.sessionId === transcript.session) &&
        (allProjects || projectContains(root, row.cwd))) {
      return { session: row.sessionId, cwd: row.cwd };
    }
    return undefined;
  }
  return undefined;
}

export async function discoverHostTranscripts(
  root: string,
  options: { hosts?: readonly MemoryHost[]; session?: string; allProjects?: boolean } = {},
): Promise<HostTranscriptRef[]> {
  const resolvedRoot = realpathSync(root);
  const hosts = options.hosts?.length ? options.hosts : memoryHosts;
  const allProjects = Boolean(options.allProjects);
  const refs: HostTranscriptRef[] = [];
  for (const host of hosts) {
    for (const transcript of savedTranscripts(host, resolvedRoot, options.session, true, allProjects)) {
      const info = statSync(transcript.path, { throwIfNoEntry: false });
      if (!info?.isFile()) continue;
      let matched: { session: string; cwd?: string } | undefined;
      try {
        matched = await inspectHostTranscript(host, transcript, resolvedRoot, info.size, allProjects);
      } catch {
        continue;
      }
      if (!matched) continue;
      refs.push({
        host,
        session: matched.session,
        ...(matched.cwd ? { cwd: matched.cwd } : {}),
        path: transcript.path,
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
    }
  }
  return refs;
}

function makeHistoryEntry(
  partial: Omit<HistoryEntry, 'signals'>,
  explicitError = false,
): HistoryEntry {
  return {
    ...partial,
    signals: detectEntrySignals(partial.role, partial.content, explicitError, partial.kind),
  };
}

function parseCodexRow(
  entry: TranscriptRow,
  session: string,
  path: string,
  includeTools: boolean,
  previousAssistant: string | undefined,
): { items: HistoryEntry[]; nextAssistant: string | undefined } {
  const { row, start } = entry;
  const timestamp = readableText(row?.timestamp) ? row.timestamp : new Date(0).toISOString();
  const completed = codexCompletedMessage(entry, session, path);
  if (completed) {
    if (previousAssistant === completed.content) return { items: [], nextAssistant: previousAssistant };
    return {
      items: [makeHistoryEntry({
        id: completed.id, host: 'codex', session, role: 'assistant', kind: 'message',
        timestamp: String(completed.timestamp), content: completed.content, location: { path, byteOffset: start },
      })],
      nextAssistant: completed.content,
    };
  }
  const msg = codexMessage(entry, session, path);
  if (msg) {
    return {
      items: [makeHistoryEntry({
        id: msg.id, host: 'codex', session, role: msg.role === 'user' ? 'user' : 'assistant', kind: 'message',
        timestamp: String(msg.timestamp), content: msg.content, location: { path, byteOffset: start },
      })],
      nextAssistant: msg.role === 'assistant' ? msg.content : previousAssistant,
    };
  }
  if (!includeTools) return { items: [], nextAssistant: previousAssistant };
  const payload = object(row?.payload);
  if (row?.type === 'response_item' && (payload?.type === 'function_call' || payload?.type === 'custom_tool_call')) {
    const toolName = readableText(payload.name) ? payload.name : 'tool';
    const argsText = payload.arguments !== undefined ? serializeCompact(payload.arguments)
      : payload.input !== undefined ? serializeCompact(payload.input) : '';
    const content = [toolName, argsText].filter(Boolean).join(' ');
    return {
      items: [makeHistoryEntry({
        id: `codex:${session}:${start}:call`, host: 'codex', session, role: 'tool', kind: 'tool_call',
        timestamp, content, toolName, location: { path, byteOffset: start },
      })],
      nextAssistant: previousAssistant,
    };
  }
  if (row?.type === 'response_item' && (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output')) {
    const outText = payload.output !== undefined ? serializeCompact(payload.output) : '';
    if (!outText.trim()) return { items: [], nextAssistant: previousAssistant };
    const signals = detectEntrySignals('tool', outText);
    const isErr = signals.includes('tool_or_runtime_error');
    return {
      items: [makeHistoryEntry({
        id: `codex:${session}:${start}:out`, host: 'codex', session,
        role: isErr ? 'error' : 'tool', kind: isErr ? 'error' : 'tool_result',
        timestamp, content: outText, location: { path, byteOffset: start },
      }, isErr)],
      nextAssistant: previousAssistant,
    };
  }
  if (row?.type === 'event_msg' && payload?.type === 'turn_aborted') {
    const reason = readableText(payload.reason) ? payload.reason : 'Turn aborted';
    return {
      items: [makeHistoryEntry({
        id: `codex:${session}:${start}:abort`, host: 'codex', session, role: 'error', kind: 'error',
        timestamp, content: reason, location: { path, byteOffset: start },
      }, true)],
      nextAssistant: previousAssistant,
    };
  }
  return { items: [], nextAssistant: previousAssistant };
}

function parseClaudeRow(
  entry: TranscriptRow,
  session: string,
  path: string,
  includeTools: boolean,
): HistoryEntry[] {
  const { row, start } = entry;
  if (!row || row.sessionId !== session || row.isSidechain || row.isMeta || row.isCompactSummary) return [];
  const timestamp = readableText(row.timestamp) ? row.timestamp : new Date(0).toISOString();
  const baseId = `claude:${session}:${readableText(row.uuid) ? row.uuid : start}`;
  if (row.isApiErrorMessage) {
    const message = object(row.message);
    const text = typeof message?.content === 'string' ? message.content : serializeCompact(row.error ?? message ?? 'API error');
    return [makeHistoryEntry({
      id: `${baseId}:api-error`, host: 'claude', session, role: 'error', kind: 'error',
      timestamp, content: text, location: { path, byteOffset: start },
    }, true)];
  }
  if (row.type !== 'user' && row.type !== 'assistant') return [];
  const message = object(row.message);
  if (message?.role !== row.type) return [];
  const parts = message.content;
  if (typeof parts === 'string') {
    if (!parts.trim()) return [];
    return [makeHistoryEntry({
      id: baseId, host: 'claude', session, role: row.type, kind: 'message',
      timestamp, content: parts, location: { path, byteOffset: start },
    })];
  }
  if (!Array.isArray(parts)) return [];
  const items: HistoryEntry[] = [];
  const textContent = messageText(parts, 'text');
  if (textContent.trim()) {
    items.push(makeHistoryEntry({
      id: baseId, host: 'claude', session, role: row.type, kind: 'message',
      timestamp, content: textContent, location: { path, byteOffset: start },
    }));
  }
  if (!includeTools) return items;
  parts.forEach((part, index) => {
    if (!part || typeof part !== 'object') return;
    if (part.type === 'tool_use') {
      const toolName = readableText(part.name) ? part.name : 'tool';
      const content = [toolName, part.input !== undefined ? serializeCompact(part.input) : ''].filter(Boolean).join(' ');
      items.push(makeHistoryEntry({
        id: `${baseId}:tool:${index}`, host: 'claude', session, role: 'tool', kind: 'tool_call',
        timestamp, content, toolName, location: { path, byteOffset: start },
      }));
    } else if (part.type === 'tool_result') {
      const text = typeof part.content === 'string' ? part.content : serializeCompact(part.content ?? '');
      if (!text.trim()) return;
      const isErr = part.is_error === true || detectEntrySignals('tool', text).includes('tool_or_runtime_error');
      items.push(makeHistoryEntry({
        id: `${baseId}:result:${index}`, host: 'claude', session,
        role: isErr ? 'error' : 'tool', kind: isErr ? 'error' : 'tool_result',
        timestamp, content: text, location: { path, byteOffset: start },
      }, isErr));
    }
  });
  return items;
}

function parseAgyRow(
  entry: TranscriptRow,
  session: string,
  path: string,
  includeTools: boolean,
): HistoryEntry[] {
  const { row, start } = entry;
  if (!row || typeof row.step_index !== 'number' || !Number.isSafeInteger(row.step_index)) return [];
  const timestamp = readableText(row.created_at) ? row.created_at : new Date(0).toISOString();
  const baseId = `agy:${session}:${row.step_index}`;
  const items: HistoryEntry[] = [];
  if (row.status === 'ERROR') {
    const errText = readableText(row.content) ? row.content
      : row.error !== undefined ? serializeCompact(row.error) : `Step ${row.step_index} ERROR`;
    items.push(makeHistoryEntry({
      id: `${baseId}:error`, host: 'agy', session, role: 'error', kind: 'error',
      timestamp, content: errText, location: { path, byteOffset: start },
    }, true));
    return items;
  }
  const msg = agyMessage(entry, session, path)?.item;
  if (msg) {
    items.push(makeHistoryEntry({
      id: msg.id, host: 'agy', session, role: msg.role === 'user' ? 'user' : 'assistant', kind: 'message',
      timestamp: msg.timestamp, content: msg.content, location: { path, byteOffset: start },
    }));
  }
  if (includeTools && Array.isArray(row.tool_calls)) {
    row.tool_calls.forEach((call, index) => {
      if (!call || typeof call !== 'object') return;
      const record = call as Record<string, unknown>;
      const toolName = readableText(record.name) ? record.name
        : readableText(record.tool_name) ? record.tool_name : 'tool';
      const argsVal = record.arguments ?? record.args ?? record.input;
      const content = [toolName, argsVal !== undefined ? serializeCompact(argsVal) : ''].filter(Boolean).join(' ');
      items.push(makeHistoryEntry({
        id: `${baseId}:tool:${index}`, host: 'agy', session, role: 'tool', kind: 'tool_call',
        timestamp, content, toolName, location: { path, byteOffset: start },
      }));
    });
  }
  if (includeTools && (row.type === 'TOOL_RESPONSE' || row.source === 'TOOL') && readableText(row.content)) {
    const isErr = detectEntrySignals('tool', row.content).includes('tool_or_runtime_error');
    items.push(makeHistoryEntry({
      id: `${baseId}:result`, host: 'agy', session,
      role: isErr ? 'error' : 'tool', kind: isErr ? 'error' : 'tool_result',
      timestamp, content: row.content, location: { path, byteOffset: start },
    }, isErr));
  }
  return items;
}

export async function readHostHistoryEntries(
  ref: Pick<HostTranscriptRef, 'host' | 'session' | 'path' | 'size'>,
  options: { fromOffset?: number; includeTools?: boolean } = {},
): Promise<{ entries: HistoryEntry[]; lastOffset: number }> {
  const fromOffset = options.fromOffset ?? 0;
  const includeTools = options.includeTools ?? true;
  const entries: HistoryEntry[] = [];
  let lastOffset = fromOffset;
  let previousAssistant: string | undefined;
  for await (const row of transcriptRows(ref.path, fromOffset, ref.size)) {
    lastOffset = row.end;
    if (ref.host === 'codex') {
      const parsed = parseCodexRow(row, ref.session, ref.path, includeTools, previousAssistant);
      previousAssistant = parsed.nextAssistant;
      entries.push(...parsed.items);
    } else if (ref.host === 'claude') {
      entries.push(...parseClaudeRow(row, ref.session, ref.path, includeTools));
    } else {
      entries.push(...parseAgyRow(row, ref.session, ref.path, includeTools));
    }
  }
  return { entries, lastOffset };
}

export async function listAgentHistory(options: {
  root: string;
  hosts?: readonly MemoryHost[];
  session?: string;
  since?: string;
  signalsOnly?: boolean;
  allProjects?: boolean;
  limit?: number;
}): Promise<HistorySessionSummary[]> {
  const limit = searchLimit(options.limit ?? 20);
  const sinceMs = parseSinceMs(options.since);
  const refs = await discoverHostTranscripts(options.root, {
    hosts: options.hosts,
    session: options.session,
    allProjects: options.allProjects,
  });
  const summaries: HistorySessionSummary[] = [];
  for (const ref of refs) {
    const fallbackTime = new Date(ref.mtimeMs).toISOString();
    if (sinceMs !== undefined && ref.mtimeMs < sinceMs) continue;
    let entries: HistoryEntry[];
    try {
      ({ entries } = await readHostHistoryEntries(ref, { includeTools: true }));
    } catch {
      continue;
    }
    if (!entries.length) continue;
    const signals = [...new Set(entries.flatMap(item => item.signals))];
    if (options.signalsOnly && !signals.length) continue;
    const firstUser = entries.find(item => item.role === 'user' && item.kind === 'message');
    const startedAt = entries[0]?.timestamp;
    const updatedAt = entries.at(-1)?.timestamp ?? fallbackTime;
    const updatedMs = Date.parse(updatedAt);
    if (sinceMs !== undefined && Number.isFinite(updatedMs) && updatedMs < sinceMs) continue;
    summaries.push({
      host: ref.host,
      session: ref.session,
      ...(ref.cwd ? { cwd: ref.cwd } : {}),
      path: ref.path,
      ...(startedAt ? { started_at: startedAt } : {}),
      updated_at: updatedAt,
      ...(firstUser ? { title: clipText(firstUser.content, 100).snippet } : {}),
      message_count: entries.filter(item => item.kind === 'message').length,
      tool_count: entries.filter(item => item.kind === 'tool_call' || item.kind === 'tool_result').length,
      error_count: entries.filter(item => item.role === 'error').length,
      signals,
    });
  }
  summaries.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return summaries.slice(0, limit);
}

export async function searchAgentHistory(options: {
  root: string;
  query?: string;
  regex?: boolean;
  hosts?: readonly MemoryHost[];
  session?: string;
  roles?: readonly HistoryEntryRole[];
  skill?: string;
  signalsOnly?: boolean;
  since?: string;
  allProjects?: boolean;
  includeTools?: boolean;
  limit?: number;
  page?: number;
}): Promise<{ total: number; results: HistorySearchHit[]; pagination: ReturnType<typeof pagination> }> {
  const limit = searchLimit(options.limit ?? 20);
  const page = options.page ?? 1;
  const offset = pageOffset(page, limit);
  const sinceMs = parseSinceMs(options.since);
  const includeTools = options.includeTools ?? true;
  const queryText = options.query?.trim() ?? '';
  if (!queryText && !options.signalsOnly && !options.skill && !options.session && !options.roles?.length) {
    throw new InputError('Provide a search query, --signals-only, --role, --skill, or --session');
  }
  let regex: RegExp | undefined;
  if (queryText && options.regex) {
    try {
      regex = new RegExp(queryText, 'i');
    } catch {
      throw new InputError(`Invalid search regex: ${queryText}`);
    }
  }
  const needle = queryText.toLowerCase();
  const skillNeedle = options.skill?.trim().toLowerCase();
  const refs = await discoverHostTranscripts(options.root, {
    hosts: options.hosts,
    session: options.session,
    allProjects: options.allProjects,
  });
  const hits: HistorySearchHit[] = [];
  for (const ref of refs) {
    let entries: HistoryEntry[];
    try {
      ({ entries } = await readHostHistoryEntries(ref, { includeTools }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (options.roles?.length && !options.roles.includes(entry.role)) continue;
      if (sinceMs !== undefined) {
        const ts = Date.parse(entry.timestamp);
        if (Number.isFinite(ts) && ts < sinceMs) continue;
      }
      if (options.signalsOnly && entry.signals.length === 0 && entry.role !== 'error') continue;
      if (skillNeedle && !entry.content.toLowerCase().includes(skillNeedle)) continue;
      let matchIdx = 0;
      if (queryText) {
        if (regex) {
          const found = regex.exec(entry.content);
          if (!found) continue;
          matchIdx = found.index;
        } else {
          const idx = entry.content.toLowerCase().indexOf(needle);
          if (idx < 0) continue;
          matchIdx = idx;
        }
      }
      const { snippet, truncated } = clipText(entry.content, 300, matchIdx);
      hits.push({
        host: entry.host,
        session: entry.session,
        anchor: entry.id,
        role: entry.role,
        kind: entry.kind,
        timestamp: entry.timestamp,
        ...(entry.toolName ? { toolName: entry.toolName } : {}),
        ...(entry.signals.length ? { signals: entry.signals } : {}),
        snippet,
        truncated,
      });
    }
  }
  hits.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const paged = hits.slice(offset, offset + limit);
  return {
    total: hits.length,
    results: paged,
    pagination: pagination(page, limit, offset + limit < hits.length),
  };
}

export async function showAgentHistory(options: {
  root: string;
  session: string;
  host?: MemoryHost;
  anchor?: string;
  context?: number;
  includeTools?: boolean;
  allProjects?: boolean;
  page?: number;
  limit?: number;
}) {
  const limit = searchLimit(options.limit ?? 20);
  const refs = await discoverHostTranscripts(options.root, {
    hosts: options.host ? [options.host] : memoryHosts,
    session: options.session,
    allProjects: options.allProjects,
  });
  if (!refs.length) throw new NotFoundError(`Conversation is unavailable in this project: ${options.session}`);
  if (refs.length > 1) throw new InputError('Conversation exists in more than one host; specify --host');
  const ref = refs[0];
  const { entries } = await readHostHistoryEntries(ref, { includeTools: options.includeTools ?? true });
  if (options.anchor) {
    const context = options.context ?? 5;
    if (!Number.isInteger(context) || context < 0 || context > 50) {
      throw new InputError('context must be an integer between 0 and 50');
    }
    const idx = entries.findIndex(item => item.id === options.anchor || item.id.startsWith(options.anchor!));
    if (idx < 0) throw new NotFoundError(`History anchor not found in session ${options.session}: ${options.anchor}`);
    const start = Math.max(0, idx - context);
    const end = Math.min(entries.length, idx + context + 1);
    return {
      host: ref.host,
      session: ref.session,
      path: ref.path,
      anchor: entries[idx].id,
      total: entries.length,
      range: { start, end },
      entries: entries.slice(start, end),
    };
  }
  const page = options.page ?? 1;
  const offset = pageOffset(page, limit);
  return {
    host: ref.host,
    session: ref.session,
    path: ref.path,
    total: entries.length,
    pagination: pagination(page, limit, offset + limit < entries.length),
    entries: entries.slice(offset, offset + limit),
  };
}

interface ConversationOptions {
  root: string;
  memory: MemoryStore;
  host?: MemoryHost;
  page?: number;
  limit?: number;
}

async function locateConversation(root: string, session: string, hosts: readonly MemoryHost[]) {
  const matches: { host: MemoryHost; path: string; size: number }[] = [];
  for (const host of hosts) {
    for (const transcript of savedTranscripts(host, root, session, true)) {
      const info = statSync(transcript.path, { throwIfNoEntry: false });
      if (!info?.isFile()) continue;
      const id = host === 'codex' ? await codexSession(transcript, root, info.size)
        : host === 'claude' ? await claudeSession(transcript, root, info.size) : transcript.session;
      if (id !== session) continue;
      matches.push({ host, path: transcript.path, size: info.size });
      break;
    }
  }
  if (!matches.length) throw new NotFoundError(`Conversation is unavailable in this project: ${session}`);
  if (matches.length > 1) throw new InputError('Conversation exists in more than one host; specify --host');
  return matches[0];
}

export async function readMemoryConversation(target: string, options: ConversationOptions) {
  const limit = searchLimit(options.limit);
  if (options.page !== undefined) pageOffset(options.page, limit);
  const memory = options.memory.get(target);
  const session = memory?.session ?? target;
  if (!session) throw new NotFoundError('Memory has no conversation session');
  const sources = memory ? options.memory.sources(memory.id) : [];
  const anchor = sources.find(source => source.role === 'user')?.id ?? sources[0]?.id ?? memory?.sourceMessageIds[0];
  const hint = memoryHosts.find(host => anchor?.startsWith(`${host}:`));
  const selected = options.host ?? hint;
  const { host, path, size } = await locateConversation(realpathSync(options.root), session, selected ? [selected] : memoryHosts);

  let page = options.page ?? (anchor ? undefined : 1);
  let anchorPage: number | undefined;
  let previous: ConversationMessage | undefined;
  let messages: ConversationMessage[] = [];
  const firstPage: ConversationMessage[] = [];
  let count = 0;
  let hasNext = false;
  for await (const entry of transcriptRows(path, 0, size)) {
    const completed = host === 'codex' ? codexCompletedMessage(entry, session, path) : undefined;
    const item = host === 'codex' ? completed ?? codexMessage(entry, session, path)
      : host === 'claude' ? claudeMessage(entry, session, path)?.item : agyMessage(entry, session, path)?.item;
    if (!item?.content.trim()) continue;

    // Codex 的回合完成事件有时复述上一条回复。该事件的来源 ID 仍能定位到同一页。
    const repeated = completed && previous?.role === 'assistant' && previous.content === completed.content;
    const position = repeated ? count - 1 : count;
    const currentPage = Math.floor(position / limit) + 1;
    if (!repeated && page === undefined && position % limit === 0) messages = [];
    if (item.id === anchor) { anchorPage = currentPage; page ??= currentPage; }
    if (repeated) continue;
    if (page !== undefined && currentPage > page) { hasNext = true; break; }
    previous = item;
    count++;
    if (count <= limit) firstPage.push(item);
    if (page === undefined || currentPage === page) messages.push(item);
  }
  if (page === undefined) { page = 1; messages = firstPage; hasNext = count > limit; }
  return { host, session, ...(memory && { memoryId: memory.id }), ...(anchor && { anchor: { messageId: anchor, page: anchorPage ?? null } }),
    pagination: pagination(page, limit, hasNext), messages };
}

export async function readHostConversationMessages(root: string, session: string, host?: MemoryHost) {
  const located = await locateConversation(realpathSync(root), session, host ? [host] : memoryHosts);
  const messages: ConversationMessage[] = [];
  let previous: ConversationMessage | undefined;
  for await (const entry of transcriptRows(located.path, 0, located.size)) {
    const completed = located.host === 'codex' ? codexCompletedMessage(entry, session, located.path) : undefined;
    const item = located.host === 'codex' ? completed ?? codexMessage(entry, session, located.path)
      : located.host === 'claude' ? claudeMessage(entry, session, located.path)?.item
      : agyMessage(entry, session, located.path)?.item;
    if (!item?.content.trim()) continue;
    const repeated = completed && previous?.role === 'assistant' && previous.content === completed.content;
    if (repeated) continue;
    previous = item;
    messages.push(item);
  }
  return { host: located.host, session, path: located.path, messages };
}

export async function syncMemoryHost(host: MemoryHost, options: ImportOptions, session?: string) {
  const root = realpathSync(options.root);
  const sessions = new Set<string>();
  const failures: { path: string; error: string }[] = [];
  let processed = 0;
  let remembered = 0;
  try {
    for (const transcript of savedTranscripts(host, root, session)) {
      try {
        const result = await importTranscript(host, transcript, { ...options, root });
        if (!result) continue;
        sessions.add(result.session);
        processed += result.processed;
        remembered += result.remembered;
      } catch (error) {
        failures.push({ path: transcript.path, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    failures.push({ path: host, error: error instanceof Error ? error.message : String(error) });
  }
  return { sessions: sessions.size, processed, remembered, failures };
}
