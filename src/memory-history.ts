import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError, NotFoundError, openDb, pageOffset, pagination, searchLimit } from './common.js';
import { memoryHosts, memoryModelSettings, type MemoryHost } from './memory-config.js';
import { recordConversationSignals, buildSessionStartNotice } from './memory-reminders.js';
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
  const skipModel = Boolean(allowUnconfiguredModel && (!settings?.baseUrl || !settings?.model));
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
  const notice = buildSessionStartNotice(root, host);
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

function* agyTranscripts(root: string, session: string | undefined, full: boolean): Generator<Transcript> {
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
        if (!Array.isArray(uris) || typeof uris[0] !== 'string' || !projectContains(root, workspacePath(uris[0]))) continue;
        const directory = join(home, 'brain', id, '.system_generated', 'logs');
        const names = ['transcript_full.jsonl', 'transcript.jsonl'];
        const path = names.map(name => join(directory, name)).find(existsSync);
        if (path) {
          seen.add(id);
          yield { path, session: id };
        }
      }
    } finally {
      db.close();
    }
  }
}

function* savedTranscripts(host: MemoryHost, root: string, session?: string, full = false): Generator<Transcript> {
  if (host === 'agy') return yield* agyTranscripts(root, session, full);
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
