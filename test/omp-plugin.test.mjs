import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import extension from '../dist/omp-extension.js';
import { runBundledWorkflow } from '../dist/omp-cli-bridge.js';
import { contentSha256 } from '../dist/knowledge-reads.js';
import { publishRelease, readProjectHead } from '../dist/openviking/assets.js';
import { fixture } from './evolve-workflow-support.mjs';
import { protocol, projectFixture, seed, releaseFromProject } from './openviking-support.mjs';
import { setImmediate as nextTurn } from 'node:timers/promises';

const sessions = new Map();
async function closeHarnesses(root) {
  for (const h of sessions.get(root) ?? []) await h.event('session_shutdown');
  sessions.delete(root);
}

function harness(root, session = randomUUID(), history = []) {
  const tools = {};
  const handlers = {};
  const schema = () => ({ optional() { return this; } });
  const state = { root, session, entries: [...history], failAppend: false };
  const ctx = {
    get cwd() { return state.root; },
    sessionManager: {
      getSessionId: () => state.session,
      getLeafId: () => state.entries.at(-1)?.id ?? null,
      getBranch: () => [...state.entries],
    },
  };
  extension({
    zod: { string: schema, array: schema, object: schema },
    registerTool: tool => { tools[tool.name] = tool; },
    on: (name, handler) => { handlers[name] = handler; },
    appendEntry: (customType, data) => {
      if (state.failAppend) throw new Error('append failed');
      state.entries.push({ id: randomUUID(), type: 'custom', customType, data });
    },
  });
  const event = async name => handlers[name]?.({ type: name }, ctx);
  const call = async (name, args, id = randomUUID(), signal) => {
    const result = await tools['evolve_' + name].execute(id, args, signal, undefined, ctx);
    return result.isError ? result : JSON.parse(result.content[0].text);
  };
  const h = { state, ctx, tools, event, call };
  if (!sessions.has(root)) sessions.set(root, []);
  sessions.get(root).push(h);
  return h;
}
function events(root, session) {
  const db = new DatabaseSync(join(root, '.agent-memory', 'workflow.db'), { readOnly: true });
  try {
    return db.prepare('SELECT body FROM host_knowledge WHERE host_session = ? ORDER BY rowid').all(session)
      .map(row => JSON.parse(row.body));
  } finally { db.close(); }
}
function trigger(root, enabled) {
  const db = new DatabaseSync(join(root, '.agent-memory', 'workflow.db'));
  try {
    db.exec(enabled ? "CREATE TRIGGER fail_host BEFORE INSERT ON host_knowledge BEGIN SELECT RAISE(ABORT, 'host write failed'); END;"
      : 'DROP TRIGGER fail_host');
  } finally { db.close(); }
}
function addWiki(f, id, mode, body) {
  f.write('wiki-draft.json', JSON.stringify({ operation: 'create', entry: id, title: id, mode, body }));
  f.agent('wiki', 'apply', f.agent('wiki', 'propose', 'wiki-draft.json', '--evidence', 'fixture:omp-plugin').id);
}
function readBound(f, session, run) {
  f.evolve('run', 'skill-read', run.run_id, '--session', session);
  for (const link of run.skill_ref.required_links.filter(path => path !== 'SKILL.md')) {
    f.evolve('run', 'skill-read', run.run_id, link, '--from', 'SKILL.md', '--session', session);
  }
}

test('OMP host scopes isolate real IDs, restore active branches, reject stale exact reads and replay original results', async t => {
  const f = fixture('evolve-omp-host-');
  t.after(async () => { await closeHarnesses(f.root); f.cleanup(); });
  f.agent('memory', 'put', 'Traceable needle release procedure.', '--id', 'needle', '--type', 'work_method', '--session', 'seed');
  const a = harness(f.root, 'same-title-A');
  await a.event('session_start');
  t.after(() => a.event('session_shutdown'));
  await assert.rejects(a.call('memory_get', { id: 'needle' }), /search results/);
  await assert.rejects(a.call('read_skill', {}), /Bind an explicit/);
  const first = await a.call('memory_search', { query: 'needle' }, 'search-a');
  assert.ok(first.results.some(item => item.id === 'needle'));
  const searchBranch = [...a.state.entries];
  const read = await a.call('memory_get', { id: 'needle' });
  assert.equal(read.content, 'Traceable needle release procedure.');
  assert.deepEqual(await a.call('memory_search', { query: 'needle' }, 'search-a'), first);
  await assert.rejects(a.call('memory_search', { query: 'changed' }, 'search-a'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  const receipt = events(f.root, a.state.session).at(-1).state.knowledge_reads;
  assert.equal(receipt.reads[0].content_sha256, contentSha256(read.content));
  const b = harness(f.root, 'same-title-B', a.state.entries);
  await b.event('session_start');
  t.after(() => b.event('session_shutdown'));
  await assert.rejects(b.call('memory_get', { id: 'needle' }), /search results/);
  const restored = harness(f.root, a.state.session, searchBranch);
  await restored.event('session_start');
  t.after(() => restored.event('session_shutdown'));
  assert.equal((await restored.call('memory_get', { id: 'needle' })).id, 'needle');
  restored.state.entries = [];
  await restored.event('session_tree');
  await assert.rejects(restored.call('memory_get', { id: 'needle' }), /search results/);
  await restored.call('memory_search', { query: 'needle' });
  await restored.event('session_clear');
  const cleared = harness(f.root, restored.state.session, restored.state.entries);
  await cleared.event('session_start');
  t.after(() => cleared.event('session_shutdown'));
  await assert.rejects(cleared.call('memory_get', { id: 'needle' }), /search results/);
});

test('OMP concurrent calls preserve both searches; append failure replays committed evidence without duplicate reads', async t => {
  const f = fixture('evolve-omp-concurrency-');
  t.after(async () => { await closeHarnesses(f.root); f.cleanup(); });
  f.agent('memory', 'put', 'alpha beta exact record', '--id', 'record', '--session', 'seed');
  const h = harness(f.root);
  await h.event('session_start');
  t.after(() => h.event('session_shutdown'));
  await Promise.all([h.call('memory_search', { query: 'alpha' }, 'alpha'), h.call('memory_search', { query: 'beta' }, 'beta')]);
  assert.deepEqual(events(f.root, h.state.session).at(-1).state.knowledge_reads.searches.map(item => item.query), ['alpha', 'beta']);
  h.state.failAppend = true;
  await assert.rejects(h.call('memory_get', { id: 'record' }, 'read'), /append failed/);
  const committed = events(f.root, h.state.session).at(-1);
  h.state.failAppend = false;
  assert.equal((await h.call('memory_get', { id: 'record' }, 'read')).content, 'alpha beta exact record');
  assert.equal(events(f.root, h.state.session).filter(event => event.context.toolCallId === 'read').length, 1);
  assert.equal(h.state.entries.at(-1).data.eventId, committed.id);
});

test('OMP host and all three Run evidence paths roll back together; unbind never restores old Run or searches', async t => {
  const f = fixture('evolve-omp-atomic-');
  t.after(async () => { await closeHarnesses(f.root); f.cleanup(); });
  addWiki(f, 'entries/atomic-rule', 'constraint', 'Atomic evidence must not leave half a receipt.');
  addWiki(f, 'entries/atomic-reference', 'reference', 'Atomic reference body.');
  const session = 'atomic';
  const opened = f.open(session, 'ew-analyze,ew-plan');
  const run = f.next(session, opened.orchestration_revision);
  const h = harness(f.root);
  await h.event('session_start');
  t.after(() => h.event('session_shutdown'));
  await assert.rejects(h.call('run_binding', { action: 'bind', session, run: 'missing' }), /Run not found/);
  await h.call('run_binding', { action: 'bind', session, run: run.run_id });
  const snapshot = () => f.status(session).runs.find(item => item.id === run.run_id);
  for (const [tool, args] of [['wiki_context', { query: 'atomic' }], ['read_skill', {}]]) {
    const before = snapshot();
    const count = events(f.root, h.state.session).length;
    trigger(f.root, true);
    await assert.rejects(h.call(tool, args), /host write failed/);
    trigger(f.root, false);
    assert.deepEqual(snapshot(), before);
    assert.equal(events(f.root, h.state.session).length, count);
  }
  const search = await h.call('wiki_context', { query: 'atomic' });
  assert.ok(search.references.some(item => item.id === 'entries/atomic-reference'));
  const page = await h.call('wiki_reference', { id: 'entries/atomic-reference' });
  assert.equal(page.body, f.agent('wiki', 'get', 'entries/atomic-reference', '--resolved').body);
  const selectedPath = join(f.root, 'wiki/entries/atomic-reference.md');
  writeFileSync(selectedPath, readFileSync(selectedPath, 'utf8').replace('Atomic reference body.', 'Changed atomic body.'));
  const beforeChanged = snapshot();
  await assert.rejects(h.call('wiki_reference', { id: 'entries/atomic-reference' }), /Wiki evidence changed/);
  assert.deepEqual(snapshot(), beforeChanged);
  readBound(f, session, run);
  f.saveArtifact(run, 'findings.json', { finding: 'Atomic reference verified.' });
  const complete = f.finish(session, run, 'Pin atomic reference', run.gates.exit.flatMap(gate => ['--gate', gate]));
  await assert.rejects(h.call('read_skill', {}), /running Evolve Run/);
  const plan = f.next(session, complete.orchestration_revision);
  await h.call('run_binding', { action: 'bind', session, run: plan.run_id });
  trigger(f.root, true);
  await assert.rejects(h.call('read_artifact', { id: 'session-priors' }), /host write failed/);
  trigger(f.root, false);
  assert.equal(f.status(session).runs.find(item => item.id === plan.run_id).priors_reuse, undefined);
  assert.match((await h.call('read_artifact', { id: 'session-priors' })).content, /Atomic reference body/);
  await assert.rejects(h.call('read_artifact', { id: 'session-priors', scope: { task: 'review' } }), /outside session-priors/);
  await assert.rejects(h.call('read_artifact', { id: 'not-an-input' }), /outside the Run input binding/);
  await h.call('run_binding', { action: 'unbind' });
  const restored = harness(f.root, h.state.session, h.state.entries);
  await restored.event('session_start');
  t.after(() => restored.event('session_shutdown'));
  await assert.rejects(restored.call('read_skill', {}), /Bind an explicit/);
  await assert.rejects(restored.call('wiki_reference', { id: 'entries/atomic-reference' }), /returned by wiki_context/);
});

test('OMP binding does not backfill unbound reads and refuses mixed Run receipt sources without partial host evidence', async t => {
  const f = fixture('evolve-omp-receipt-source-');
  t.after(async () => { await closeHarnesses(f.root); f.cleanup(); });
  const h = harness(f.root);
  await h.event('session_start');
  t.after(() => h.event('session_shutdown'));
  await h.call('memory_search', { query: 'before bind' });
  const session = 'receipt-source';
  const opened = f.open(session, 'ew-analyze');
  const run = f.next(session, opened.orchestration_revision);
  await h.call('run_binding', { action: 'bind', session, run: run.run_id });
  assert.equal(f.status(session).runs[0].knowledge_reads, undefined);
  writeFileSync(join(run.run_dir, 'knowledge-reads.json'), JSON.stringify({ schema_version: 'knowledge-reads/1.0', searches: [], reads: [], constraints_bound: [] }));
  const before = events(f.root, h.state.session).length;
  await assert.rejects(h.call('memory_search', { query: 'after bind' }), /single Run knowledge receipt source/);
  assert.equal(events(f.root, h.state.session).length, before);
  assert.equal(f.status(session).runs[0].knowledge_reads, undefined);
});

test('OMP OpenViking release survives head updates and restart; concurrent remote reads remain with their calls', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server);
  f.dispose(() => closeHarnesses(f.root));
  f.agent('memory', 'put', 'Remote account 00123 exact identifier.', '--id', 'account', '--session', 'seed');
  f.evolve('openviking', 'memory', 'share', 'account');
  const r1 = await seed(f);
  const h = harness(f.root);
  await h.event('session_start');
  t.after(() => h.event('session_shutdown'));
  const first = await h.call('memory_search', { query: '00123' });
  const id = first.results.find(item => item.content.includes('00123')).id;
  const next = releaseFromProject(f, r1.head.release_id);
  const r2 = await publishRelease(f.client, f.project, next.manifest, next.bytes, (await readProjectHead(f.client, f.project)).raw);
  assert.notEqual(r2.release_id, r1.head.release_id);
  const resumed = harness(f.root, h.state.session, h.state.entries);
  await resumed.event('session_start');
  t.after(() => resumed.event('session_shutdown'));
  const [excluded, included] = await Promise.all([
    resumed.call('memory_search', { query: '99999' }, 'exclude'),
    resumed.call('memory_search', { query: '00123' }, 'include'),
  ]);
  assert.equal(excluded.results.length, 0);
  assert.ok(included.results.some(item => item.id === id));
  assert.equal((await resumed.call('memory_get', { id })).content, 'Remote account 00123 exact identifier.');
  const journal = events(f.root, h.state.session);
  assert.ok(journal.every(event => event.state.source.releaseId === r1.head.release_id));
  const exclude = journal.find(event => event.context.toolCallId === 'exclude');
  const include = journal.find(event => event.context.toolCallId === 'include');
  assert.equal(exclude.state.remote_reads.length, journal[0].state.remote_reads.length);
  assert.ok(include.state.remote_reads.length > exclude.state.remote_reads.length);
  assert.ok(include.state.remote_reads.every(item => item.release_id === r1.head.release_id));
});

test('OMP cancelled or switched asynchronous calls cannot persist to or append in the new session', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server);
  f.dispose(() => closeHarnesses(f.root));
  await seed(f);
  const h = harness(f.root, 'A');
  await h.event('session_start');
  t.after(() => h.event('session_shutdown'));
  const pending = h.call('memory_search', { query: 'late' }, 'late-a');
  await nextTurn();
  h.state.session = 'B';
  h.state.entries = [];
  await h.event('session_switch');
  await assert.rejects(pending, /cancelled by a session/);
  assert.deepEqual(events(f.root, 'A'), []);
  assert.deepEqual(events(f.root, 'B'), []);
  assert.deepEqual(h.state.entries, []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.call('memory_search', { query: 'aborted' }, 'aborted', controller.signal), /abort/i);
  assert.deepEqual(events(f.root, 'B'), []);
});

test('OMP workflow control uses the bundled CLI, rejects root escape and reports preserved Skill versions', async t => {
  const f = fixture('evolve omp cli with spaces ');
  t.after(async () => { await closeHarnesses(f.root); f.cleanup(); });
  const h = harness(f.root);
  await h.event('session_start');
  t.after(() => h.event('session_shutdown'));
  const capabilities = await h.call('workflow', { argv: ['capabilities'] });
  assert.equal(capabilities.exit_code, 0);
  assert.equal(JSON.parse(capabilities.stdout).schema_version, 'evolve-workflow/1.0');
  const installed = await runBundledWorkflow(f.root, ['install', '--scope', 'project', '--skill', 'ew-orchestrate', '--yes']);
  const kept = JSON.parse(installed.stdout).kept_sources[0];
  assert.equal(kept.name, 'ew-orchestrate');
  assert.equal(kept.path, join(f.root, 'skills/ew-orchestrate/SKILL.md'));
  assert.equal(kept.differs, false);
  const customized = '---\nversion: [unfinished\n---\n用户修改的 Skill，保留原样。\n';
  writeFileSync(kept.path, customized);
  const repeated = await runBundledWorkflow(f.root, ['install', '--scope', 'project', '--skill', 'ew-orchestrate', '--yes']);
  assert.equal(repeated.exit_code, 0);
  assert.equal(readFileSync(kept.path, 'utf8'), customized);
  assert.equal(JSON.parse(repeated.stdout).kept_sources[0].differs, true);
  await assert.rejects(runBundledWorkflow(f.root, ['capabilities', '--root', '..']), /root is fixed/);
  await assert.rejects(runBundledWorkflow(f.root, ['memory', 'get', 'anything']), /workflow control argv/);
  const failure = await h.call('workflow', { argv: ['session', 'status', '--session', 'missing'] });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /Session not found/);
});
