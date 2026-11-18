import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { recordConversationSignals } from '../dist/memory-reminders.js';

const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
const time = '2026-11-16T00:00:00Z';
const row = (type, payload) => JSON.stringify({ timestamp: time, type, payload }) + '\n';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'evolve-migration-host-'));
  const root = join(base, "project's files");
  const other = join(base, 'other-project');
  const home = join(base, 'home');
  const codexHome = join(home, 'codex-config');
  const claudeHome = join(home, 'claude-config');
  await Promise.all([root, other, codexHome, claudeHome].map(path => mkdir(path, { recursive: true })));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome };
  for (const key of Object.keys(env)) if (key.startsWith('AGENT_MEMORY_LLM_')) delete env[key];
  t.after(async () => {
    assert.equal(dirname(resolve(base)), resolve(tmpdir()));
    await rm(base, { recursive: true, force: true });
  });

  async function invoke(args, input, expectedCode = 0) {
    const child = spawn(process.execPath, [cli, '--root', root, ...args], {
      cwd: root, env, windowsHide: true, shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    const [code] = await once(child, 'close');
    assert.equal(code, expectedCode, stderr + stdout);
    return stdout ? JSON.parse(stdout) : stderr;
  }

  async function transcript(session, cwd = root) {
    const sessions = join(codexHome, 'sessions');
    await mkdir(sessions, { recursive: true });
    const header = row('session_meta', { id: session, cwd, source: 'cli' });
    const messages = [['user', 'Keep the source project attached to this conversation.'], ['assistant', 'Confirmed.']];
    const content = messages.map(([role, text]) => row('response_item', {
      type: 'message', role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    })).join('');
    await writeFile(join(sessions, `rollout-${session}.jsonl`), header + content);
    return { source: `codex:${session}:${Buffer.byteLength(header)}`, messages: messages.map(([, text]) => text) };
  }

  return { root, other, home, claudeHome, env, invoke, transcript };
}

test('global episodic conversations use the actual project root in global and local scope', async t => {
  const f = await fixture(t);
  const session = 'global-source';
  const source = await f.transcript(session);
  const project = await f.invoke(['kb', 'conversation', session, '--host', 'codex', '--scope', 'project']);
  assert.deepEqual(project.messages.map(item => item.content), source.messages);
  const memory = await f.invoke(['kb', 'add', 'Source belongs to this project.', '--kind', 'episodic',
    '--scope', 'global', '--id', 'global-memory', '--session', session, '--evidence', source.source]);
  assert.equal(memory.scope, 'global');
  assert.equal(await f.invoke(['kb', 'get', memory.id, '--scope', 'project']), null);

  for (const scopeArgs of [['--scope', 'global'], []]) {
    const conversation = await f.invoke(['kb', 'conversation', memory.id, '--host', 'codex', ...scopeArgs]);
    assert.equal(conversation.session, session);
    assert.equal(conversation.memoryId, memory.rawId);
    assert.equal(conversation.anchor.messageId, source.source);
    assert.deepEqual(conversation.messages.map(item => item.content), source.messages);
  }
  const bySession = await f.invoke(['kb', 'conversation', session, '--host', 'codex', '--scope', 'global']);
  assert.deepEqual(bySession.messages.map(item => item.content), source.messages);
});

test('global episodic conversation lookup still rejects transcripts from another project', async t => {
  const f = await fixture(t);
  const session = 'foreign-source';
  const source = await f.transcript(session, f.other);
  const memory = await f.invoke(['kb', 'add', 'A record with a foreign source.', '--kind', 'episodic',
    '--scope', 'global', '--session', session, '--evidence', source.source]);
  for (const scopeArgs of [['--scope', 'global'], []]) {
    const error = await f.invoke(['kb', 'conversation', memory.id, '--host', 'codex', ...scopeArgs], undefined, 1);
    assert.match(error, /Conversation is unavailable in this project: foreign-source/);
  }
});

test('Claude user hooks use settings.json and preserve project-local and third-party configuration', async t => {
  const f = await fixture(t);
  const userPath = join(f.claudeHome, 'settings.json');
  const legacyLocalPath = join(f.claudeHome, 'settings.local.json');
  const original = {
    permissions: { allow: ['Read'] },
    hooks: {
      Stop: [{ matcher: 'kept-stop', hooks: [{ type: 'command', command: 'independent-stop' }] }],
      SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'independent-start' }] }],
    },
  };
  const legacyLocal = JSON.stringify({ description: 'Keep the home project local settings.' });
  await writeFile(userPath, JSON.stringify(original));
  await writeFile(legacyLocalPath, legacyLocal);
  const args = ['kb', 'config', '--scope', 'global', '--host', 'claude', '--yes'];
  const configured = await f.invoke(args);
  assert.equal(configured.hosts.find(item => item.host === 'claude').path, userPath);
  assert.equal(configured.hosts.find(item => item.host === 'claude').configured, true);
  const first = await readFile(userPath, 'utf8');
  const installed = JSON.parse(first);
  assert.deepEqual(installed.permissions, original.permissions);
  assert.deepEqual(installed.hooks.Stop[0], original.hooks.Stop[0]);
  assert.deepEqual(installed.hooks.SessionStart[0], original.hooks.SessionStart[0]);
  assert.equal(installed.hooks.Stop.length, 2);
  assert.equal(installed.hooks.SessionStart.length, 2);
  assert.match(installed.hooks.Stop[1].hooks[0].command, /--background/);
  assert.match(installed.hooks.SessionStart[1].hooks[0].command, /session-start-hook/);
  await f.invoke(args);
  assert.equal(await readFile(userPath, 'utf8'), first);
  assert.equal(await readFile(legacyLocalPath, 'utf8'), legacyLocal);
  await assert.rejects(readFile(join(f.home, '.claude', 'settings.json')), { code: 'ENOENT' });

  const project = await f.invoke(['kb', 'config', '--scope', 'project', '--host', 'claude', '--yes']);
  const projectPath = join(f.root, '.claude', 'settings.local.json');
  assert.equal(project.hosts.find(item => item.host === 'claude').path, projectPath);
  assert.equal(JSON.parse(await readFile(projectPath, 'utf8')).hooks.SessionStart.length, 1);
  await assert.rejects(readFile(join(f.root, '.claude', 'settings.json')), { code: 'ENOENT' });
  assert.equal(await readFile(legacyLocalPath, 'utf8'), legacyLocal);
  await f.invoke(['kb', 'config', '--scope', 'global', '--host', 'off', '--yes']);
  assert.deepEqual(JSON.parse(await readFile(userPath, 'utf8')), original);
});

test('Claude SessionStart adds actual reminders to model context and stays empty without reminders', async t => {
  const f = await fixture(t);
  // 只读取配置以避免缺模型提醒；本测试不会调用提取模型。
  f.env.AGENT_MEMORY_LLM_BASE_URL = 'http://127.0.0.1:1/v1';
  f.env.AGENT_MEMORY_LLM_MODEL = 'unused-fixture';
  const args = ['kb', 'session-start-hook', '--host', 'claude'];
  const event = { cwd: f.root, hook_event_name: 'SessionStart' };
  assert.deepEqual(await f.invoke(args, event), {});
  recordConversationSignals(f.root, { host: 'claude', session: 'corrected-session', messages: [
    { id: 'claude:corrected-session:1', role: 'user', content: '不对，请先记录这个会话的来源项目，再继续处理。' },
    { id: 'claude:corrected-session:2', role: 'assistant', content: '根因是全局记忆存储路径不能代替原始会话的项目根目录，需要分别传递。' },
  ] });
  const start = await f.invoke(args, event);
  assert.match(start.systemMessage, /Self-evolution signals/);
  assert.match(start.systemMessage, /Knowledge closeout candidates/);
  assert.match(start.systemMessage, /corrected-session/);
  assert.deepEqual(start.hookSpecificOutput, {
    hookEventName: 'SessionStart', additionalContext: start.systemMessage,
  });
  assert.deepEqual(await f.invoke(args, { ...event, cwd: f.other }), {});
  assert.equal((await f.invoke(['kb', 'reminders', 'ack'])).remaining, 0);
  assert.deepEqual(await f.invoke(args, event), {});
});
