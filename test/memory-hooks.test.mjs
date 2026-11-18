import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MemoryStore, defaultMemoryDbPath } from '../dist/memory.js';
import { enqueueMemoryHook, memoryHookJobsPath, readMemoryHookInput, readMemoryHookJobs } from '../dist/memory-hook-jobs.js';

const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
const time = '2026-11-16T00:00:00Z';
const row = (type, payload) => JSON.stringify({ timestamp: time, type, payload }) + '\n';
const message = (role, text, phase) => row('response_item', {
  type: 'message', role, phase,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
});
const turn = text => row('event_msg', { type: 'task_started' }) +
  message('user', text) + message('assistant', 'Saved.', 'final_answer');

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function bounded(promise, label, milliseconds = 5_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function waitFor(read, label) {
  const deadline = Date.now() + 5_000;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await delay(15);
  }
  assert.fail(label);
}

async function fixture(t, respond) {
  const base = await mkdtemp(join(tmpdir(), 'memory-hook-jobs-'));
  const root = join(base, "workspace's files");
  const home = join(base, 'home');
  await Promise.all([root, home].map(path => mkdir(path, { recursive: true })));
  const children = new Set();
  const responses = new Set();
  const requests = [];
  const server = createServer(async (request, response) => {
    responses.add(response);
    response.once('close', () => responses.delete(response));
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const prompt = input.messages.at(-1).content;
    const source = /\[([^\]]+)] \[user] \[[^\]]+]: ([\s\S]*?)(?=\n\n\[[^\]]+] \[(?:assistant|user)]|$)/.exec(prompt);
    const entry = { input, prompt, sourceId: source?.[1], content: source?.[2], response };
    requests.push(entry);
    if (respond) return respond(entry, requests.length);
    reply(entry);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude') };
  for (const key of Object.keys(env)) if (key.startsWith('AGENT_MEMORY_LLM_')) delete env[key];
  Object.assign(env, {
    AGENT_MEMORY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    AGENT_MEMORY_LLM_MODEL: 'hook-fixture', AGENT_MEMORY_LLM_TIMEOUT_MS: '5000',
  });

  function processCommand(executable, args, { input, keepOpen = false, expectedCode = 0 } = {}) {
    const child = spawn(executable, args, { cwd: root, env, windowsHide: true, shell: false });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = bounded(new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        children.delete(child);
        try {
          assert.equal(code, expectedCode, `${stderr}${stdout} (signal ${signal})`);
          resolve({ code, stdout, stderr, value: code === 0 && stdout ? JSON.parse(stdout) : undefined });
        } catch (error) { reject(error); }
      });
    }), `Foreground hook did not close: ${args.join(' ')}`).catch(error => {
      child.kill();
      throw error;
    });
    if (keepOpen) {
      if (input !== undefined) child.stdin.write(input);
    } else child.stdin.end(input);
    return { child, closed };
  }

  const start = (args, options = {}) => processCommand(process.execPath,
    [cli, '--root', root, ...args], options);
  const invoke = async (args, input, expectedCode = 0) => (await start(args, {
    input: input === undefined ? undefined : JSON.stringify(input), expectedCode,
  }).closed).value;
  const generated = (command, options) => process.platform === 'win32'
    ? processCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], options)
    : processCommand('sh', ['-c', command], options);
  const waitJob = (session, state = 'done') => waitFor(() => {
    const job = readMemoryHookJobs(root).find(item => item.session === session);
    if (state !== 'failed') assert.notEqual(job?.state, 'failed', job?.last_error);
    return job?.state === state && job;
  }, `Hook job ${session} did not reach ${state}: ${JSON.stringify(readMemoryHookJobs(root))}`);

  t.after(async () => {
    for (const child of children) child.kill();
    for (const response of responses) response.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const lockPath = join(memoryHookJobsPath(root), 'worker.lock');
    if (existsSync(lockPath)) {
      await waitFor(async () => !existsSync(lockPath), 'Background worker did not release its fixture lock');
    }
    await rm(base, { recursive: true, force: true });
  });
  return { root, home, env, requests, start, invoke, generated, waitJob };
}

function reply({ response, sourceId, content }) {
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
    { scene_name: 'project', memories: [{ content, type: 'work_fact', source_message_ids: [sourceId] }] },
  ]) } }] }));
}

async function transcript(root, session, fact) {
  const path = join(root, `${session}.jsonl`);
  await writeFile(path, row('session_meta', { id: session, cwd: root, source: 'cli' }) + turn(fact));
  return { path, event: { hook_event_name: 'Stop', session_id: session, transcript_path: path, cwd: root } };
}

function inspectMemories(root, inspect) {
  const memory = new MemoryStore(defaultMemoryDbPath(root), { readOnly: true });
  try { return inspect(memory); } finally { memory.close(); }
}

test('hook input decodes split UTF-8/BOM and rejects incomplete EOF or oversized objects', async () => {
  const input = new PassThrough();
  const value = { cwd: 'D:/工作区', note: '完整输入即返回' };
  const parsed = readMemoryHookInput(input, { timeoutMs: 500 });
  const bytes = Buffer.from('\uFEFF' + JSON.stringify(value));
  for (const byte of bytes) input.write(Buffer.from([byte]));
  assert.deepEqual(await parsed, value);
  assert.equal(input.writableEnded, false);
  assert.equal(input.destroyed, true);

  const incomplete = new PassThrough();
  const rejected = assert.rejects(readMemoryHookInput(incomplete), /one complete JSON object/);
  incomplete.end('{"cwd":');
  await rejected;
  const oversized = new PassThrough();
  const tooLarge = assert.rejects(readMemoryHookInput(oversized, { maxBytes: 4 }), /exceeds 4 bytes/);
  oversized.write('{"cwd":"root"}');
  await tooLarge;
});

test('complete hook JSON closes a foreground process with stdin still open and ignores unrelated events', async t => {
  const f = await fixture(t);
  const payload = '\uFEFF' + JSON.stringify({ cwd: f.root, note: '跨块中文输入' });
  const active = f.start(['kb', 'host-hook', '--host', 'agy', '--background'], { keepOpen: true });
  const bytes = Buffer.from(payload);
  for (let offset = 0; offset < bytes.length; offset += 3) {
    await new Promise((resolve, reject) => active.child.stdin.write(bytes.subarray(offset, offset + 3),
      error => error ? reject(error) : resolve()));
  }
  assert.deepEqual((await active.closed).value, { decision: 'stop' });
  assert.equal(active.child.stdin.writableEnded, false);
  const saved = await transcript(f.root, 'unrelated', 'Use a separate workspace for extraction.');
  assert.deepEqual(await f.invoke(['kb', 'codex-hook', '--background'], {
    ...saved.event, cwd: f.home,
  }), {});
  assert.deepEqual(await f.invoke(['kb', 'host-hook', '--host', 'agy', '--background'], {
    conversationId: 'ignored-error', cwd: f.root, transcriptPath: saved.path, error: 'failed turn',
  }), { decision: 'stop' });
  assert.deepEqual(readMemoryHookJobs(f.root), []);
  assert.equal(f.requests.length, 0);
  const malformed = await f.start(['kb', 'session-start-hook', '--host', 'codex'], {
    input: '{"cwd":', expectedCode: 1,
  }).closed;
  assert.match(malformed.stderr, /one complete JSON object/);
});

test('background Stop closes before the model responds, merges duplicates and preserves a newer running event', async t => {
  const firstRequest = deferred();
  const releaseFirst = deferred();
  const f = await fixture(t, async (entry, number) => {
    if (number === 1) { firstRequest.resolve(entry); await releaseFirst.promise; }
    reply(entry);
  });
  t.after(() => releaseFirst.resolve());
  const firstFact = '不对，根因是结束流程必须先保存后台任务，再交还控制权。';
  const saved = await transcript(f.root, 'running-session', firstFact);
  const foreground = f.start(['kb', 'codex-hook', '--background'], {
    input: JSON.stringify(saved.event), keepOpen: true,
  });
  assert.deepEqual((await foreground.closed).value, {});
  assert.equal(foreground.child.stdin.writableEnded, false);
  await bounded(firstRequest.promise, 'Background worker never called the model');
  assert.equal(inspectMemories(f.root, memory => memory.list().results.length), 0);
  await Promise.all(Array.from({ length: 3 }, () => f.invoke(['kb', 'codex-hook', '--background'], saved.event)));
  assert.equal(f.requests.length, 1);
  const secondFact = '后台提取必须保留新到达的完整对话回合。';
  await appendFile(saved.path, turn(secondFact));
  await f.invoke(['kb', 'codex-hook', '--background'], saved.event);
  const pending = readMemoryHookJobs(f.root)[0];
  assert.equal(pending.generation, 2);
  assert.equal(pending.state, 'pending');
  releaseFirst.resolve();
  const job = await f.waitJob('running-session');
  assert.equal(job.generation, 2);
  assert.equal(job.attempts, 2);
  assert.equal(f.requests.length, 2);
  const contents = inspectMemories(f.root, memory => {
    const records = memory.list().results;
    for (const record of records) {
      assert.match(record.sourceMessageIds[0], /^codex:running-session:\d+$/);
      assert.equal(memory.sources(record.id)[0].location.path, saved.path);
    }
    assert.equal(memory.extractionOffset('codex', 'running-session'), Buffer.byteLength(
      row('session_meta', { id: 'running-session', cwd: f.root, source: 'cli' }) + turn(firstFact) + turn(secondFact)));
    return records.map(record => record.content).sort();
  });
  assert.deepEqual(contents, [firstFact, secondFact].sort());
  await f.invoke(['kb', 'codex-hook', '--background'], saved.event);
  assert.equal(readMemoryHookJobs(f.root)[0].generation, 2);
  assert.equal(f.requests.length, 2);

  const start = await f.invoke(['kb', 'session-start-hook', '--host', 'codex'], { cwd: f.root });
  assert.match(start.systemMessage, /Self-evolution signals/);
  assert.match(start.systemMessage, /Knowledge closeout candidates/);
  assert.equal(start.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(start.hookSpecificOutput.additionalContext, start.systemMessage);
  assert.equal((await f.invoke(['kb', 'reminders', 'ack'])).remaining, 0);
  assert.deepEqual(await f.invoke(['kb', 'session-start-hook', '--host', 'codex'], { cwd: f.root }), {});
});

test('failed background extraction is visible and an explicit retry completes without losing progress', async t => {
  let fail = true;
  const f = await fixture(t, entry => fail ? entry.response.writeHead(503).end() : reply(entry));
  const saved = await transcript(f.root, 'retry-session', 'The team uses a separate extraction workspace.');
  await f.invoke(['kb', 'codex-hook', '--background'], saved.event);
  const failed = await f.waitJob('retry-session', 'failed');
  assert.match(failed.last_error, /HTTP 503/);
  const listed = await f.invoke(['kb', 'hook-jobs']);
  assert.equal(listed.jobs[0].state, 'failed');
  assert.equal(listed.jobs[0].event, undefined);
  assert.equal((await f.invoke(['kb', 'reminders'])).hook_jobs[0].state, 'failed');
  const start = await f.invoke(['kb', 'session-start-hook', '--host', 'codex'], { cwd: f.root });
  assert.match(start.hookSpecificOutput.additionalContext, /Memory extraction failed/);
  assert.match(start.systemMessage, /hook-jobs retry/);
  assert.equal(inspectMemories(f.root, memory => memory.extractionOffset('codex', 'retry-session')), 0);
  fail = false;
  assert.equal((await f.invoke(['kb', 'hook-jobs', 'retry', failed.id])).retried, 1);
  const finished = await f.waitJob('retry-session');
  assert.equal(finished.attempts, 2);
  assert.equal(finished.last_error, undefined);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(inspectMemories(f.root, memory => memory.list().results.map(item => item.content)),
    ['The team uses a separate extraction workspace.']);
  assert.deepEqual(await f.invoke(['kb', 'session-start-hook', '--host', 'codex'], { cwd: f.root }), {});
});

test('a new worker recovers a dead PID lock and a persisted running job', async t => {
  const f = await fixture(t);
  const saved = await transcript(f.root, 'crash-session', 'Extraction resumes from the saved complete turn.');
  const { job } = await enqueueMemoryHook(f.root, 'codex', saved.event, { session: 'crash-session', path: saved.path });
  const dead = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await once(dead, 'close');
  assert.throws(() => process.kill(dead.pid, 0), error => error.code === 'ESRCH');
  await writeFile(join(memoryHookJobsPath(f.root), `${job.id}.json`), JSON.stringify({ ...job, state: 'running', attempts: 1 }));
  await writeFile(join(memoryHookJobsPath(f.root), 'worker.lock'), JSON.stringify({ pid: dead.pid, token: 'crashed-worker' }));
  const drained = await f.invoke(['kb', 'hook-worker']);
  assert.deepEqual(drained, { processed: 1, failed: 0, already_running: false });
  assert.equal((await f.waitJob('crash-session')).attempts, 2);
  assert.equal(existsSync(join(memoryHookJobsPath(f.root), 'worker.lock')), false);
  assert.equal(f.requests.length, 1);
  assert.equal(inspectMemories(f.root, memory => memory.list().results.length), 1);
});

test('Codex hook configuration preserves third-party handlers, replaces legacy commands and is reversible', async t => {
  const f = await fixture(t);
  const config = join(f.root, '.codex', 'hooks.json');
  await mkdir(join(f.root, '.codex'));
  const stop = { type: 'command', command: 'independent-stop' };
  const start = { type: 'command', command: 'independent-start' };
  const original = { description: 'Keep existing settings', hooks: {
    Stop: [{ matcher: 'kept-stop', hooks: [stop] }],
    SessionStart: [{ matcher: 'resume', hooks: [start] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'independent-tool' }] }],
  } };
  const seeded = structuredClone(original);
  seeded.hooks.Stop[0].hooks.push({ type: 'command', command: "node old/dist/cli.js memory codex-hook --root old",
    statusMessage: 'Extracting Agent Memory from Codex' });
  seeded.hooks.SessionStart[0].hooks.push({ type: 'command', command: 'node old/dist/cli.js memory session-start-hook --host codex',
    statusMessage: 'Loading Agent Memory reminders for Codex' });
  await writeFile(config, JSON.stringify(seeded));
  await f.invoke(['kb', 'config', '--yes', '--host', 'codex']);
  const first = await readFile(config, 'utf8');
  const installed = JSON.parse(first);
  assert.equal(installed.description, original.description);
  assert.deepEqual(installed.hooks.Stop[0], original.hooks.Stop[0]);
  assert.deepEqual(installed.hooks.SessionStart[0], original.hooks.SessionStart[0]);
  assert.deepEqual(installed.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.equal(installed.hooks.Stop.length, 2);
  assert.equal(installed.hooks.SessionStart.length, 2);
  const ownStop = installed.hooks.Stop[1].hooks[0].command;
  const ownStart = installed.hooks.SessionStart[1].hooks[0].command;
  assert.match(ownStop, /workflow-cli\.js/);
  assert.match(ownStop, /codex-hook/);
  assert.match(ownStop, /--background/);
  assert.doesNotMatch(ownStop, /old\/dist\/cli\.js|memory codex-hook/);
  assert.match(ownStart, /session-start-hook/);
  assert.doesNotMatch(ownStart, /--background/);
  await f.invoke(['kb', 'config', '--yes', '--host', 'codex']);
  assert.equal(await readFile(config, 'utf8'), first);
  const generated = f.generated(ownStop, { input: JSON.stringify({ cwd: f.root }), keepOpen: true });
  assert.deepEqual((await generated.closed).value, {});
  assert.equal(generated.child.stdin.writableEnded, false);
  await f.invoke(['kb', 'config', '--yes', '--host', 'off']);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
});
