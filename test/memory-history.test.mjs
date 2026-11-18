import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from '../dist/common.js';
import { readMemoryHookJobs } from '../dist/memory-hook-jobs.js';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
const time = '2026-11-15T00:00:00Z';
const row = (type, payload) => JSON.stringify({ timestamp: time, type, payload }) + '\r\n';
const meta = (id, cwd) => row('session_meta', { id, cwd, source: 'cli' });
const event = (type, fields = {}) => row('event_msg', { type, ...fields });
const message = (role, text, phase) => row('response_item', {
  type: 'message', role, phase, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
});
const turn = (text, reply) => event('task_started') + message('user', text) + message('assistant', reply, 'final_answer');
const originalNumber = '004312.50';
const changedNumber = '004311.50';
const originalId = host => `Evolve-Reference_${host}-00A9-ACCEPT`;
const changedId = host => `Evolve-Reference_${host}-00A8-ACCEPT`;

async function runMemoryCli(root, env, args, input, expectedCode = 0) {
  const child = spawn(process.execPath, [cli, '--root', root, ...args], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  const [code] = await once(child, 'close');
  assert.equal(code, expectedCode, stderr + stdout);
  return stdout ? JSON.parse(stdout) : stderr;
}

async function waitForHookJob(root, session) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = readMemoryHookJobs(root).find(item => item.session === session);
    assert.notEqual(job?.state, 'failed', job?.last_error);
    if (job?.state === 'done') return job;
    await delay(15);
  }
  assert.fail(`Hook job did not finish: ${JSON.stringify(readMemoryHookJobs(root))}`);
}

function follow(invoke, commands, action, slots) {
  const [executable, ...prefix] = commands.prefix;
  assert.equal(executable, 'evolve');
  return invoke([...prefix, ...commands[action].map(value => typeof value === 'string' ? value : String(slots[value.arg]))]);
}

async function assertExactSource(invoke, { host, session, path, content, rawContent = content, scope }) {
  const search = async value => (await invoke(['kb', 'search', value, '--session', session])).results;
  const { results: [hit], commands } = await invoke(['kb', 'search', originalId(host), '--session', session]);
  assert.equal(hit.source, 'kb');
  assert.equal(hit.kind, 'episodic');
  assert.equal(hit.storageKind, 'memory');
  assert.ok(hit.sources.some(id => id.startsWith(host + ':' + session + ':')));
  const record = await follow(invoke, commands, 'get', hit);
  assert.equal((await search(originalNumber))[0]?.id, record.id);
  assert.deepEqual(await search(changedId(host)), []);
  assert.deepEqual(await search(changedNumber), []);
  assert.ok(record.exactValues.includes(originalId(host)));
  assert.equal(record.sourceMessageScope, scope);
  const [source] = await follow(invoke, commands, 'sources', hit);
  assert.equal(source.id, record.sources[0]);
  assert.equal(source.role, 'user');
  assert.equal(source.session, session);
  assert.equal(source.content, content);
  assert.equal(source.location.path, path);
  const conversation = await invoke(['kb', 'conversation', hit.id, '--host', host]);
  assert.equal(conversation.anchor.messageId, source.id);
  assert.ok(conversation.messages.some(item => item.id === source.id));
  const transcript = await readFile(path);
  const nextLine = transcript.indexOf(10, source.location.byteOffset);
  const raw = JSON.parse(transcript.subarray(source.location.byteOffset, nextLine).toString('utf8'));
  const payload = raw.payload?.content ?? raw.message?.content ?? raw.content;
  assert.equal(Array.isArray(payload) ? payload[0].text : payload, rawContent);
  return record;
}

test('Codex Stop extracts project chat incrementally and historical sync shares its progress', async t => {
  const base = await mkdtemp(join(tmpdir(), 'codex-memory-'));
  const root = join(base, "project's files");
  const cwd = join(root, 'subdirectory');
  const other = join(base, "project's files-other");
  const codexHome = join(base, 'codex');
  const sessions = join(codexHome, 'sessions', '2026', '11', '15');
  const archived = join(codexHome, 'archived_sessions');
  const transcript = join(sessions, 'rollout-2026-11-15-live.jsonl');
  const config = join(root, '.codex', 'hooks.json');
  const requests = [];
  let fail = false;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const prompt = JSON.parse(body).messages.at(-1).content;
    requests.push(prompt);
    if (fail) {
      response.writeHead(503).end();
      return;
    }
    const source = prompt.match(/\[(codex:[^\]]+)] \[user]/)?.[1];
    const fact = prompt.match(/remember (\S+)/)?.[1];
    const content = JSON.stringify(fact ? [{ scene_name: 'project', memories: [
      prompt.includes(originalId('codex'))
        ? { content: `Use ${changedId('codex')} at ${changedNumber}.`, source_message_ids: ['invalid-message'] }
        : { content: `${fact} project preference ${requests.length % 2 ? 'confirmed' : 'recorded'}`, source_message_ids: [source] },
    ] }] : []);
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  await Promise.all([cwd, other, sessions, archived, join(root, '.codex')].map(path => mkdir(path, { recursive: true })));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { ...process.env, CODEX_HOME: codexHome, AGENT_MEMORY_LLM_MODEL: 'fixture',
    AGENT_MEMORY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` };
  delete env.AGENT_MEMORY_LLM_API_KEY;
  const invoke = (...args) => runMemoryCli(root, env, ...args);
  const hook = (payload = {}, code = 0) => invoke(['kb', 'codex-hook'], {
    hook_event_name: 'Stop', session_id: 'live', transcript_path: transcript, cwd, ...payload,
  }, code);
  const search = async (text, session) => (await invoke(['kb', 'search', text, '--session', session])).results;

  const existingHandler = { type: 'command', command: 'independent-hook' };
  await writeFile(config, JSON.stringify({ hooks: { SessionStart: [{ hooks: [existingHandler] }] } }));
  assert.equal((await invoke(['kb', 'codex-install'])).changed, true);
  const installed = JSON.parse(await readFile(config, 'utf8'));
  assert.deepEqual(installed.hooks.SessionStart[0], { hooks: [existingHandler] });
  assert.equal(installed.hooks.SessionStart.length, 2);
  assert.match(installed.hooks.SessionStart[1].hooks[0].command, /session-start-hook/);
  assert.match(installed.hooks.Stop[0].hooks[0].command, /codex-hook/);
  assert.equal((await invoke(['kb', 'codex-install'])).changed, false);

  const reply = message('assistant', '保存了。', 'final_answer');
  const codexFact = `remember 水力基准。Deploy ${originalId('codex')} on ${originalNumber}.`;
  await writeFile(transcript, meta('live', cwd) + event('task_started') +
    message('developer', 'INJECTED_CONFIGURATION') + message('assistant', 'UNFINISHED_COMMENT', 'commentary') +
    message('user', '<recommended_plugins>INJECTED_PLUGIN_RECOMMENDATIONS</recommended_plugins>') +
    row('response_item', { type: 'function_call_output', output: 'PRIVATE_TOOL_OUTPUT' }) +
    message('user', codexFact) + reply.slice(0, -5));
  await hook();
  assert.equal(requests.length, 0);
  await appendFile(transcript, reply.slice(-5));
  await hook({ session_id: 'wrong' });
  await hook({ cwd: other });
  assert.equal(requests.length, 0);
  await hook();
  await hook();
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0], /INJECTED_CONFIGURATION|INJECTED_PLUGIN_RECOMMENDATIONS|UNFINISHED_COMMENT|PRIVATE_TOOL_OUTPUT/);
  const first = await assertExactSource(invoke, { host: 'codex', session: 'live', path: transcript, content: codexFact, scope: 'turn' });
  assert.equal(first.content, codexFact);
  assert.match(first.sources[0], /^codex:live:\d+$/);
  const anchored = await invoke(['kb', 'conversation', first.id, '--limit', '1']);
  assert.equal(anchored.session, 'live');
  assert.deepEqual(anchored.anchor, { messageId: first.sources[0], page: 2 });
  assert.deepEqual(anchored.messages.map(item => item.content), [codexFact]);
  assert.deepEqual(anchored.pagination, { page: 2, limit: 1, previousPage: 1, nextPage: 3 });
  const before = await follow(invoke, anchored.commands, 'page', { page: anchored.pagination.previousPage });
  assert.deepEqual(before.messages.map(item => item.content), ['UNFINISHED_COMMENT']);
  const after = await follow(invoke, anchored.commands, 'page', { page: anchored.pagination.nextPage });
  assert.deepEqual(after.messages.map(item => item.content), ['保存了。']);
  assert.equal(after.pagination.nextPage, null);
  assert.equal(requests.length, 1);

  await appendFile(transcript, turn('remember retryable', 'Saved.'));
  fail = true;
  assert.match(await hook({}, 1), /HTTP 503/);
  assert.deepEqual(await search('retryable', 'live'), []);
  fail = false;
  await Promise.all([hook(), hook()]);
  assert.equal((await search('retryable', 'live')).length, 1);

  await appendFile(transcript, turn('Nothing to remember here', 'No preference.'));
  await hook();
  const requestCount = requests.length;
  await hook();
  assert.equal(requests.length, requestCount);

  await writeFile(join(archived, 'rollout-2026-11-15-history.jsonl'), meta('history', root) +
    event('task_started') + message('user', 'remember archived') + message('assistant', 'Legacy reply') +
    event('task_complete', { last_agent_message: 'Legacy reply' }));
  await writeFile(join(archived, 'rollout-2026-11-15-unrelated.jsonl'), meta('unrelated', other) + turn('remember unrelated', 'Saved.'));
  assert.deepEqual(await invoke(['kb', 'codex-sync', '--session', 'history']), {
    host: 'codex', sessions: 1, processed: 1, remembered: 1, failures: [],
  });
  assert.deepEqual(await invoke(['kb', 'codex-sync']), { host: 'codex', sessions: 2, processed: 0, remembered: 0, failures: [] });
  assert.equal((await search('archived', 'history')).length, 1);
  assert.deepEqual(await search('unrelated', 'unrelated'), []);
  const archive = await invoke(['kb', 'conversation', 'history', '--page', '1', '--limit', '2']);
  assert.deepEqual(archive.messages.map(item => item.content), ['remember archived', 'Legacy reply']);
  assert.equal(archive.pagination.nextPage, null);
  assert.equal(archive.commands, undefined);
  assert.match(await invoke(['kb', 'conversation', 'unrelated'], undefined, 1), /unavailable in this project/);
  await appendFile(transcript, event('task_started') + message('user', 'Interrupted question.') + event('turn_aborted'));
  const interrupted = await invoke(['kb', 'conversation', 'live', '--page', '4', '--limit', '2']);
  assert.deepEqual(interrupted.messages.map(item => item.content), ['No preference.', 'Interrupted question.']);
  assert.deepEqual(await invoke(['kb', 'delete', first.id]), { deleted: true });
  assert.deepEqual(await search(originalId('codex'), 'live'), []);
  assert.deepEqual(await invoke(['kb', 'sources', first.id]), []);
});

test('Memory configuration enables all project hosts and shared sync imports Claude and Agy histories', async t => {
  const base = await mkdtemp(join(tmpdir(), 'memory-hosts-'));
  const root = join(base, 'project');
  const other = join(base, 'other');
  const claudeHome = join(base, 'claude-home');
  const claudeFolder = join(claudeHome, 'projects', 'encoded-project');
  const agyHome = join(base, '.gemini', 'antigravity-cli');
  const agyFolder = join(agyHome, 'brain', 'agy-session', '.system_generated', 'logs');
  const claudePath = join(claudeFolder, 'claude-session.jsonl');
  const agyPath = join(agyFolder, 'transcript.jsonl');
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const prompt = input.messages.at(-1).content;
    requests.push({ prompt, model: input.model });
    const id = prompt.match(/\[((?:claude|agy):[^\]]+)] \[user]/)?.[1];
    const fact = prompt.match(/remember (\w+)/)?.[1];
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
      { scene_name: 'project', memories: [prompt.includes(originalId('agy'))
        ? { content: `Use ${changedId('agy')} at ${changedNumber}.` }
        : { content: `${fact} preference`, source_message_ids: [id] }] },
    ]) } }] }));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  await Promise.all([other, claudeFolder, agyFolder, join(root, '.claude'), join(root, '.agents')]
    .map(path => mkdir(path, { recursive: true })));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { ...process.env, HOME: base, USERPROFILE: base, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: join(base, 'codex') };
  for (const key of Object.keys(env)) if (key.startsWith('AGENT_MEMORY_LLM_')) delete env[key];
  const invoke = (...args) => runMemoryCli(root, env, ...args);

  const claudeConfig = join(root, '.claude', 'settings.local.json');
  const agyConfig = join(root, '.agents', 'hooks.json');
  const independentHandler = { type: 'command', command: 'independent-hook' };
  await writeFile(claudeConfig, JSON.stringify({ hooks: { Stop: [{ hooks: [independentHandler] }] }, permissions: { allow: [] } }));
  await writeFile(agyConfig, JSON.stringify({ independent: { Stop: [independentHandler] } }));
  const configured = await invoke(['kb', 'config', '--yes', '--host', 'all', '--base-url',
    `http://127.0.0.1:${server.address().port}/v1`, '--model', 'memory-fixture']);
  assert.equal(configured.model_configured, true);
  assert.deepEqual(configured.hosts.map(item => [item.host, item.configured]), [['codex', true], ['claude', true], ['agy', true]]);
  assert.equal(JSON.parse(await readFile(claudeConfig, 'utf8')).hooks.Stop.length, 2);
  assert.equal(JSON.parse(await readFile(agyConfig, 'utf8'))['evolve-agent-memory'].Stop.length, 1);

  const claude = (type, uuid, content, extra = {}) => JSON.stringify({ type, uuid, cwd: root, sessionId: 'claude-session',
    timestamp: time, message: { role: type, content, ...extra } }) + '\n';
  const agy = (step_index, type, source, content, extra = {}) => JSON.stringify({ step_index, type, source, content,
    status: 'DONE', created_at: time, ...extra }) + '\n';
  const text = content => [{ type: 'text', text: content }];
  await writeFile(claudePath, claude('user', 'u1', 'remember claude') +
    claude('assistant', 'tool', [{ type: 'text', text: 'IGNORE_TOOL_CHAT' }, { type: 'tool_use' }], { stop_reason: 'tool_use' }) +
    claude('user', 'result', [{ type: 'tool_result', content: 'PRIVATE_TOOL_RESULT' }]) +
    claude('assistant', 'a1', text('confirmed'), { id: 'final', stop_reason: null }) +
    claude('assistant', 'a2', text('second block'), { id: 'final', stop_reason: 'end_turn' }));
  const firstAgyTurn = agy(0, 'USER_INPUT', 'USER_EXPLICIT', 'remember agy') +
    agy(2, 'PLANNER_RESPONSE', 'MODEL', 'IGNORE_TOOL_CHAT', { tool_calls: [{}] }) +
    agy(3, 'PLANNER_RESPONSE', 'MODEL', 'confirmed');
  await writeFile(agyPath, firstAgyTurn);
  const db = new DatabaseSync(join(agyHome, 'conversation_summaries.db'));
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT, workspace_uris TEXT, parent_conversation_id TEXT)');
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run('agy-session', JSON.stringify([pathToFileURL(root).href]), '');
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run('unrelated', JSON.stringify([pathToFileURL(other).href]), '');
  db.close();

  const initial = await invoke(['kb', 'sync']);
  assert.deepEqual(initial.hosts.map(item => [item.host, item.sessions, item.processed, item.remembered]),
    [['codex', 0, 0, 0], ['claude', 1, 1, 1], ['agy', 1, 1, 1]]);
  assert.equal(requests.length, 2);
  assert.match(requests[0].prompt, /second block/);
  assert.doesNotMatch(requests.map(request => request.prompt).join('\n'), /IGNORE_TOOL_CHAT|PRIVATE_TOOL_RESULT/);
  assert.ok(requests.every(request => request.model === 'memory-fixture'));

  const claudeFact = `remember claudenew with ${originalId('claude')} at ${originalNumber}.`;
  const agyFact = `remember agynew with ${originalId('agy')} at ${originalNumber}.`;
  const agyEnvelope = `<USER_REQUEST>\n${agyFact}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nHOST_CONFIGURATION_789012\n</ADDITIONAL_METADATA>`;
  await appendFile(claudePath, claude('user', 'u2', claudeFact) + claude('assistant', 'a3', text('confirmed'), { stop_reason: 'end_turn' }));
  await writeFile(agyPath, '  ' + firstAgyTurn + agy(4, 'USER_INPUT', 'USER_EXPLICIT', agyEnvelope) +
    agy(5, 'PLANNER_RESPONSE', 'MODEL', 'confirmed'));
  const claudeEvent = { hook_event_name: 'Stop', session_id: 'claude-session', cwd: root, transcript_path: claudePath };
  const agyEvent = { terminationReason: 'model_stop', conversationId: 'agy-session', workspacePaths: [root], transcriptPath: agyPath };
  assert.deepEqual(await invoke(['kb', 'host-hook', '--host', 'claude'], { ...claudeEvent, cwd: other }), {});
  assert.deepEqual(await invoke(['kb', 'host-hook', '--host', 'agy'], { ...agyEvent, workspacePaths: [other] }), { decision: 'stop' });
  assert.equal(requests.length, 2);
  await invoke(['kb', 'host-hook', '--host', 'claude'], claudeEvent);
  await invoke(['kb', 'host-hook', '--host', 'agy'], { ...agyEvent, cwd: root, workspacePaths: [] });
  const repeated = await invoke(['kb', 'sync', '--host', 'claude,agy']);
  assert.deepEqual(repeated.hosts.map(item => item.processed), [0, 0]);
  assert.doesNotMatch(requests.at(-1).prompt, /HOST_CONFIGURATION_789012/);
  assert.deepEqual((await invoke(['kb', 'search', 'HOST_CONFIGURATION_789012', '--session', 'agy-session'])).results, []);
  const agyMemory = await assertExactSource(invoke, { host: 'agy', session: 'agy-session', path: agyPath, content: agyFact, rawContent: agyEnvelope, scope: 'turn' });
  assert.equal(agyMemory.content, agyFact);
  assert.deepEqual(agyMemory.sources, ['agy:agy-session:4']);
  const claudeMemory = await assertExactSource(invoke, { host: 'claude', session: 'claude-session', path: claudePath, content: claudeFact, scope: 'messages' });
  assert.equal(claudeMemory.content, 'claudenew preference');
  assert.deepEqual(claudeMemory.sources, ['claude:claude-session:u2']);
  const claudeChat = await invoke(['kb', 'conversation', claudeMemory.id, '--limit', '2']);
  assert.deepEqual(claudeChat.anchor, { messageId: claudeMemory.sources[0], page: 3 });
  assert.deepEqual(claudeChat.messages.map(item => item.content), [claudeFact, 'confirmed']);
  assert.equal(claudeChat.pagination.nextPage, null);
  assert.ok(claudeChat.commands.page);

  await writeFile(join(agyFolder, 'transcript_full.jsonl'), (await readFile(agyPath, 'utf8')) +
    agy(6, 'USER_INPUT', 'USER_EXPLICIT', 'Follow-up in the full transcript.'));
  const agyChat = await invoke(['kb', 'conversation', agyMemory.id, '--limit', '2']);
  assert.deepEqual(agyChat.anchor, { messageId: agyMemory.sources[0], page: 2 });
  assert.deepEqual(agyChat.messages.map(item => item.content), ['confirmed', agyFact]);
  assert.equal(agyChat.pagination.nextPage, 3);
  const agyEnd = await follow(invoke, agyChat.commands, 'page', { page: agyChat.pagination.nextPage });
  assert.deepEqual(agyEnd.messages.map(item => item.content), ['confirmed', 'Follow-up in the full transcript.']);
  assert.equal(agyEnd.pagination.nextPage, null);
  assert.equal(requests.length, 4);

  const off = await invoke(['kb', 'config', '--yes', '--host', 'off']);
  assert.ok(off.hosts.every(item => !item.configured));
  assert.deepEqual(JSON.parse(await readFile(claudeConfig, 'utf8')), { hooks: { Stop: [{ hooks: [independentHandler] }] }, permissions: { allow: [] } });
  assert.deepEqual(JSON.parse(await readFile(agyConfig, 'utf8')), { independent: { Stop: [independentHandler] } });
});

test('Agy user-scope hooks execute without quote mangling, capture signals/transcript_full, and support conversation closeout', async t => {
  const base = await mkdtemp(join(tmpdir(), 'memory-agy-user-'));
  const project = join(base, 'workspace with spaces');
  const agyHome = join(base, '.gemini', 'antigravity');
  const logsDir = join(agyHome, 'brain', 'agy-conv-1', '.system_generated', 'logs');
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const prompt = JSON.parse(body).messages.at(-1).content;
    requests.push(prompt);
    const id = prompt.match(/\[agy:[^\]]+]/)?.[0]?.slice(1, -1) ?? 'agy:agy-conv-1:0';
    if (prompt.includes('sources')) {
      response.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] }));
      return;
    }
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
      { scene_name: 'project', memories: [{ content: 'Prefer transcript_full.jsonl over truncated transcript.jsonl.', source_message_ids: [id] }] },
    ]) } }] }));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  await Promise.all([project, logsDir].map(dir => mkdir(dir, { recursive: true })));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const env = { ...process.env, HOME: base, USERPROFILE: base };
  for (const key of Object.keys(env)) if (key.startsWith('AGENT_MEMORY_LLM_')) delete env[key];
  const invoke = (args, input, code = 0) => runMemoryCli(project, env, args, input, code);

  // 1. User-scope configuration writes ~/.gemini/config/hooks.json and ~/.evolve/config.json.
  const cfg = await invoke(['kb', 'config', '--yes', '--scope', 'global', '--host', 'agy',
    '--base-url', `http://127.0.0.1:${server.address().port}/v1`, '--model', 'user-model', '--timeout-ms', '180000']);
  assert.equal(cfg.scope, 'user');
  assert.equal(cfg.model_configured, true);
  const userHooksPath = join(base, '.gemini', 'config', 'hooks.json');
  const userHooks = JSON.parse(await readFile(userHooksPath, 'utf8'));
  const stopCmd = userHooks['evolve-agent-memory'].Stop[0].command;
  const startCmd = userHooks['evolve-agent-memory'].SessionStart[0].command;
  assert.doesNotMatch(stopCmd, /--input-type=commonjs -e "const/);
  assert.match(stopCmd, /--root auto/);
  assert.match(startCmd, /session-start-hook --host agy --root auto/);

  // 2. Write truncated transcript.jsonl + full transcript_full.jsonl with user correction & error steps.
  const rowAgy = (step_index, type, source, content, extra = {}) => JSON.stringify({
    step_index, type, source, content, status: 'DONE', created_at: time, ...extra,
  }) + '\n';
  const truncPath = join(logsDir, 'transcript.jsonl');
  const fullPath = join(logsDir, 'transcript_full.jsonl');
  await writeFile(truncPath, rowAgy(0, 'USER_INPUT', 'USER_EXPLICIT', 'Truncated...', { truncated_fields: ['content'] }) +
    rowAgy(1, 'PLANNER_RESPONSE', 'MODEL', 'Short reply'));
  const fullUser = '<USER_REQUEST>\n不对，为什么还是报 SyntaxError？根因是 Antigravity 拆词破坏了引号，修复后请确认 transcript_full.jsonl 完整读取。\n</USER_REQUEST>\n<CONTEXT_SUMMARY>\nIGNORED_CTX\n</CONTEXT_SUMMARY>';
  await writeFile(fullPath,
    rowAgy(0, 'USER_INPUT', 'USER_EXPLICIT', fullUser) +
    JSON.stringify({ step_index: 1, type: 'RUN_COMMAND', status: 'ERROR', created_at: time, content: 'error 1' }) + '\n' +
    JSON.stringify({ step_index: 2, type: 'RUN_COMMAND', status: 'ERROR', created_at: time, content: 'error 2' }) + '\n' +
    rowAgy(3, 'PLANNER_RESPONSE', 'MODEL', '已定位根因，使用无引号参数并通过 transcript_full.jsonl 恢复。'));

  const db = new DatabaseSync(join(agyHome, 'conversation_summaries.db'));
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT, workspace_uris TEXT, parent_conversation_id TEXT)');
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run('agy-conv-1', JSON.stringify([pathToFileURL(project).href]), '');
  db.close();

  // 3. Simulate Antigravity Desktop naive whitespace splitting (shell: false, no quote stripping).
  const runSplitHook = async (command, payload) => {
    const [bin, ...hookArgs] = command.split(/\s+/);
    const resolvedBin = bin === 'node' ? process.execPath : bin;
    const child = spawn(resolvedBin, hookArgs, { env, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(JSON.stringify(payload));
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr + stdout);
    return JSON.parse(stdout);
  };

  const stopRes = await runSplitHook(stopCmd, {
    conversationId: 'agy-conv-1',
    workspacePaths: [project],
    transcriptPath: truncPath,
    terminationReason: 'NO_TOOL_CALL',
  });
  assert.deepEqual(stopRes, { decision: 'stop' });
  await waitForHookJob(project, 'agy-conv-1');
  assert.equal(requests.length, 1);
  assert.match(requests[0], /transcript_full\.jsonl/);
  assert.doesNotMatch(requests[0], /Truncated\.\.\.|IGNORED_CTX/);

  // 4. Verify deterministic reminder persisted and surfaced via SessionStart + acknowledged cleanly.
  const reminders = await invoke(['kb', 'reminders']);
  assert.ok(reminders.reminders.some(item => item.kind === 'evolve_signal'));
  assert.ok(reminders.reminders.some(item => item.kind === 'closeout_candidate'));
  const startRes = await runSplitHook(startCmd, {
    conversationId: 'agy-conv-2',
    workspacePaths: [project],
    cwd: project,
  });
  assert.match(startRes.injectSteps[0].systemMessage.systemMessage, /Self-evolution signals/);
  assert.match(startRes.injectSteps[0].systemMessage.systemMessage, /Knowledge closeout candidates/);

  const acked = await invoke(['kb', 'reminders', 'ack']);
  assert.equal(acked.remaining, 0);
  const cleanStart = await runSplitHook(startCmd, { conversationId: 'agy-conv-3', cwd: project });
  assert.deepEqual(cleanStart, {});

  // 5. Direct conversation closeout extracts candidate without manual messages.json.
  const closed = await invoke(['kb', 'harvest', 'conversation', 'agy-conv-1', '--host', 'agy', '--project', 'proj-1']);
  assert.equal(closed.session_id, 'agy-conv-1');
  assert.equal(closed.candidates.length, 1);
  assert.match(closed.candidates[0].content, /transcript_full\.jsonl/);
});
