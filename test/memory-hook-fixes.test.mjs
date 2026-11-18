import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MemoryStore, defaultMemoryDbPath } from '../dist/memory.js';
import { enqueueMemoryHook, memoryHookJobsPath, readMemoryHookJobs } from '../dist/memory-hook-jobs.js';
import { readReminders, recordConversationSignals, remindersPath } from '../dist/memory-reminders.js';

const modules = Object.fromEntries(['common', 'memory-hook-jobs', 'memory-reminders'].map(name =>
  [name, new URL(`../dist/${name}.js`, import.meta.url).href]));
const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
const time = '2026-11-16T00:00:00Z';
const row = (type, payload) => JSON.stringify({ timestamp: time, type, payload }) + '\n';
const message = (role, text, phase) => row('response_item', {
  type: 'message', role, phase,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
});
const signal = (session, host = 'codex') => ({ host, session, messages: [{
  id: `${host}:${session}:1`, role: 'assistant',
  content: `根因是先保存 ${session} 的后台任务，再允许会话结束，这条约束需要保留。`,
}] });

async function waitFor(read, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  assert.fail(label);
}

const childPrelude = `
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const config = JSON.parse(process.argv[1]);
const { root, gates, modules } = config;
const notify = (type, fields = {}) => process.send?.({ type, ...fields });
const released = name => fs.existsSync(join(gates, name));
function gate(name, fields = {}) {
  notify('gate', { name, ...fields });
  const deadline = Date.now() + 4_000;
  while (!released(name)) {
    if (Date.now() >= deadline) throw new Error('Gate was not released: ' + name);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
async function asyncGate(name) {
  const deadline = Date.now() + 4_000;
  while (!released(name)) {
    if (Date.now() >= deadline) throw new Error('Gate was not released: ' + name);
    await delay(10);
  }
}
if (config.traceTransactions) {
  const { DatabaseSync } = await import(modules.common);
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql, ...args) {
    if (/^BEGIN IMMEDIATE$/i.test(sql)) notify('transaction-attempt');
    return exec.call(this, sql, ...args);
  };
}
`;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'memory-hook-fixes-'));
  const root = join(base, "workspace's files");
  const home = join(base, 'home');
  const gates = join(base, 'gates');
  await Promise.all([root, home, gates].map(path => mkdir(path, { recursive: true })));
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude') };
  for (const key of Object.keys(env)) if (key.startsWith('AGENT_MEMORY_LLM_')) delete env[key];
  const children = new Set();
  const knownGates = new Set();
  const servers = new Set();

  function start(executable, args, options = {}) {
    const child = spawn(executable, args, { cwd: root, env: { ...env, ...options.env },
      windowsHide: true, shell: false, stdio: options.ipc ? ['pipe', 'pipe', 'pipe', 'ipc'] : 'pipe' });
    const handle = { child, messages: [], stdout: '', stderr: '', result: undefined };
    handle.closed = new Promise(resolve => {
      child.once('error', error => { handle.error = error; });
      child.once('close', (code, termSignal) => {
        handle.result = { code, signal: termSignal };
        resolve(handle.result);
      });
    });
    children.add(handle);
    child.stdout.on('data', chunk => { handle.stdout += chunk; });
    child.stderr.on('data', chunk => { handle.stderr += chunk; });
    child.on('message', item => {
      handle.messages.push(item);
      if (item.type === 'gate') knownGates.add(item.name);
    });
    child.stdin.end(options.input);
    return handle;
  }

  const source = (code, options = {}) => start(process.execPath, ['--input-type=module', '-e',
    childPrelude + '\ntry {\n' + code + '\n} catch (error) { console.error(error); process.exitCode = 1; }\nfinally { if (process.connected) process.disconnect(); }',
    JSON.stringify({ root, gates, modules, ...options.data })], { ...options, ipc: true });
  const release = async name => { knownGates.add(name); await writeFile(join(gates, name), ''); };
  const marker = (handle, predicate, label) => waitFor(() => {
    const item = handle.messages.find(predicate);
    if (!item && handle.result) assert.fail(`${label}: process closed ${JSON.stringify(handle.result)} ${handle.stderr}`);
    return item;
  }, label);
  const joined = async (handle, expectedCode = 0) => {
    await waitFor(() => handle.result, `Child did not close: ${handle.stderr}`);
    assert.ifError(handle.error);
    assert.equal(handle.result.code, expectedCode, handle.stderr + handle.stdout);
    assert.equal(handle.result.signal, null);
    return handle.stdout ? JSON.parse(handle.stdout) : undefined;
  };
  const invoke = async (args, input, overrides = {}) => joined(start(process.execPath,
    [cli, '--root', root, ...args], { input: input === undefined ? undefined : JSON.stringify(input), env: overrides }));

  t.after(async () => {
    for (const name of knownGates) await release(name);
    for (const handle of children) if (!handle.result) handle.child.kill();
    await Promise.all([...children].map(handle => handle.closed));
    const lock = join(memoryHookJobsPath(root), 'worker.lock');
    if (existsSync(lock)) {
      await waitFor(() => !existsSync(lock), 'Detached fixture worker did not release its lock');
    }
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(base, { recursive: true, force: true });
  });

  async function model() {
    const requests = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const prompt = input.messages.at(-1).content;
      const parsed = /\[([^\]]+)] \[user] \[[^\]]+]: ([\s\S]*?)(?=\n\n\[[^\]]+] \[(?:assistant|user)]|$)/.exec(prompt);
      requests.push({ input, sourceId: parsed?.[1], content: parsed?.[2] });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
        { scene_name: 'project', memories: [{ type: 'work_fact', content: parsed?.[2], source_message_ids: [parsed?.[1]] }] },
      ]) } }] }));
    });
    servers.add(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { requests, env: { AGENT_MEMORY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      AGENT_MEMORY_LLM_MODEL: 'hook-fix-fixture', AGENT_MEMORY_LLM_TIMEOUT_MS: '5000' } };
  }
  return { root, home, gates, env, source, marker, release, joined, invoke, model, start };
}

function inspectMemory(root, inspect) {
  const memory = new MemoryStore(defaultMemoryDbPath(root), { readOnly: true });
  try { return inspect(memory); } finally { memory.close(); }
}

async function savedTranscript(root, session, fact) {
  const path = join(root, `${session}.jsonl`);
  const content = row('session_meta', { id: session, cwd: root, source: 'cli' }) +
    row('event_msg', { type: 'task_started' }) + message('user', fact) + message('assistant', 'Saved.', 'final_answer');
  await writeFile(path, content);
  return { path, content, event: { hook_event_name: 'Stop', session_id: session, cwd: root, transcript_path: path } };
}

const workerSource = `
const jobs = await import(modules['memory-hook-jobs']);
const lockPath = join(jobs.memoryHookJobsPath(root), 'worker.lock');
if (config.pauseRecovery) {
  const remove = fs.rmSync;
  let paused = false;
  fs.rmSync = function(path, ...args) {
    if (path === lockPath && !paused) { paused = true; gate('stale-before-unlink'); }
    return remove.call(this, path, ...args);
  };
  syncBuiltinESMExports();
}
const result = await jobs.drainMemoryHookJobs(root, async () => {
  const active = join(root, 'active-worker');
  let owned = false;
  try { fs.writeFileSync(active, String(process.pid), { flag: 'wx' }); owned = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; notify('overlap'); }
  notify('entered');
  try { await asyncGate(config.finishGate); }
  finally { if (owned) fs.rmSync(active); }
});
console.log(JSON.stringify(result));
`;

async function staleJob(f) {
  const saved = await savedTranscript(f.root, 'stale-session', 'Only one worker may extract a session at a time.');
  const { job } = await enqueueMemoryHook(f.root, 'codex', saved.event, { session: 'stale-session', path: saved.path });
  const dead = f.start(process.execPath, ['-e', '']);
  await f.joined(dead);
  assert.throws(() => process.kill(dead.child.pid, 0), error => error.code === 'ESRCH');
  await writeFile(join(memoryHookJobsPath(f.root), 'worker.lock'), JSON.stringify({ pid: dead.child.pid, token: 'dead-owner' }));
  return job;
}

test('stale worker recovery serializes the compare-unlink window across real processes', async t => {
  const f = await fixture(t);
  const job = await staleJob(f);
  const first = f.source(workerSource, { data: { pauseRecovery: true, finishGate: 'first-finish' } });
  await f.marker(first, item => item.type === 'gate', 'First worker did not reach stale unlink');
  const second = f.source(workerSource, { data: { traceTransactions: true, finishGate: 'second-finish' } });
  await f.marker(second, item => ['transaction-attempt', 'entered'].includes(item.type), 'Second worker did not attempt recovery');
  await f.release('stale-before-unlink');
  await f.marker(first, item => item.type === 'entered', 'First worker never entered extraction');
  await f.release('first-finish');
  await f.release('second-finish');
  const results = await Promise.all([f.joined(first), f.joined(second)]);
  assert.equal([...first.messages, ...second.messages].some(item => item.type === 'overlap'), false,
    'Two workers entered extraction while recovering the same stale lock');
  assert.equal(first.stderr.includes('ownership changed') || second.stderr.includes('ownership changed'), false);
  assert.equal(results.reduce((total, result) => total + result.processed, 0), 1);
  const finished = readMemoryHookJobs(f.root).find(item => item.id === job.id);
  assert.equal(finished.state, 'done');
  assert.equal(finished.attempts, 1);
  assert.equal(existsSync(join(memoryHookJobsPath(f.root), 'worker.lock')), false);
});

test('a claimant killed during stale recovery releases coordination for a replacement worker', async t => {
  const f = await fixture(t);
  await staleJob(f);
  const owner = f.source(workerSource, { data: { pauseRecovery: true, finishGate: 'killed-finish' } });
  await f.marker(owner, item => item.type === 'gate', 'Claimant did not reach recovery');
  owner.child.kill();
  await owner.closed;
  await f.release('replacement-finish');
  const replacement = f.source(workerSource, { data: { finishGate: 'replacement-finish' } });
  assert.equal((await f.joined(replacement)).processed, 1);
  assert.equal(readMemoryHookJobs(f.root)[0].state, 'done');
});

test('unconfigured background extraction fails visibly and retries the unchanged transcript after configuration', async t => {
  const f = await fixture(t);
  const saved = await savedTranscript(f.root, 'model-later', 'Use the isolated model endpoint for extraction.');
  assert.deepEqual(await f.invoke(['kb', 'codex-hook'], saved.event), {});
  assert.equal(inspectMemory(f.root, memory => memory.extractionOffset('codex', 'model-later')), 0);
  assert.equal(inspectMemory(f.root, memory => memory.list().results.length), 0);
  assert.deepEqual(await f.invoke(['kb', 'codex-hook', '--background'], saved.event), {});
  const failed = await waitFor(() => {
    const job = readMemoryHookJobs(f.root)[0];
    return job && ['done', 'failed'].includes(job.state) && job;
  }, 'Unconfigured worker did not settle');
  assert.equal(failed.state, 'failed', 'Missing model configuration must not become a completed extraction');
  assert.match(failed.last_error, /configur|base.?url|model/i);
  assert.equal(inspectMemory(f.root, memory => memory.extractionOffset('codex', 'model-later')), 0);
  assert.equal(inspectMemory(f.root, memory => memory.list().results.length), 0);
  const model = await f.model();
  assert.equal((await f.invoke(['kb', 'hook-jobs', 'retry', failed.id], undefined, model.env)).retried, 1);
  const done = await waitFor(() => {
    const job = readMemoryHookJobs(f.root)[0];
    assert.notEqual(job.state, 'failed', job.last_error);
    return job.state === 'done' && job;
  }, 'Configured retry did not complete');
  assert.equal(done.attempts, 2);
  assert.equal(done.last_error, undefined);
  assert.equal(model.requests.length, 1);
  inspectMemory(f.root, memory => {
    const [record] = memory.list().results;
    assert.equal(record.content, 'Use the isolated model endpoint for extraction.');
    assert.equal(memory.sources(record.id)[0].location.path, saved.path);
    assert.equal(memory.extractionOffset('codex', 'model-later'), Buffer.byteLength(saved.content));
  });
  await f.invoke(['kb', 'codex-hook', '--background'], saved.event, model.env);
  assert.equal(model.requests.length, 1);
  assert.equal(readMemoryHookJobs(f.root)[0].attempts, 2);
});

const reminderOperation = `
const reminders = await import(modules['memory-reminders']);
const target = reminders.remindersPath(root);
const read = fs.readFileSync;
let readPaused = false;
fs.readFileSync = function(path, ...args) {
  const value = read.call(this, path, ...args);
  if (path === target && !readPaused) { readPaused = true; gate(config.readGate); }
  return value;
};
syncBuiltinESMExports();
const result = config.operation === 'append'
  ? reminders.recordConversationSignals(root, config.signal)
  : reminders.acknowledgeReminders(root, config.exactId);
console.log(JSON.stringify(result));
`;

async function concurrentReminders(t, firstOperation, ackAll = false) {
  const f = await fixture(t);
  const [old] = recordConversationSignals(f.root, signal('old-session'));
  const operation = (name, readGate, traceTransactions = false) => f.source(reminderOperation, { data: {
    operation: name, readGate, traceTransactions, signal: signal('new-session', 'agy'),
    ...(ackAll ? {} : { exactId: old.id }),
  } });
  const first = operation(firstOperation, 'first-read');
  await f.marker(first, item => item.type === 'gate', 'First reminder operation did not read the store');
  const second = operation(firstOperation === 'ack' ? 'append' : 'ack', 'second-read', true);
  await f.marker(second, item => item.type === 'transaction-attempt' || item.type === 'gate',
    'Second reminder operation made no progress');
  await f.release('first-read');
  await f.joined(first);
  await f.release('second-read');
  await f.joined(second);
  const all = readReminders(f.root, true);
  assert.equal(all.length, 2, 'Concurrent acknowledgement must retain the newly appended reminder');
  assert.equal(all.find(item => item.id === old.id).acknowledged, true, 'Acknowledged reminder was resurrected');
  const next = all.find(item => item.session_id === 'new-session');
  assert.ok(next, 'New reminder was lost');
  assert.equal(Boolean(next.acknowledged), ackAll && firstOperation === 'append');
  assert.deepEqual(readReminders(f.root).map(item => item.session_id),
    ackAll && firstOperation === 'append' ? [] : ['new-session']);
}

test('exact-ID acknowledgement before append preserves the acknowledgement and the new reminder', async t => {
  await concurrentReminders(t, 'ack');
});

test('append before exact-ID acknowledgement preserves the new reminder and acknowledgement', async t => {
  await concurrentReminders(t, 'append');
});

test('ack-all applies to the serialized snapshot when append follows acknowledgement', async t => {
  await concurrentReminders(t, 'ack', true);
});

test('ack-all includes a reminder appended before the acknowledgement transaction', async t => {
  await concurrentReminders(t, 'append', true);
});

test('readers observe a complete old reminder payload until atomic replacement commits', async t => {
  const f = await fixture(t);
  recordConversationSignals(f.root, signal('old-session'));
  const before = await readFile(remindersPath(f.root), 'utf8');
  const writer = f.source(`
const reminders = await import(modules['memory-reminders']);
const target = reminders.remindersPath(root);
const rename = fs.renameSync;
const write = fs.writeFileSync;
fs.renameSync = function(from, to, ...args) {
  if (to === target) gate('before-commit');
  return rename.call(this, from, to, ...args);
};
fs.writeFileSync = function(path, data, ...args) {
  if (path !== target) return write.call(this, path, data, ...args);
  // 将直接覆盖的合法写入窗口停在半份内容，观察无锁读取者的真实行为。
  const bytes = Buffer.from(data);
  const middle = Math.floor(bytes.length / 2);
  const fd = fs.openSync(path, 'w');
  try {
    fs.writeSync(fd, bytes, 0, middle);
    gate('before-commit');
    fs.writeSync(fd, bytes, middle, bytes.length - middle);
  } finally { fs.closeSync(fd); }
};
syncBuiltinESMExports();
console.log(JSON.stringify(reminders.recordConversationSignals(root, config.signal)));
`, { data: { signal: signal('new-session', 'agy') } });
  await f.marker(writer, item => item.type === 'gate', 'Writer did not reach its commit');
  for (let index = 0; index < 10; index++) {
    assert.doesNotThrow(() => readReminders(f.root));
    assert.equal(await readFile(remindersPath(f.root), 'utf8'), before);
    assert.deepEqual(readReminders(f.root).map(item => item.session_id), ['old-session']);
  }
  await f.release('before-commit');
  await f.joined(writer);
  assert.deepEqual(readReminders(f.root).map(item => item.session_id), ['old-session', 'new-session']);
  assert.equal(JSON.parse(await readFile(remindersPath(f.root), 'utf8')).items.length, 2);
});

test('mixed-host and legacy reminders retain their source host and exact session in every host notice', async t => {
  const f = await fixture(t);
  recordConversationSignals(f.root, signal('agy-current', 'agy'));
  recordConversationSignals(f.root, signal('codex-current', 'codex'));
  recordConversationSignals(f.root, signal('legacy-agy', 'agy'));
  const stored = JSON.parse(await readFile(remindersPath(f.root), 'utf8'));
  const legacy = stored.items.find(item => item.session_id === 'legacy-agy');
  delete legacy.host;
  legacy.recommended_command = 'evolve closeout conversation legacy-agy --host agy --project fixture-project';
  await writeFile(remindersPath(f.root), JSON.stringify(stored));
  const notices = await f.joined(f.source(`
const { buildSessionStartNotice } = await import(modules['memory-reminders']);
console.log(JSON.stringify(['codex', 'agy'].map(host => buildSessionStartNotice(root, host))));
`));
  for (const notice of notices) {
    assert.ok(notice.includes('evolve kb harvest conversation agy-current --host agy --project <project-id>'), notice);
    assert.ok(notice.includes('evolve kb harvest conversation codex-current --host codex --project <project-id>'), notice);
    assert.ok(notice.includes('evolve kb harvest conversation legacy-agy --host agy --project fixture-project'), notice);
    assert.doesNotMatch(notice, /evolve closeout conversation|<session-id>/);
  }
});
