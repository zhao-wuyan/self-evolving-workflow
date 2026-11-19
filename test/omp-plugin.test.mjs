import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import extension from '../dist/omp-extension.js';
import { runBundledWorkflow } from '../dist/omp-cli-bridge.js';
import { contentSha256 } from '../dist/knowledge-reads.js';
import { publishRelease, readProjectHead } from '../dist/openviking/assets.js';
import { workflowDbPath } from '../dist/workflow-runtime.js';
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
  const commands = {};
  const schema = () => ({ optional() { return this; } });
  const state = { root, session, entries: [...history], failAppend: false };
  const ctx = {
    get cwd() { return state.root; },
    agent: { kind: 'main' },
    sessionManager: {
      getSessionId: () => state.session,
      getLeafId: () => state.entries.at(-1)?.id ?? null,
      getBranch: () => [...state.entries],
    },
  };
  extension({
    zod: { string: schema, array: schema, object: schema },
    registerCommand: (name, command) => { commands[name] = command; },
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
  const h = { state, ctx, tools, commands, event, call };
  if (!sessions.has(root)) sessions.set(root, []);
  sessions.get(root).push(h);
  return h;
}
function events(root, session) {
  const db = new DatabaseSync(workflowDbPath(root), { readOnly: true });
  try {
    return db.prepare('SELECT body FROM host_knowledge WHERE host_session = ? ORDER BY rowid').all(session)
      .map(row => JSON.parse(row.body));
  } finally { db.close(); }
}
function trigger(root, enabled) {
  const db = new DatabaseSync(workflowDbPath(root));
  try {
    db.exec(enabled ? "CREATE TRIGGER fail_host BEFORE INSERT ON host_knowledge BEGIN SELECT RAISE(ABORT, 'host write failed'); END;"
      : 'DROP TRIGGER fail_host');
  } finally { db.close(); }
}
function addWiki(f, id, mode, body) {
  f.write('wiki-draft.json', JSON.stringify({ operation: 'create', entry: id, title: id, mode, body }));
  f.agent('kb', 'apply', f.agent('kb', 'propose', 'wiki-draft.json', '--evidence', 'fixture:omp-plugin').id);
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
  f.agent('kb', 'add', 'Traceable needle release procedure.', '--kind', 'episodic', '--id', 'needle', '--type', 'work_method', '--session', 'seed');
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
  f.agent('kb', 'add', 'alpha beta exact record', '--kind', 'episodic', '--id', 'record', '--session', 'seed');
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
  assert.equal(page.body, f.agent('kb', 'get', 'entries/atomic-reference', '--kind', 'reference', '--resolved').content);
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
  f.agent('kb', 'add', 'Remote account 00123 exact identifier.', '--kind', 'episodic', '--id', 'account', '--session', 'seed');
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
  const status = await h.call('workflow', { argv: ['skill', 'status', '--scope', 'project'] });
  assert.equal(status.exit_code, 0);
  assert.equal(JSON.parse(status.stdout).schema_version, 'evolve-install-status/1.0');
  const installed = await runBundledWorkflow(f.root, ['skill', 'install', '--scope', 'project', '--skill', 'ew-orchestrate', '--yes']);
  const kept = JSON.parse(installed.stdout).kept_sources[0];
  assert.equal(kept.name, 'ew-orchestrate');
  assert.equal(kept.path, join(f.root, 'skills/ew-orchestrate/SKILL.md'));
  assert.equal(kept.differs, false);
  const customized = '---\nversion: [unfinished\n---\n用户修改的 Skill，保留原样。\n';
  writeFileSync(kept.path, customized);
  const repeated = await runBundledWorkflow(f.root, ['skill', 'install', '--scope', 'project', '--skill', 'ew-orchestrate', '--yes']);
  assert.equal(repeated.exit_code, 0);
  assert.equal(readFileSync(kept.path, 'utf8'), customized);
  assert.equal(JSON.parse(repeated.stdout).kept_sources[0].differs, true);
  await assert.rejects(runBundledWorkflow(f.root, ['skill', 'status', '--root', '..']), /root is fixed/);
  await assert.rejects(runBundledWorkflow(f.root, ['kb', 'get', 'anything']), /workflow control argv/);
  await assert.rejects(runBundledWorkflow(f.root, ['experience', 'publish', 'x']), /only read personal experience/);
  await assert.rejects(runBundledWorkflow(f.root, ['experience', 'review', 'x']), /only read personal experience/);
  const failure = await h.call('workflow', { argv: ['session', 'status', '--session', 'missing'] });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /Session not found/);
});

test('OMP experience batches only selected candidates and requires one interactive confirmation', async t => {
  const f = fixture('omp-experience-');
  t.after(async () => { await closeHarnesses(f.root); f.cleanup(); });
  const server = await protocol(t);
  f.write('ovcli.conf', JSON.stringify({ url: server.url, api_key: 'fixture-key' }));
  const flags = { EVOLVE_OPENVIKING_CONFIG: join(f.root, 'ovcli.conf'), EVOLVE_EXPERIENCE_CONFIG: join(f.root, 'personal.json') };
  const previous = Object.fromEntries(Object.keys(flags).map(key => [key, process.env[key]]));
  Object.assign(process.env, flags);
  Object.assign(f.env, flags);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });

  const h = harness(f.root);
  const { handler, getArgumentCompletions: complete } = h.commands['evolve-experience'];
  assert.equal(complete('ena')[0].value, 'enable');
  assert.match(complete('sea')[0].label, /<领域> <技术栈版本> <关键词>/);
  assert.equal(complete('review candidate --relat')[0].value, 'review candidate --relation ');
  assert.equal(complete('review candidate --relation dup')[0].value, 'review candidate --relation duplicate ');
  assert.equal(complete('publish first second --rel'), null);
  let approve = false;
  let confirmationCount = 0;
  let output;
  const ctx = Object.assign(h.ctx, { hasUI: true, ui: {
    notify(message, level) { assert.equal(level, 'info', message); output = message; },
    async editor() { assert.fail('Command text must not use an editor'); },
    async confirm() { confirmationCount++; return approve; },
  } });
  await handler('enable', ctx);
  assert.match(output, /当前仓库的个人经验采集已开启.*已更新用户级设置/);
  assert.equal(existsSync(join(f.root, '.evolve/openviking.json')), false);
  await handler('enable', ctx);
  assert.match(output, /本次未更改设置/);
  assert.equal(f.evolve('experience', 'status').collecting, true);

  f.open('tested', 'ew-test');
  const run = f.next('tested');
  readBound(f, 'tested', run);
  f.saveArtifact(run, 'test-results.json', {
    summary: { passed: 2, failed: 0 }, tests: [{ test_id: 'T1', status: 'passed' }, { test_id: 'T2', status: 'passed' }],
    experiences: [
      { domain: 'python', stack: 'python@3.12', title: 'Bound a queue', applicability: 'Bursty requests',
        lesson: 'Limit the concurrent work queue.', evidence: 'T1', verification: 'Burst test stayed within capacity.' },
      { domain: 'go', stack: 'go@1.24', title: 'Set a timeout', applicability: 'Slow requests',
        lesson: 'Bound the time spent waiting for I/O.', evidence: 'T2', verification: 'The timeout stopped slow requests.' },
    ],
  });
  writeFileSync(join(run.run_dir, 'report.md'), '---\nverdict: ready\nsummary: Burst test passed\nconstraints: []\ndecisions: []\nconcerns: []\nnext: []\n---\n\nBurst test passed.\n');
  f.finish('tested', run, 'Burst test passed', run.gates.exit.flatMap(gate => ['--gate', gate]));
  f.sealSession('tested');
  const pending = await h.call('experience_pending', {});
  const candidates = pending.candidates.map(({ id }) => ({ id }));
  assert.equal(candidates.length, 2);
  const publish = `publish ${candidates.map(item => item.id).join(' ')}`;

  await handler('pending', ctx);
  assert.match(output, /待发布个人经验/);
  await handler('review ' + candidates[0].id, ctx);
  assert.match(output, /发布预览（尚未发布）/);
  await handler(publish, ctx);
  assert.equal(confirmationCount, 1);
  assert.deepEqual((await server.inspect()).files, {});
  ctx.hasUI = false;
  await assert.rejects(h.call('experience_publish', { candidates }), /需要能够展示预览并确认/);
  ctx.hasUI = true;
  assert.equal((await h.call('experience_publish', { candidates })).status, 'cancelled');
  assert.equal(confirmationCount, 2);
  assert.deepEqual([...output.matchAll(/候选 ID：([a-f0-9]+)/g)].map(match => match[1]), candidates.map(row => row.id));
  assert.deepEqual((await server.inspect()).files, {});

  approve = true;
  const result = await h.call('experience_publish', { candidates });
  assert.equal(confirmationCount, 3);
  assert.equal(result.status, 'published');
  assert.deepEqual(result.published.map(row => row.candidate_id), candidates.map(row => row.id));
  const files = (await server.inspect()).files;
  assert.ok(result.published.every(({ receipt }) => files[receipt.uri]));
  await handler('search python python@3.12 concurrent work queue --limit 1', ctx);
  assert.match(output, /经验：Limit the concurrent work queue\./);
  await handler('disable', ctx);
  assert.equal(f.evolve('experience', 'status').collecting, false);
  assert.deepEqual((await server.inspect()).files, files);
});

test('OMP OpenViking initialization changes Git and publishes only after confirmation', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { profile: false, minimalSkills: true });
  f.git('rm', '-r', 'agents'); f.git('commit', '-qm', '测试: 不预置根目录 Agent');
  f.write('.workflow/knowhow/migration.md', '---\ntitle: Legacy deployment notes\n---\n\nKeep this deployment note local.\n');
  f.evolve('kb', 'import', '--project', 'legacy-project', '--apply');
  const h = harness(f.root);
  f.dispose(() => closeHarnesses(f.root));
  const { handler } = h.commands['evolve-openviking'];
  const before = f.git('rev-parse', 'HEAD');
  let approve = false;
  let output;
  const ctx = Object.assign(h.ctx, { hasUI: true, ui: {
    notify(message, level) { assert.equal(level, 'info', message); output = message; },
    async confirm(_title, message) {
      assert.match(message, /\.evolve\/evolution\.json.*只同步资产/);
      return approve;
    },
  } });
  await handler('', ctx);
  assert.match(output, /\.evolve\/evolution\.json，缺失则创建空策略/);
  await handler('init', ctx);
  assert.match(output, /已取消/);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(existsSync(join(f.root, '.evolve/openviking.json')), false);
  assert.equal(existsSync(join(f.root, '.evolve/evolution.json')), false);
  assert.deepEqual((await server.inspect()).files, {});
  assert.equal(existsSync(join(f.root, '.omp/agent/agents')), false);

  approve = true;
  await handler('init', ctx);
  assert.match(output, /项目初始化完成/);
  assert.match(output, /1 条 Wiki 未匹配审批记录，已保留在本地，未上传/);
  assert.notEqual(f.git('rev-parse', 'HEAD'), before);
  const project = JSON.parse(f.git('show', 'HEAD:.evolve/openviking.json'));
  assert.equal(project.evolution_policy, '.evolve/evolution.json');
  assert.deepEqual(JSON.parse(f.git('show', 'HEAD:.evolve/evolution.json')).targets, []);
  assert.equal(existsSync(join(f.root, 'evolution.json')), true);
  assert.equal(existsSync(join(f.root, 'agents')), false);
  assert.equal(existsSync(join(f.root, '.omp/agent/agents/workflow-executor.md')), true);
  assert.equal(existsSync(join(f.root, '.omp/agent/skills')), false);
  assert.equal(f.git('ls-tree', '-r', '--name-only', 'HEAD', '--', '.omp/agent/agents'), '');
  const { head } = await readProjectHead(f.client, project);
  assert.ok(output.includes(head.release_id));

  await h.event('session_start');
  const args = ['openviking', 'policy', '--entry', f.entry, '--runner', 'tools/replay.mjs', '--scenarios', 'tools/scenarios.json'];
  const gitBefore = f.git('rev-parse', 'HEAD');
  const preview = JSON.parse((await h.call('workflow', { argv: args })).stdout);
  assert.equal(preview.status, 'preview');
  assert.equal(f.git('rev-parse', 'HEAD'), gitBefore);
  const argv = [...args, '--apply', preview.preview_id];
  ctx.agent.kind = 'sub';
  ctx.ui.confirm = async () => assert.fail('subagent must not prompt');
  assert.equal((await h.call('workflow', { argv: args })).status, 'deferred');
  assert.equal((await h.call('workflow', { argv })).status, 'deferred');
  await handler('init', ctx);
  ctx.agent.kind = 'main';
  ctx.ui.confirm = async (title, message) => {
    assert.match(title, /提交 OpenViking 演进策略/);
    assert.match(message, /仅创建本地 Git 提交/);
    return approve;
  };
  approve = false;
  assert.equal((await h.call('workflow', { argv })).status, 'cancelled');
  assert.equal(f.git('rev-parse', 'HEAD'), gitBefore);
  approve = true;
  const policy = JSON.parse((await h.call('workflow', { argv })).stdout);
  assert.equal(policy.status, 'applied');
  assert.equal(f.git('rev-parse', 'HEAD'), policy.commit);
  assert.equal((await readProjectHead(f.client, project)).head.release_id, head.release_id);

  const remoteBefore = (await server.inspect()).calls.length;
  f.open('child-closeout', 'sample');
  const run = f.next('child-closeout');
  f.evolve('run', 'skill-read', run.run_id, '--session', 'child-closeout');
  f.finish('child-closeout', run, 'Task done');
  const beforeComplete = (await server.inspect()).calls.length;
  assert.ok(beforeComplete > remoteBefore);
  ctx.agent.kind = 'sub';
  const result = await h.call('workflow', { argv: ['session', 'complete', ...f.fence('child-closeout')] });
  assert.deepEqual(JSON.parse(result.stdout).asset_publication, { state: 'deferred', reason: 'main_session_required' });
  assert.equal(f.status('child-closeout').status, 'completed');
  assert.equal((await server.inspect()).calls.length, beforeComplete);
});

test('OMP ignore migrates old directory rules without exposing runtime data', async t => {
  const f = fixture('evolve-omp-ignore-');
  t.after(async () => { await closeHarnesses(f.root); f.cleanup(); });
  f.write('.gitignore', '/.evolve/\n/bin/\n');
  const h = harness(f.root);
  let prompt;
  h.ctx.hasUI = true;
  h.ctx.ui = { notify(text, level) { assert.equal(level, 'info', text); prompt = text; } };
  const { handler } = h.commands['evolve-ignore'];
  await handler('check', h.ctx);
  assert.match(prompt, /未写入/);
  assert.equal(readFileSync(join(f.root, '.gitignore'), 'utf8'), '/.evolve/\n/bin/\n');
  await handler('apply', h.ctx);
  const runtime = ['.evolve/workflow.db', '.evolve/runs/session/report.md', '.evolve/ovcli.conf', '.agent-memory/index', '.codegraph/index'];
  assert.deepEqual(f.git('check-ignore', '--no-index', '--', ...runtime, '.evolve/openviking.json', '.evolve/evolution.json').split('\n'), runtime);
  await handler('apply', h.ctx);
  assert.match(prompt, /规则已齐全/);
});
