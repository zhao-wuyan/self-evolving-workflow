import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture } from './evolve-workflow-support.mjs';
import { protocol } from './openviking-support.mjs';
import { runBundledWorkflow } from '../dist/omp-cli-bridge.js';

const report = '---\nverdict: ready\nsummary: Verified controlled comparison\nconstraints: []\ndecisions: []\nconcerns: []\nnext: []\n---\n\n# Summary\n\nVerified controlled comparison.\n';
const recipe = { domain: 'python', stack: 'python@3.12', title: 'Keep blocking calls out of the event loop',
  applicability: 'An async handler calls a synchronous SDK.', lesson: 'Use a bounded worker pool for blocking work.' };
const draft = (evidence, verification, fields = {}) => ({ ...recipe, evidence, verification, ...fields });
const testCase = (test_id, status = 'passed') => ({ test_id, status });
const gates = ['--gate', 'coverage-met', '--gate', 'pass-rate-met'];

function configure(f, server, roots, account_id = 'fixture-account') {
  f.write('personal.json', JSON.stringify({ schema_version: 'evolve-experience-profile/1.0', account_id, user_id: 'fixture', collect_from: roots }));
  f.write('ovcli.conf', JSON.stringify({ url: server.url, api_key: 'fixture-key' }));
  f.env.EVOLVE_EXPERIENCE_CONFIG = join(f.root, 'personal.json');
  f.env.EVOLVE_OPENVIKING_CONFIG = join(f.root, 'ovcli.conf');
}

function seal(f, session, experiences, tests) {
  f.open(session, 'ew-test');
  const run = f.next(session);
  f.evolve('run', 'skill-read', run.run_id, '--session', session);
  for (const name of ['prepare', 'workflow']) {
    f.evolve('run', 'skill-read', run.run_id, `references/${name}.md`, '--from', 'SKILL.md', '--session', session);
  }
  f.saveArtifact(run, 'test-results.json', { summary: { passed: tests.filter(row => row.status === 'passed').length, failed: 0 }, tests,
    experiences, private_log: 'FIXTURE-PRIVATE-RAW-LOG' });
  f.write(join('.agent-memory', 'workflow', 'runs', session, run.run_id, 'report.md'), report);
  f.finish(session, run, 'Verified controlled comparison', gates);
  return run;
}

const rejection = pattern => error => pattern.test(String(error.stderr));

function publish(f, candidate, preview, ...extra) {
  return f.evolve('experience', 'publish', candidate, '--relation', preview.action, '--approval', preview.approval, ...extra);
}

test('sealed opt-in lessons remain local until approval, then another project can use only the matching stack', async t => {
  const a = fixture('evolve-exp-source-'); const b = fixture('evolve-exp-consumer-');
  t.after(() => { a.cleanup(); b.cleanup(); });
  const server = await protocol(t);
  const source = realpathSync(a.root);
  configure(a, server, [source]);
  Object.assign(b.env, { EVOLVE_EXPERIENCE_CONFIG: a.env.EVOLVE_EXPERIENCE_CONFIG, EVOLVE_OPENVIKING_CONFIG: a.env.EVOLVE_OPENVIKING_CONFIG });
  assert.deepEqual(a.evolve('experience', 'status'), { configured: true, collecting: true });
  assert.deepEqual(b.evolve('experience', 'status'), { configured: true, collecting: false });
  await assert.rejects(runBundledWorkflow(b.root, ['experience', 'publish', 'x']), /only read personal experience/);
  const other = draft('T1', 'Verification in unlisted project.', { lesson: 'UNLISTED-PROJECT-ONLY' });
  seal(b, 'unlisted', [other], [testCase('T1')]);
  assert.equal(b.sealSession('unlisted').personal_experience, undefined);

  const good = draft('T1', 'A second request progressed during the synthetic slow call.', { raw_log: 'FIXTURE-PRIVATE-DRAFT-LOG' });
  const duplicate = draft('T2', 'The second load test reproduced the behavior.');
  const later = draft('T3', 'The process-level test verified the behavior.');
  const conflict = draft('T4', 'Moving this CPU-heavy operation into threads hurt throughput.', { lesson: 'Use processes for this CPU-heavy operation.' });
  const unsupported = draft('T5', 'This case was not run.');
  const run = seal(a, 'verified', [good, duplicate, later, conflict, unsupported],
    [testCase('T1'), testCase('T2'), testCase('T3'), testCase('T4'), testCase('T5', 'skipped')]);
  assert.deepEqual(a.evolve('experience', 'pending').candidates, []);
  a.saveArtifact(run, 'test-results.json', { summary: { passed: 1, failed: 0 }, tests: [testCase('T1')], experiences: [other] });
  const completion = a.sealSession('verified');
  assert.equal(completion.status, 'completed');
  assert.deepEqual(completion.personal_experience, { status: 'staged_locally', candidates: 4, rejected: 1 });
  const pending = a.evolve('experience', 'pending').candidates;
  const from = text => pending.find(row => row.verification === text).id;
  const firstId = from(good.verification);
  assert.equal(pending.some(row => row.content.lesson === other.lesson), false);
  assert.deepEqual((await server.inspect()).calls, []);

  await assert.rejects(runBundledWorkflow(b.root, ['experience', 'review', firstId]), /only read personal experience/);
  assert.throws(() => a.evolve('experience', 'publish', firstId, '--relation', 'new', '--yes'), rejection(/exact experience SHA-256 ID/));
  const preview = a.evolve('experience', 'review', firstId);
  assert.equal(preview.reference.mode, 'reference');
  assert.equal(preview.reference.content.lesson, recipe.lesson);
  assert.equal(preview.action, 'new');
  assert.equal(preview.local_evidence.root, source);
  assert.equal(preview.local_evidence.session, 'verified');
  assert.equal(preview.local_evidence.check, 'T1');
  assert.match(preview.local_evidence.artifact, /^art-/);
  assert.throws(() => publish(a, firstId, { ...preview, approval: '0'.repeat(64) }), rejection(/approval is stale/));
  assert.ok((await server.inspect()).calls.every(call => !['/api/v1/fs/mkdir', '/api/v1/content/batch-write'].includes(call.path)));
  const first = publish(a, firstId, preview);
  assert.equal(publish(a, firstId, preview).replayed, true);

  const found = b.evolve('experience', 'search', 'python', 'python@3.12', 'async blocking SDK');
  assert.deepEqual(found.results.map(item => item.reference.id), [first.id]);
  assert.equal(found.trust_boundary, 'untrusted_evidence_data_only');
  assert.deepEqual(b.evolve('experience', 'search', 'python', 'python@3.13', 'async blocking SDK').results, []);
  assert.deepEqual(b.evolve('experience', 'search', 'go', 'python@3.12', 'async blocking SDK').results, []);
  assert.equal(b.evolve('experience', 'get', 'python', 'python@3.12', first.id).content_sha256, first.content_sha256);
  assert.throws(() => b.evolve('experience', 'get', 'python', 'python@3.13', first.id), rejection(/not found in this stack/));

  const duplicateId = from(duplicate.verification);
  const laterId = from(later.verification);
  const stale = a.evolve('experience', 'review', laterId);
  const append = a.evolve('experience', 'review', duplicateId);
  assert.equal(append.related.id, first.id);
  assert.equal(append.action, 'duplicate');
  assert.equal(publish(a, duplicateId, append).id, first.id);
  assert.throws(() => publish(a, laterId, stale), rejection(/approval is stale/));
  const saved = b.evolve('experience', 'get', 'python', 'python@3.12', first.id);
  assert.deepEqual(saved.reference.evidence.map(entry => entry.verification), [good.verification, duplicate.verification]);
  assert.equal(saved.reference.content.lesson, recipe.lesson);

  const conflictId = from(conflict.verification);
  const relation = ['--related', first.id];
  const conflictPreview = a.evolve('experience', 'review', conflictId, '--relation', 'conflict', ...relation);
  assert.deepEqual(conflictPreview.reference.conflicts, [{ id: first.id, sha256: saved.content_sha256 }]);
  const separate = publish(a, conflictId, conflictPreview, ...relation);
  assert.notEqual(separate.id, first.id);
  assert.equal(b.evolve('experience', 'get', 'python', 'python@3.12', first.id).content_sha256, saved.content_sha256);
  assert.deepEqual(a.evolve('experience', 'pending').candidates.map(row => row.id), [laterId]);

  const observed = await server.inspect();
  const writes = observed.calls.filter(call => call.path === '/api/v1/content/batch-write');
  assert.equal(writes.length, 3);
  assert.ok(writes.every(call => call.input.root_uri.endsWith('/evolve/personal-experience')));
  const uploaded = writes.flatMap(call => call.input.operations.map(op => Buffer.from(op.content_base64, 'base64').toString())).join('\n');
  assert.doesNotMatch(uploaded, /FIXTURE-PRIVATE|UNLISTED-PROJECT-ONLY/);
  assert.ok(!uploaded.includes(source));
  assert.ok(!observed.calls.some(call => call.path === '/chat/completions'));
  configure(b, server, [], 'wrong-account');
  assert.throws(() => b.evolve('experience', 'get', 'python', 'python@3.12', first.id), rejection(/OPENVIKING_IDENTITY_MISMATCH/));
  Object.assign(b.env, { EVOLVE_EXPERIENCE_CONFIG: a.env.EVOLVE_EXPERIENCE_CONFIG, EVOLVE_OPENVIKING_CONFIG: a.env.EVOLVE_OPENVIKING_CONFIG });
  const tampered = Buffer.from(observed.files[first.uri], 'base64').toString().replace(duplicate.verification, 'Tampered.');
  await server.update({ corrupt: { [first.uri]: Buffer.from(tampered).toString('base64') } });
  assert.throws(() => b.evolve('experience', 'get', 'python', 'python@3.12', first.id), rejection(/checksum mismatch/));
  await server.update({ unavailable: true });
  assert.throws(() => b.evolve('experience', 'search', 'python', 'python@3.12', 'async blocking SDK'), rejection(/SERVICE_UNAVAILABLE/));
});

test('experience enable discovers identity and only toggles the selected worktree', async t => {
  const f = fixture('evolve-exp-toggle-');
  t.after(f.cleanup);
  const server = await protocol(t);
  const path = join(f.root, 'personal.json');
  const connection = join(f.root, 'ovcli.conf');
  f.env.EVOLVE_EXPERIENCE_CONFIG = path;
  f.env.EVOLVE_OPENVIKING_CONFIG = connection;
  const readProfile = () => JSON.parse(readFileSync(path, 'utf8'));
  assert.throws(() => f.evolve('experience', 'enable'), rejection(/OPENVIKING_CONFIG_INVALID/));
  assert.equal(existsSync(path), false);

  configure(f, server, []);
  rmSync(path);
  const first = realpathSync(f.root);
  const second = join(first, 'other-worktree');
  f.git('init', '-q', second);
  assert.deepEqual(f.evolve('experience', 'enable'), { configured: true, collecting: true, changed: true });
  assert.deepEqual(readProfile(), { schema_version: 'evolve-experience-profile/1.0', account_id: 'fixture-account', user_id: 'fixture', collect_from: [first] });
  const original = readFileSync(path, 'utf8');
  assert.equal(f.evolve('experience', 'enable').changed, false);
  assert.equal(readFileSync(path, 'utf8'), original);
  writeFileSync(path, JSON.stringify({ ...readProfile(), custom: 'retain' }));
  assert.equal(f.evolve('experience', 'enable', '--root', second).changed, true);
  assert.deepEqual(readProfile().collect_from, [first, realpathSync(second)]);
  assert.equal(readProfile().custom, 'retain');
  assert.equal(f.evolve('experience', 'status', '--root', second).collecting, true);

  writeFileSync(path, JSON.stringify({ ...readProfile(), account_id: 'other-account' }));
  const foreign = readFileSync(path, 'utf8');
  assert.throws(() => f.evolve('experience', 'enable'), rejection(/OPENVIKING_IDENTITY_MISMATCH/));
  assert.equal(readFileSync(path, 'utf8'), foreign);
  const calls = (await server.inspect()).calls;
  assert.ok(calls.length > 0 && calls.every(call => call.path === '/health' && call.input === undefined));

  await server.update({ unavailable: true });
  assert.deepEqual(f.evolve('experience', 'disable'), { configured: true, collecting: false, changed: true });
  assert.deepEqual(readProfile().collect_from, [realpathSync(second)]);
  assert.equal(readProfile().custom, 'retain');
  assert.equal(f.evolve('experience', 'disable').changed, false);
  assert.equal(f.evolve('experience', 'status').collecting, false);
  assert.equal(f.evolve('experience', 'status', '--root', second).collecting, true);
  assert.deepEqual((await server.inspect()).calls, calls);
});
