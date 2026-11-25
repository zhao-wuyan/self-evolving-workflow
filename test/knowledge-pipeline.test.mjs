import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from '../dist/common.js';
import { MemoryStore, defaultMemoryDbPath } from '../dist/memory.js';
import { WorkflowStore, readNativeCloseoutJobs, readEvolveSessions, workflowDbPath } from '../dist/workflow-runtime.js';
import { drainNativeCloseouts, processNativeCloseout } from '../dist/native-closeout.js';
import { KnowledgeReads, validateKnowledgeReads } from '../dist/knowledge-reads.js';
import { migrateKnowledgeStorage } from '../dist/storage-migration.js';
import { inspectMemoryHooks } from '../dist/memory-config.js';
import { collectHistorySignals } from '../dist/history-signals.js';

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'evolve-pipeline-'));
  // A detached worker can still be exiting with the fixture cwd open on Windows.
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
  return root;
}

test('Session completion and frozen evidence outbox are atomic; retries stage candidates only once', async t => {
  const root = temp(t);
  const store = new WorkflowStore(root);
  const memory = new MemoryStore(defaultMemoryDbPath(root));
  try {
    // A decision-only chain avoids host Skills; the same completion transaction is used for all Sessions.
    store.open('session-a', 'Check durable rule', 'Explicit approval', [
      { id: 'decision-1', command: '', args: [], kind: 'decision', decision_ref: 'review-1' },
    ], { actor: 'test' });
    store.decide('session-a', 'review-1', 'proceed', 'Confirmed durable check', { actor: 'test', evidence: ['test:approval'] });
    await memory.put({ id: 'm1', session: 'session-a', type: 'verified_fix', content: 'A proven fix with reproducible evidence', sourceMessageIds: ['test:fix'] });
    await memory.put({ id: 'other', session: 'session-b', type: 'verified_fix', content: 'Unrelated session secret', sourceMessageIds: ['test:other'] });
    const db = new DatabaseSync(workflowDbPath(root));
    try {
      db.exec("CREATE TRIGGER force_rollback BEFORE INSERT ON requests WHEN NEW.id='fail-complete' BEGIN SELECT RAISE(ABORT, 'forced'); END");
      assert.throws(() => store.completeSession('session-a', { actor: 'test', requestId: 'fail-complete' }), /forced/);
      assert.equal(readNativeCloseoutJobs(root).length, 0);
      assert.equal(readEvolveSessions(root, 'session-a')[0].status, 'open');
      db.exec('DROP TRIGGER force_rollback');
    } finally { db.close(); }
    const done = store.completeSession('session-a', { actor: 'test', requestId: 'finish' }, 'fixture');
    assert.equal(done.closeout_state, 'pending');
    assert.equal(readNativeCloseoutJobs(root).length, 1);
    const snapshot = readNativeCloseoutJobs(root)[0].receipt;
    assert.ok(snapshot.messages.some(m => m.id === 'memory:m1@1' && m.content.includes('test:fix')));
    assert.ok(snapshot.messages.some(m => m.id.startsWith('decision:') && m.content.includes('Confirmed durable check')));
    assert.ok(snapshot.messages.every(m => !m.content.includes('Unrelated session secret')));
    await memory.put({ id: 'late', session: 'session-a', type: 'verified_fix', content: 'Late addition', sourceMessageIds: ['test:late'] });
    assert.deepEqual(readNativeCloseoutJobs(root)[0].receipt, snapshot);

    const fail = await drainNativeCloseouts(root, () => ({ async chat() { throw new Error('mock failed'); } }));
    assert.equal(fail.errors.length, 1);
    assert.equal(readNativeCloseoutJobs(root)[0].state, 'failed');
    assert.equal(readNativeCloseoutJobs(root)[0].attempts, 1);
    let calls = 0;
    const model = () => ({
      async chat() {
        calls++;
        return JSON.stringify([{ memories: [{
          type: 'deterministic_check', content: 'Validate the confirmed rule in a regression test.',
          source_message_ids: ['memory:m1@1', 'session:objective'],
        }] }]);
      },
    });
    const retry = await drainNativeCloseouts(root, model, true);
    assert.equal(retry.results.length, 1);
    assert.equal(retry.results[0].candidates, 1);
    assert.equal(readNativeCloseoutJobs(root)[0].state, 'done');
    assert.equal(readNativeCloseoutJobs(root)[0].attempts, 2);
    const replay = await processNativeCloseout(root, 'session-a', model);
    assert.equal(replay.replayed, true);
    assert.equal(replay.candidates[0].candidate_kind, 'deterministic_check');
    assert.equal(calls, 1);
    assert.equal(existsSync(join(root, 'wiki', 'entries')), false);
  } finally { memory.close(); store.close(); }
});

test('CLI Session completion dispatches candidate extraction without a manual harvest', async t => {
  const root = temp(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const store = new WorkflowStore(root);
  try {
    store.open('auto-session', 'Check automatic closeout', 'Validate dispatch', [
      { id: 'decision-1', command: '', args: [], kind: 'decision', decision_ref: 'review-1' },
    ], { actor: 'test' });
    store.decide('auto-session', 'review-1', 'proceed', 'Confirmed', { actor: 'test', evidence: ['test:approval'] });
  } finally { store.close(); }
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { /* drain request */ }
    calls++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) if (key.startsWith('AGENT_MEMORY_LLM_')) delete env[key];
  Object.assign(env, { AGENT_MEMORY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, AGENT_MEMORY_LLM_MODEL: 'fixture', AGENT_MEMORY_LLM_TIMEOUT_MS: '5000' });
  try {
    const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [cli, '--root', root, 'session', 'complete', '--session', 'auto-session'], { cwd: root, env, timeout: 10000 });
    assert.equal(JSON.parse(stdout).closeout_state, 'pending');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const [job] = readNativeCloseoutJobs(root);
      if (job?.state === 'failed') assert.fail(job.last_error);
      if (job?.state === 'done' && !existsSync(join(root, '.evolve', 'closeout-worker.lock'))) break;
      await delay(50);
    }
    assert.equal(readNativeCloseoutJobs(root)[0]?.state, 'done');
    assert.equal(calls, 1);
    assert.equal(existsSync(join(root, 'wiki', 'entries')), false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('feedback is bound to a consumed version and cannot be fabricated from search hits', () => {
  const reads = new KnowledgeReads();
  const search = reads.recordSearch({ source: 'wiki', query: 'rule', returnedIds: ['entries/rule'] });
  assert.throws(() => reads.recordFeedback('entries/rule', 'helpful', ['test:passed']), /exact recorded read/);
  reads.recordRead({ kind: 'wiki', id: 'entries/rule', fromSearchId: search, content: 'Version 1' });
  assert.throws(() => reads.recordFeedback('entries/rule', 'helpful', []), /concrete evidence/);
  const feedback = reads.recordFeedback('entries/rule', 'adopted', ['run:adopted']);
  reads.recordFeedback('entries/rule', 'helpful', ['test:passed'], feedback.content_sha256);
  const restored = new KnowledgeReads(validateKnowledgeReads(reads.toJSON()));
  assert.deepEqual(restored.toJSON().feedback[0].evidence, ['run:adopted', 'test:passed']);
  assert.equal(restored.toJSON().feedback[0].outcome, 'helpful');
  reads.recordRead({ kind: 'wiki', id: 'entries/rule', fromSearchId: search, content: 'Version 2' });
  assert.throws(() => reads.recordFeedback('entries/rule', 'helpful', ['test:passed']), /ambiguous/);
});

test('storage migration merges non-overlapping workflow rows and snapshots legacy memory without deleting originals', async t => {
  const root = temp(t);
  const old = join(root, '.agent-memory');
  const current = join(root, '.evolve');
  mkdirSync(old);
  mkdirSync(current);
  const schema = [
    'CREATE TABLE sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;',
    'CREATE TABLE requests (session TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(session,id)) STRICT;',
    'CREATE TABLE artifacts (session TEXT NOT NULL, id TEXT NOT NULL, body BLOB NOT NULL, PRIMARY KEY(session,id)) STRICT;',
  ].join('\n');
  for (const [dir, id] of [[old, 'old'], [current, 'new']]) {
    const db = new DatabaseSync(join(dir, 'workflow.db'));
    db.exec(schema);
    db.prepare('INSERT INTO sessions VALUES (?,?)').run(id, JSON.stringify({ id }));
    db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(id, 'req', 'fingerprint', '{}');
    db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(id, 'art', Buffer.from('evidence'));
    db.close();
  }
  const memory = new MemoryStore(join(old, 'memory.db'));
  await memory.put({ id: 'old-memory', content: 'Preserve this verified fact' });
  memory.close();
  assert.equal(migrateKnowledgeStorage(root).entries[0].state, 'mergeable');
  assert.equal(existsSync(join(current, 'memory.db')), false);
  const result = migrateKnowledgeStorage(root, true);
  assert.ok(result.applied);
  assert.equal(existsSync(join(old, 'workflow.db')), true);
  assert.equal(existsSync(join(old, 'memory.db')), true);
  const db = new DatabaseSync(join(current, 'workflow.db'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n, 2); }
  finally { db.close(); }
  const restored = new MemoryStore(join(current, 'memory.db'), { readOnly: true });
  try { assert.equal(restored.list().results[0].id, 'old-memory'); }
  finally { restored.close(); }
  const preview = migrateKnowledgeStorage(root);
  assert.equal(preview.entries.find(x => x.name === 'workflow.db').tables[0].missing, 0);
});

test('history semantic cursor is independent and retries unchanged failed content', async t => {
  const root = temp(t);
  const originalHome = process.env.CODEX_HOME;
  const home = join(root, 'codex');
  process.env.CODEX_HOME = home;
  t.after(() => { if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome; });
  const path = join(home, 'sessions', '2026', '11', '24');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'rollout-cursor.jsonl'), [
    { timestamp: '2026-11-24T01:00:00Z', type: 'session_meta', payload: { id: 'cursor', cwd: root, source: 'cli' } },
    { timestamp: '2026-11-24T01:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '不对，应该先验证约束。' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const opts = { root, hosts: ['codex'], session: 'cursor' };
  const first = await collectHistorySignals({ ...opts, sources: ['transcript'] });
  assert.equal(first.by_source.transcript, 1);
  const failed = await collectHistorySignals({ ...opts, sources: ['llm'], llm: () => { throw new Error('model unavailable'); } });
  assert.equal(failed.failures.length, 1);
  let calls = 0;
  const model = () => ({ async chat() { calls++; return '[]'; } });
  const retried = await collectHistorySignals({ ...opts, sources: ['llm'], llm: model });
  assert.equal(retried.failures.length, 0);
  assert.equal(calls, 1);
  await collectHistorySignals({ ...opts, sources: ['llm'], llm: model });
  assert.equal(calls, 1);
  assert.ok(inspectMemoryHooks(root).every(host => typeof host.configuration_current === 'boolean'));
});
