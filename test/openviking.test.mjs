import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { protocol, projectFixture, releaseFromProject, seed, fakeAgy, completeSample } from './openviking-support.mjs';
import { readPolicy, readProject, validateEvolutionPolicy, validateProject } from '../dist/openviking/config.js';
import { prepareEvolutionScenarios } from '../dist/openviking/evolution-scenarios.js';
import { loadRelease, manifestBytes, publishRelease, readProjectHead, sha256, stableJson, validateManifest } from '../dist/openviking/assets.js';
import { cacheRelease, selectMemory, exportMemory, exportWiki, fileRecord } from '../dist/openviking/knowledge.js';
import { createAssetCommit, gitBytes, skillAssets } from '../dist/openviking/git.js';
import { initializeProject } from '../dist/openviking/lifecycle.js';
import { installSkills, installStatus } from '../dist/workflow-install.js';
import { mergeProjectAssets } from '../dist/openviking/merge.js';
import { freezeKnowledge, frozenKnowledgeHash } from '../dist/openviking/frozen.js';
import { MemoryStore, defaultMemoryDbPath } from '../dist/memory.js';
import { openKnowledgeSources } from '../dist/knowledge-sources.js';
import { createSearchServer } from '../dist/http.js';
import { Wiki } from '../dist/wiki.js';
import { applyWikiChange, proposeWikiChange } from '../dist/wiki-change.js';
import { WorkflowStore } from '../dist/workflow-runtime.js';
import { draftSkillAddition } from '../dist/skill-addition.js';
import { changeSkillVersion, replaySkillAddition, verifySkillCommit } from '../dist/skill-replay.js';

function childModel(f, server) {
  f.env.AGENT_MEMORY_LLM_BASE_URL = server.url;
  f.env.AGENT_MEMORY_LLM_MODEL = 'protocol-fixture';
}
function approve(wiki, entry, body, metadata = {}) {
  const change = proposeWikiChange(wiki, { operation: 'create', entry, title: entry, mode: 'constraint', scope: ['project'], body, ...metadata }, ['fixture:human-approval']);
  applyWikiChange(wiki, change.id);
  return change;
}

async function evolved(f, base, instruction = 'Require migration_approval before creating a release.') {
  const draft = draftSkillAddition({ entry: join(f.root, f.entry), instruction, priority: 'high', sources: ['fixture:reviewed-run'] });
  const replay = replaySkillAddition(f.root, draft, { runner: join(f.root, 'tools/replay.mjs'), scenarios: JSON.parse(readFileSync(join(f.root, 'tools/scenarios.json'))) });
  changeSkillVersion(f.root, replay.id);
  const cache = await cacheRelease(f.root, f.client, f.project, base.head.release_id, base.manifest);
  const frozen = await freezeKnowledge(join(f.root, '.agent-memory', 'fixed-input'), cache, f.client, f.project, base.manifest);
  const validation = verifySkillCommit(f.root, replay.candidate, [{ entry: f.entry, runner: 'tools/replay.mjs', scenarios: 'tools/scenarios.json' }], frozen.path);
  const next = releaseFromProject(f, base.head.release_id);
  next.manifest.verification = { kind: 'evolved', session_id: 'fixture', replay_ids: [replay.id], validation_id: validation.id };
  const previous = await readProjectHead(f.client, f.project);
  const head = await publishRelease(f.client, f.project, next.manifest, next.bytes, previous.raw);
  return { ...next, head, replay, validation };
}

test('project identity, private roots and connection errors remain isolated and redacted', async t => {
  const server = await protocol(t);
  const a = projectFixture(t, server);
  const first = await seed(a);
  const b = projectFixture(t, server);
  const second = await seed(b);
  assert.notEqual(first.head.release_id, second.head.release_id);
  await assert.rejects(loadRelease(a.client, b.project, first.head.release_id), /NOT_FOUND/);
  await assert.rejects(readProjectHead(a.client, { ...a.project, account_id: 'different' }), /IDENTITY_MISMATCH/);
  assert.throws(() => validateProject({ ...a.project, root_uri: b.project.root_uri }), /ROOT_INVALID/);
  const calls = (await server.inspect()).calls;
  assert.ok(calls.every(call => Object.values(call.headers).every(value => value === undefined)));
  const profile = join(a.root, '.evolve', 'openviking.json');
  const config = join(a.root, '.agent-memory', 'ovcli.conf');
  writeFileSync(config, JSON.stringify({ url: server.url, api_key: 'wrong-private-key' }));
  assert.throws(() => a.evolve('openviking', 'status'), error => /UNAUTHENTICATED/.test(String(error.stderr)) && !/private-server-response|wrong-private-key/.test(String(error.stderr)));
  assert.equal(JSON.parse(readFileSync(profile)).project_id, a.project.project_id);
});

test('binary, executable, empty, CRLF/BOM and sidecar-named assets round-trip without committing user index', async t => {
  const server = await protocol(t);
  const a = projectFixture(t, server);
  const samples = new Map([
    ['skills/sample/icon.png', Buffer.from([137, 80, 78, 71, 13, 10, 0, 255, 1, 2])],
    ['skills/sample/empty', Buffer.alloc(0)], ['skills/sample/crlf.txt', Buffer.from('\uFEFFfirst\r\nsecond\r\n')],
    ['skills/sample/.abstract.md', Buffer.from('This is a package file, not a server summary.')],
    ['skills/sample/run.sh', Buffer.from('#!/bin/sh\nprintf ok\n')],
  ]);
  for (const [path, body] of samples) a.write(path, body);
  a.git('add', 'skills'); a.git('update-index', '--chmod=+x', 'skills/sample/run.sh'); a.git('commit', '-qm', '测试: 完整字节样本');
  const first = await seed(a);
  const b = projectFixture(t, server, { id: a.project.project_id });
  b.write('unrelated.txt', 'User staged content'); b.git('add', 'unrelated.txt');
  const before = b.git('rev-parse', 'HEAD');
  assert.throws(() => b.open('bytes', 'sample'), /STAGED_CHANGES/);
  assert.equal(b.status('bytes').openviking.phase, 'preparing');
  assert.equal(b.git('show', ':unrelated.txt'), 'User staged content');
  assert.equal(b.git('rev-parse', 'HEAD'), before);
  b.git('restore', '--staged', 'unrelated.txt');
  const ready = b.evolve('openviking', 'sync', ...b.fence('bytes'));
  assert.equal(ready.openviking.phase, 'ready');
  assert.equal(ready.openviking.release_id, first.head.release_id);
  for (const [path, body] of samples) assert.deepEqual(gitBytes(b.root, ['show', ready.openviking.skill_commit + ':' + path]), body);
  assert.match(b.git('ls-tree', ready.openviking.skill_commit, '--', 'skills/sample/run.sh'), /^100755 /);
  assert.equal(readFileSync(join(b.root, 'unrelated.txt'), 'utf8'), 'User staged content');
  assert.throws(() => b.git('show', ready.openviking.skill_commit + ':unrelated.txt'));
  const assets = skillAssets(b.root, ready.openviking.skill_commit);
  assert.deepEqual(assets.files.filter(file => first.manifest.files.some(expected => expected.path === file.path)), first.manifest.files);
});

test('sync preserves committed local Skill changes before and after the first materialization', async t => {
  const server = await protocol(t);
  for (const [prepared, deleted] of [[false, false], [true, false], [true, true]]) {
    const f = projectFixture(t, server);
    const release = await seed(f);
    if (prepared) {
      childModel(f, server);
      f.open('baseline', 'sample'); completeSample(f, 'baseline'); f.sealSession('baseline');
    }
    const body = readFileSync(join(f.root, f.entry), 'utf8') + '\nKeep the unpublished local approval rule.\n';
    if (deleted) f.git('rm', f.entry); else f.write(f.entry, body);
    f.git('add', 'skills'); f.git('commit', '-qm', '测试: 保留未发布的本地修改');
    const head = f.git('rev-parse', 'HEAD');
    assert.throws(() => f.open('local-change', 'sample'), /LOCAL_ASSET_CONFLICT/);
    assert.equal(f.git('rev-parse', 'HEAD'), head);
    if (deleted) assert.equal(existsSync(join(f.root, f.entry)), false);
    else assert.equal(readFileSync(join(f.root, f.entry), 'utf8'), body);
    assert.equal(f.status('local-change').openviking.phase, 'preparing');
    assert.equal((await readProjectHead(f.client, f.project)).head.release_id, release.head.release_id);
  }
});

test('first sync recognizes a released ancestor and removes its retired package files', async t => {
  const server = await protocol(t);
  const a = projectFixture(t, server);
  a.write('skills/sample/retired.txt', 'Previously published asset');
  a.git('add', 'skills'); a.git('commit', '-qm', '测试: 旧版完整包');
  const first = await seed(a);
  const b = projectFixture(t, server, { id: a.project.project_id });
  b.write('skills/sample/retired.txt', 'Previously published asset');
  b.git('add', 'skills'); b.git('commit', '-qm', '测试: 新机器保留旧版包');
  const body = readFileSync(join(a.root, a.entry), 'utf8') + '\nUse the current published approval rule.\n';
  a.write(a.entry, body); a.git('rm', 'skills/sample/retired.txt');
  a.git('add', 'skills'); a.git('commit', '-qm', '测试: 发布新版并移除旧文件');
  const next = releaseFromProject(a, first.head.release_id);
  const published = await publishRelease(a.client, a.project, next.manifest, next.bytes, (await readProjectHead(a.client, a.project)).raw);
  const ready = b.open('new-machine', 'sample');
  assert.equal(ready.openviking.release_id, published.release_id);
  assert.equal(readFileSync(join(b.root, b.entry), 'utf8'), body);
  assert.equal(existsSync(join(b.root, 'skills/sample/retired.txt')), false);
  assert.deepEqual(skillAssets(b.root, ready.openviking.skill_commit).files, next.manifest.files);
});

test('corrupt downloads, unsafe manifests and missing files cannot bind ready or advance Git/current', async t => {
  const server = await protocol(t);
  const a = projectFixture(t, server);
  const release = await seed(a);
  const b = projectFixture(t, server, { id: a.project.project_id });
  const file = release.manifest.files.find(file => file.path === a.entry);
  const uri = `${a.project.root_uri}/blobs/${file.sha256}.bin`;
  const before = b.git('rev-parse', 'HEAD');
  await server.update({ corrupt: { [uri]: Buffer.from('corrupt').toString('base64') } });
  assert.throws(() => b.open('corrupt', 'sample'), /HASH_MISMATCH/);
  assert.equal(b.git('rev-parse', 'HEAD'), before);
  assert.equal(b.status('corrupt').openviking.phase, 'preparing');
  const head = await readProjectHead(a.client, a.project);
  const unsafe = structuredClone(release.manifest);
  unsafe.files[0].path = 'skills/../../.git/config';
  assert.throws(() => validateManifest(unsafe, a.project), /path|ASSET_PATH/);
  const collision = structuredClone(release.manifest);
  collision.files.push({ ...collision.files[0], path: 'skills/SAMPLE/SKILL.md' });
  assert.throws(() => validateManifest(collision, a.project), /COLLISION/);
  await server.update({ corrupt: {}, missing: [uri] });
  assert.throws(() => b.evolve('openviking', 'sync', ...b.fence('corrupt')), /NOT_FOUND/);
  assert.equal(b.git('rev-parse', 'HEAD'), before);
  assert.deepEqual((await readProjectHead(a.client, a.project)).raw, head.raw);
  await server.update({ missing: [] });
  assert.equal(b.evolve('openviking', 'sync', ...b.fence('corrupt')).openviking.phase, 'ready');
});

test('single-pointer CAS has one winner and recognizes server commit after a lost response', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server);
  const base = await seed(f);
  const old = await readProjectHead(f.client, f.project);
  const ours = releaseFromProject(f, base.head.release_id);
  const theirs = releaseFromProject(f, base.head.release_id);
  const result = await Promise.allSettled([publishRelease(f.client, f.project, ours.manifest, ours.bytes, old.raw), publishRelease(f.client, f.project, theirs.manifest, theirs.bytes, old.raw)]);
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
  assert.match(result.find(item => item.status === 'rejected').reason.message, /PUBLICATION_CONFLICT/);
  const current = await readProjectHead(f.client, f.project);
  const next = releaseFromProject(f, current.head.release_id);
  await server.update({ dropPointer: true });
  const published = await publishRelease(f.client, f.project, next.manifest, next.bytes, current.raw);
  assert.equal(published.release_id, sha256(manifestBytes(next.manifest)));
  assert.equal((await readProjectHead(f.client, f.project)).head.release_id, published.release_id);
  assert.equal((await publishRelease(f.client, f.project, next.manifest, next.bytes, current.raw)).release_id, published.release_id);
});

test('remote Session retries bind one commit; the next Session receives the new validated release', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server);
  childModel(f, server);
  const first = await seed(f);
  f.open('pinned', 'sample');
  const attempt = f.next('pinned');
  assert.equal(attempt.skill_ref.commit, f.status('pinned').openviking.skill_commit);
  f.evolve('run', 'skill-read', attempt.run_id, '--session', 'pinned');
  f.evolve('run', 'cancel', attempt.run_id, ...f.fence('pinned'), '--expected-run-revision', '0', '--reason', 'Observed retry');
  const next = await evolved(f, first);
  const retry = f.next('pinned');
  assert.equal(retry.skill_ref.commit, attempt.skill_ref.commit);
  assert.doesNotMatch(f.evolve('run', 'skill-read', retry.run_id, '--session', 'pinned').markdown, /migration_approval/);
  f.finish('pinned', retry, 'Retry finished');
  assert.equal(f.sealSession('pinned').asset_publication.openviking.publication.state, 'no_change');
  const second = f.open('new-session', 'sample');
  assert.equal(second.openviking.release_id, next.head.release_id);
  const run = f.next('new-session');
  assert.match(f.evolve('run', 'skill-read', run.run_id, '--session', 'new-session').markdown, /migration_approval/);
});

test('CLI and HTTP read the same full Memory bytes and all repository-scoped constraints', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server);
  const wiki = new Wiki(f.root);
  for (let index = 0; index < 12; index++) approve(wiki, `entries/constraint-${index}`, `Deployment rule ${index}`, { repositories: [f.project.project_id] });
  approve(wiki, 'entries/other-repository', 'Not applicable here', { repositories: [randomUUID()] });
  const retired = approve(wiki, 'entries/retired', 'Retired deployment rule');
  applyWikiChange(wiki, proposeWikiChange(wiki, { operation: 'retire', entry: retired.entry }, ['fixture:retire-approval']).id);
  approve(wiki, 'entries/reference', 'Deployment reference text', { mode: 'reference' });
  f.git('add', 'wiki'); f.git('commit', '-qm', '测试: 已审批知识');
  const content = 'Deployment build 00123 uses Token-AbC_007.\n' + 'Exact source body. '.repeat(5000) + '\nEnd of original record.';
  const memory = new MemoryStore(defaultMemoryDbPath(f.root));
  const record = await memory.put({ id: 'original-memory', content, sourceMessageIds: ['source:actual-message-00123'], type: 'verified_fix', session: 'history-1' }); memory.close();
  selectMemory(f.root, record.id, 'share');
  const release = await seed(f);
  const reads = join(f.root, '.agent-memory', 'query-reads.json');
  const envelope = f.evolve('search', 'Deployment', '--mode', 'context', '--include-memory', '--limit', '1', '--reads', reads);
  assert.equal(envelope.constraints.length, 12);
  assert.ok(envelope.constraints.every(item => !/Retired|Not applicable/.test(item.content)));
  const found = f.evolve('kb', 'search', '00123', '--kind', 'episodic', '--reads', reads);
  assert.equal(found.results.length, 1);
  const id = found.results[0].id;
  assert.match(id, /^ov:[a-f0-9]{64}:/);
  assert.equal(found.results[0].version, record.version);
  const loaded = f.evolve('kb', 'get', id, '--kind', 'episodic', '--reads', reads, '--from-search', found.knowledge_reads.searches.at(-1).search_id);
  assert.equal(loaded.content, content); assert.deepEqual(loaded.sourceMessageIds, record.sourceMessageIds);
  assert.equal(loaded.openviking_reads[0].content_sha256, sha256(content));
  assert.equal(loaded.openviking_reads[0].via, 'cache');
  const sources = await openKnowledgeSources(f.root, { includeMemory: true });
  const http = createSearchServer(sources);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.close(); sources.memory?.close?.(); });
  const httpResult = await (await fetch(`http://127.0.0.1:${http.address().port}/search?q=00123&scope=memory`)).json();
  assert.equal(httpResult.memory.results[0].content, content);
  const httpContext = await (await fetch(`http://127.0.0.1:${http.address().port}/context?q=Deployment&limit=1`)).json();
  assert.equal(httpContext.constraints.length, 12);
  const cliReads = join(f.root, '.agent-memory', 'run-reads.json');
  const cliFound = f.evolve('kb', 'search', 'Deployment', '--kind', 'episodic', '--reads', cliReads);
  const cliLoaded = f.evolve('kb', 'get', id, '--kind', 'episodic', '--reads', cliReads,
    '--from-search', cliFound.knowledge_reads.searches.at(-1).search_id);
  assert.equal(cliLoaded.content, content);
  assert.ok(cliLoaded.openviking_reads.some(item => item.record_id === id && item.content_sha256 === sha256(content)));
  const cliContext = f.evolve('search', 'Deployment', '--mode', 'context', '--limit', '1');
  assert.equal(cliContext.constraints.length, 12);
  assert.ok((await server.inspect()).calls.filter(call => call.path === '/api/v1/search/find').every(call => call.input.target_uri === `${f.project.root_uri}/releases/${release.head.release_id}/memory`));
});

test('Memory sharing freezes approval, unshare keeps a tombstone and index failure cannot publish', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server);
  const local = new MemoryStore(defaultMemoryDbPath(f.root));
  f.dispose(() => local.close());
  await local.put({ id: 'm', content: 'Deployment code 00123' }); selectMemory(f.root, 'm', 'share');
  const first = await seed(f);
  await local.put({ id: 'm', content: 'Deployment changed 00456' });
  assert.throws(() => exportMemory(f.root, first.manifest), /APPROVAL_CHANGED/);
  selectMemory(f.root, 'm', 'share');
  const next = releaseFromProject(f, first.head.release_id);
  await server.update({ queueError: true });
  await assert.rejects(publishRelease(f.client, f.project, next.manifest, next.bytes, (await readProjectHead(f.client, f.project)).raw), /BATCH_INCOMPLETE/);
  assert.equal((await readProjectHead(f.client, f.project)).head.release_id, first.head.release_id);
  await server.update({ queueError: false });
  const published = await publishRelease(f.client, f.project, next.manifest, next.bytes, (await readProjectHead(f.client, f.project)).raw);
  const oldId = `ov:${first.head.release_id}:${Buffer.from('m').toString('base64url')}`;
  assert.equal(f.evolve('kb', 'get', oldId, '--kind', 'episodic').content, 'Deployment code 00123');
  selectMemory(f.root, 'm', 'unshare');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.agent-memory/openviking/share.json'))).changes.m, { operation: 'unshare' });
  assert.equal(exportMemory(f.root, next.manifest).memory.length, 0);
  assert.notEqual(published.release_id, first.head.release_id);
});

test('completed Sessions survive model failure and finish recovers once without a zero-signal release', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server);
  const release = await seed(f);
  delete f.env.AGENT_MEMORY_LLM_BASE_URL; delete f.env.AGENT_MEMORY_LLM_MODEL;
  f.open('recovery', 'sample'); completeSample(f, 'recovery');
  assert.throws(() => f.sealSession('recovery'));
  assert.equal(f.status('recovery').status, 'completed');
  assert.equal(f.status('recovery').openviking.publication.state, 'failed');
  assert.equal((await readProjectHead(f.client, f.project)).head.release_id, release.head.release_id);
  childModel(f, server);
  const result = f.evolve('openviking', 'finish', ...f.fence('recovery'));
  assert.equal(result.openviking.publication.state, 'no_change');
  const before = (await server.inspect()).calls.filter(call => call.path === '/chat/completions').length;
  assert.equal(f.evolve('openviking', 'finish', ...f.fence('recovery')).openviking.publication.state, 'no_change');
  assert.equal((await server.inspect()).calls.filter(call => call.path === '/chat/completions').length, before);
});

test('automatic Session review drives business replay through the installed CLI boundary without local dependencies', async t => {
  const server = await protocol(t);
  await server.update({ model: 'generated' });
  const f = projectFixture(t, server, { driver: true }); childModel(f, server); fakeAgy(f);
  f.write('tools/scenarios.json', JSON.stringify([
    { id: 'approved', input: { build: '00123', migrationApproved: true }, baseline: true },
    { id: 'prior-fixed-case', input: { build: '00234', migrationApproved: true }, baseline: false },
  ]));
  f.git('add', 'tools/scenarios.json'); f.git('commit', '-qm', '测试: 旧复现用例已通过');
  const base = await seed(f);
  assert.equal(existsSync(join(f.root, 'dist')), false); assert.equal(existsSync(join(f.root, 'node_modules')), false);
  f.open('evolution', 'sample'); completeSample(f, 'evolution', 'Deployment failed: the migration approval check was omitted');
  const result = f.sealSession('evolution');
  assert.equal(result.asset_publication.openviking.publication.state, 'published');
  const release = await loadRelease(f.client, f.project, result.asset_publication.published_release);
  assert.equal(release.verification.kind, 'evolved'); assert.equal(release.verification.replay_ids.length, 1);
  assert.match(release.verification.validation_id, /^[a-f0-9]{64}$/);
  assert.notEqual(result.asset_publication.published_release, base.head.release_id);
  assert.match(f.git('show', 'HEAD:' + f.entry), /migration_approval/);
  const snapshot = join(f.root, '.agent-memory/openviking/jobs/evolution/knowledge');
  assert.equal(frozenKnowledgeHash(snapshot), readFileSync(join(snapshot, 'sha256'), 'utf8'));
  const job = readFileSync(join(f.root, '.agent-memory/openviking/jobs/evolution/finish.json'), 'utf8');
  const input = JSON.parse(job).scenario_inputs[f.entry];
  assert.ok(input.sources.some(source => source.startsWith('evolve:evolution#')));
  const scenarios = join(f.root, '.agent-memory/openviking/jobs/evolution', sha256(f.entry) + '-evolution', 'scenarios.json');
  const validated = JSON.parse(f.git('show', 'HEAD:tools/scenarios.json'));
  assert.equal(validated.length, 2);
  assert.equal(sha256(readFileSync(scenarios)), input.sha256);
  const proofPath = join(f.git('rev-parse', '--absolute-git-dir'), 'evolve-validations', release.verification.validation_id + '.json');
  const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
  assert.equal(proof.targets[0].scenarios_sha256, input.sha256);
  assert.ok(proof.targets[0].observations.some(item => item.id.startsWith('repro-')));
  assert.equal((await server.inspect()).calls.filter(call => call.input?.messages?.[0]?.content.startsWith('Suggest data-only replay inputs')).length, 1);
});

test('Agy rejection, foreign evidence and post-apply runner failures never advance the remote pointer', async t => {
  for (const flag of ['FIXTURE_REJECT_DISCUSSION', 'FIXTURE_REJECT_CONFIRM', 'FIXTURE_BAD_SOURCE', 'FIXTURE_FAIL_AFTER_APPLY']) {
    await t.test(flag, async t => {
      const server = await protocol(t); await server.update({ model: 'signal' });
      const f = projectFixture(t, server, { driver: true }); childModel(f, server); fakeAgy(f); f.env[flag] = '1';
      const base = await seed(f); f.open('rejected', 'sample'); completeSample(f, 'rejected', 'Deployment failed at the missing migration gate');
      assert.throws(() => f.sealSession('rejected'));
      assert.equal(f.status('rejected').status, 'completed'); assert.equal(f.status('rejected').openviking.publication.state, 'failed');
      assert.equal((await readProjectHead(f.client, f.project)).head.release_id, base.head.release_id);
    });
  }
});

test('three-way merge combines nonoverlapping text and rejects binary or deletion conflicts before publication', async t => {
  const server = await protocol(t); const f = projectFixture(t, server); const base = releaseFromProject(f);
  const path = 'skills/sample/notes.txt'; const body = Buffer.from('one\ntwo\nthree\nfour\nfive\nsix\n');
  base.bytes.set(path, body); base.manifest.files.push(fileRecord(path, body));
  const ours = structuredClone(base.manifest); const theirs = structuredClone(base.manifest);
  const ourBytes = new Map(base.bytes), theirBytes = new Map(base.bytes);
  ourBytes.set(path, Buffer.from('ONE\ntwo\nthree\nfour\nfive\nsix\n')); theirBytes.set(path, Buffer.from('one\ntwo\nthree\nfour\nfive\nSIX\n'));
  ours.files = ours.files.map(file => file.path === path ? fileRecord(path, ourBytes.get(path)) : file);
  theirs.files = theirs.files.map(file => file.path === path ? fileRecord(path, theirBytes.get(path)) : file);
  const merged = mergeProjectAssets(base.manifest, ours, theirs, base.bytes, ourBytes, theirBytes, join(f.root, '.agent-memory/merge-ok'));
  assert.equal(merged.bytes.get(path).toString(), 'ONE\ntwo\nthree\nfour\nfive\nSIX\n');
  ourBytes.set(path, Buffer.from([0, 1])); theirBytes.set(path, Buffer.from([0, 2]));
  ours.files = ours.files.map(file => file.path === path ? fileRecord(path, ourBytes.get(path)) : file);
  theirs.files = theirs.files.map(file => file.path === path ? fileRecord(path, theirBytes.get(path)) : file);
  assert.throws(() => mergeProjectAssets(base.manifest, ours, theirs, base.bytes, ourBytes, theirBytes, join(f.root, '.agent-memory/merge-binary')), /MERGE_CONFLICT/);
  ours.files = ours.files.filter(file => file.path !== path);
  assert.throws(() => mergeProjectAssets(base.manifest, ours, theirs, base.bytes, ourBytes, theirBytes, join(f.root, '.agent-memory/merge-delete')), /MERGE_CONFLICT/);
  assert.ok(existsSync(join(f.root, '.agent-memory/merge-delete/conflicts.json')));
});

test('configuration can unplug OpenViking; outages fall back visibly without bypassing pinned IDs or integrity errors', async t => {
  const server = await protocol(t); const f = projectFixture(t, server); const release = await seed(f);
  const local = new MemoryStore(defaultMemoryDbPath(f.root)); await local.put({ id: 'local-only', content: 'Local deployment guidance' }); local.close();
  f.evolve('openviking', 'config', '--enabled', 'false');
  await server.update({ unavailable: true });
  assert.equal(f.evolve('openviking', 'status').backend, 'local');
  assert.equal(f.evolve('kb', 'search', 'deployment', '--kind', 'episodic').results[0].id, 'local-only');
  const disabled = f.open('disabled', 'sample'); assert.equal(disabled.openviking, undefined);
  f.evolve('openviking', 'config', '--enabled', 'true', '--failure-policy', 'local');
  const fallback = f.evolve('search', 'deployment', '--mode', 'context', '--include-memory');
  assert.equal(fallback.knowledge_backend.active, 'local'); assert.match(fallback.knowledge_backend.fallback_reason, /503|UNKNOWN/);
  assert.equal(f.open('offline', 'sample').knowledge_backend.active, 'local');
  const id = `ov:${release.head.release_id}:${Buffer.from('local-only').toString('base64url')}`;
  assert.throws(() => f.evolve('kb', 'get', id, '--kind', 'episodic'));
  f.evolve('openviking', 'config', '--failure-policy', 'fail');
  assert.throws(() => f.evolve('search', 'deployment', '--mode', 'context', '--include-memory'), /503/);
});

test('frozen Memory rejects writes before calling a model and retains identical logical bytes', async t => {
  const server = await protocol(t); const f = projectFixture(t, server); const release = await seed(f);
  const cache = await cacheRelease(f.root, f.client, f.project, release.head.release_id, release.manifest);
  const snapshot = await freezeKnowledge(join(f.root, '.agent-memory/frozen'), cache, f.client, f.project, release.manifest);
  const reader = new MemoryStore(join(snapshot.path, 'memory.db'), { readOnly: true });
  await assert.rejects(reader.put({ id: 'forbidden', content: 'must not persist' }), /read-only/);
  let called = false;
  await assert.rejects(reader.extract([{ id: 'm', role: 'user', timestamp: 1, content: 'message' }], { session: 's', llm: { chat: async () => { called = true; return '[]'; } } }), /read-only/);
  assert.equal(called, false); reader.close();
  assert.equal(frozenKnowledgeHash(snapshot.path), snapshot.hash);
  f.env.EVOLVE_KNOWLEDGE_SNAPSHOT = snapshot.path; f.env.AGENT_MEMORY_DB = join(snapshot.path, 'memory.db');
  assert.throws(() => f.evolve('kb', 'add', 'must not persist', '--kind', 'episodic'), /read-only/);
  assert.equal(frozenKnowledgeHash(snapshot.path), snapshot.hash);
});

test('init commits only the profile and missing bundled Skills, and remains explicitly opt-in', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { profile: false });
  f.write('user-note.txt', 'Unrelated user work');
  const initialized = f.evolve('--root', f.root, 'openviking', 'init', '--policy', 'evolution.json', '--project-id', f.project.project_id);
  assert.equal(initialized.project.project_id, f.project.project_id);
  assert.equal(initialized.project.enabled, true);
  assert.equal(initialized.project.failure_policy, 'local');
  assert.throws(() => f.git('show', 'HEAD:user-note.txt'));
  assert.equal(readFileSync(join(f.root, 'user-note.txt'), 'utf8'), 'Unrelated user work');
  assert.equal(existsSync(join(f.root, 'agents/workflow-executor.md')), true);
  assert.equal(existsSync(join(f.root, '.omp/agent/agents')), false);
  const manifest = await loadRelease(f.client, f.project, initialized.head.release_id);
  assert.equal(manifest.verification.kind, 'bootstrap');
  assert.deepEqual(manifest.verification.replay_ids, []);
  assert.ok(manifest.files.some(file => file.path === 'skills/workflow-evolve/scripts/evolve-loop.mjs'));
  assert.equal(f.evolve('openviking', 'init', '--policy', 'evolution.json').head.release_id, initialized.head.release_id);
  assert.equal(f.evolve('openviking', 'config', '--enabled', 'false').backend, 'local');
});

test('init recovers installer-owned untracked Skills while preserving local edits and the index', async t => {
  const server = await protocol(t);
  for (const host of [undefined, 'omp']) {
    const f = projectFixture(t, server, { profile: false });
    const installed = installSkills(f.root, ['ew-knowledge'], host);
    // 覆盖包已落盘、安装清单尚未写入就中断的情况。
    if (host === 'omp') rmSync(installed.manifest_path);
    const path = host ? '.omp/skills/ew-knowledge/SKILL.md' : 'skills/ew-knowledge/SKILL.md';
    const body = readFileSync(join(f.root, path), 'utf8');
    const before = f.git('rev-parse', 'HEAD');
    f.write(path, body + '\nUser modification.\n');
    await assert.rejects(initializeProject(f.root, undefined, f.project.project_id, host, host), /MANAGED_DIRTY/);
    assert.equal(readFileSync(join(f.root, path), 'utf8'), body + '\nUser modification.\n');
    assert.equal(f.git('rev-parse', 'HEAD'), before);
    f.write(path, body);
    f.write('skills/unknown/SKILL.md', 'User-owned untracked Skill.\n');
    await assert.rejects(initializeProject(f.root, undefined, f.project.project_id, host, host), /MANAGED_DIRTY/);
    assert.equal(readFileSync(join(f.root, 'skills/unknown/SKILL.md'), 'utf8'), 'User-owned untracked Skill.\n');
    rmSync(join(f.root, 'skills/unknown'), { recursive: true });
    f.write('user-note.txt', 'Unrelated staged work'); f.git('add', 'user-note.txt');
    await assert.rejects(initializeProject(f.root, undefined, f.project.project_id, host, host), /STAGED_CHANGES/);
    assert.equal(f.git('show', ':user-note.txt'), 'Unrelated staged work');
    f.git('restore', '--staged', 'user-note.txt');
    const initialized = await initializeProject(f.root, undefined, f.project.project_id, host, host);
    assert.equal(f.git('show', 'HEAD:' + path), body.trimEnd());
    assert.equal(readFileSync(join(f.root, path), 'utf8'), body);
    assert.equal(f.git('status', '--porcelain', '--', installed.skills_dir), '');
    assert.equal(readFileSync(join(f.root, 'user-note.txt'), 'utf8'), 'Unrelated staged work');
    const manifest = await loadRelease(f.client, f.project, initialized.head.release_id);
    assert.ok(manifest.files.some(file => file.path === path));
    assert.equal((await initializeProject(f.root, undefined, f.project.project_id, host, host)).head.release_id, initialized.head.release_id);
  }
});

test('init installs host Agents without moving Skills or publishing Agent definitions', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { profile: false, minimalSkills: true });
  f.git('rm', '-r', 'agents'); f.git('commit', '-qm', '测试: 不预置通用 Agent');
  f.write('.claude/agents/workflow-reviewer.md', 'User customized Agent definition.\n');
  const initialized = await initializeProject(f.root, undefined, f.project.project_id, 'claude');
  assert.equal(existsSync(join(f.root, 'agents')), false);
  assert.equal(existsSync(join(f.root, '.claude/agents/workflow-executor.md')), true);
  assert.equal(existsSync(join(f.root, '.claude/skills')), false);
  assert.equal(readFileSync(join(f.root, '.claude/agents/workflow-reviewer.md'), 'utf8'), 'User customized Agent definition.\n');
  assert.equal(f.git('ls-tree', '-r', '--name-only', 'HEAD', '--', '.claude/agents'), '');
  const manifest = await loadRelease(f.client, f.project, initialized.head.release_id);
  assert.ok(manifest.files.every(file => file.path.startsWith('skills/')));
  // 后续普通安装保留已选择的 Agent 宿主，不重新创建根目录副本。
  installSkills(f.root, ['ew-knowledge']);
  assert.equal(existsSync(join(f.root, 'agents')), false);
  const status = installStatus(f.root).targets.find(target => target.skills_dir === join(f.root, 'skills'));
  assert.equal(status.agents_dir, join(f.root, '.claude/agents'));
  assert.equal(status.agents.find(agent => agent.name === 'workflow-executor').status, 'up_to_date');
});

test('OMP native init exports .omp/skills assets without root mirrors or Agent definitions', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { profile: false });
  const initialized = await initializeProject(f.root, undefined, f.project.project_id, 'omp', 'omp');
  assert.ok(existsSync(join(f.root, '.omp', 'skills', 'ew-orchestrate', 'SKILL.md')));
  assert.ok(existsSync(join(f.root, '.omp', 'skills', 'workflow-evolve', 'scripts', 'evolve-loop.mjs')));
  assert.ok(existsSync(join(f.root, '.omp', 'agent', 'agents', 'workflow-executor.md')));
  assert.equal(existsSync(join(f.root, 'skills', 'ew-orchestrate', 'SKILL.md')), false);
  assert.ok(existsSync(join(f.root, 'skills', 'sample', 'SKILL.md')));
  const manifest = await loadRelease(f.client, f.project, initialized.head.release_id);
  assert.ok(manifest.files.some(file => file.path === '.omp/skills/ew-orchestrate/SKILL.md'));
  assert.ok(manifest.files.some(file => file.path === 'skills/sample/SKILL.md'));
  assert.ok(manifest.files.every(file => !file.path.startsWith('.omp/agent/')));
  assert.equal(f.git('ls-tree', '-r', '--name-only', 'HEAD', '--', '.omp/agent'), '');

  const b = projectFixture(t, server, { id: f.project.project_id });
  const opened = b.open('omp-native-sync', 'ew-orchestrate');
  assert.equal(opened.openviking.phase, 'ready');
  assert.equal(opened.openviking.release_id, initialized.head.release_id);
  assert.ok(existsSync(join(b.root, '.omp', 'skills', 'ew-orchestrate', 'SKILL.md')));
  assert.ok(existsSync(join(b.root, 'skills', 'sample', 'SKILL.md')));
  assert.match(b.git('show', opened.openviking.skill_commit + ':.omp/skills/ew-orchestrate/SKILL.md'), /name: ew-orchestrate/);
  const run = b.next('omp-native-sync');
  assert.equal(run.skill_ref.package_path, '.omp/skills/ew-orchestrate');
  assert.match(b.evolve('run', 'skill-read', run.run_id, '--session', 'omp-native-sync').markdown, /name: ew-orchestrate/);

  const local = readFileSync(join(f.root, '.omp/skills/ew-orchestrate/SKILL.md'), 'utf8') + '\nLocal native OMP modification.\n';
  f.write('.omp/skills/ew-orchestrate/SKILL.md', local);
  f.git('add', '.omp/skills'); f.git('commit', '-qm', '测试: 本地 OMP Skill 修改');
  assert.throws(() => f.open('omp-native-conflict', 'sample'), /LOCAL_ASSET_CONFLICT/);
});

test('OMP native policy validates and replays .omp/skills targets without a real model', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { profile: false });
  mkdirSync(join(f.root, '.omp', 'skills'), { recursive: true });
  cpSync(join(f.root, 'skills', 'sample'), join(f.root, '.omp', 'skills', 'sample'), { recursive: true });
  f.write('.omp/tools/scenarios.json', readFileSync(join(f.root, 'tools', 'scenarios.json'), 'utf8'));
  f.write('.omp/tools/replay.mjs', `import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const request = JSON.parse(readFileSync(0, 'utf8'));
const body = readFileSync(request.entry, 'utf8');
const script = '.omp/skills/sample/scripts/release.mjs';
const {release} = await import(pathToFileURL(join(process.cwd(), script)).href);
const result = release(request.input, body.includes('migration_approval'));
const passed = request.input.migrationApproved ? result.decision === 'released' && result.artifact.build === request.input.build
  : result.decision === 'blocked' && result.artifact === null;
console.log(JSON.stringify({passed, loaded: [request.entry, script].map(path => ({path, sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}))}));\n`);
  f.write('native-evolution.json', JSON.stringify({ schema_version: 'evolve-openviking-policy/1.0',
    targets: [{ entry: '.omp/skills/sample/SKILL.md', runner: '.omp/tools/replay.mjs', scenarios: '.omp/tools/scenarios.json' }] }));
  f.git('add', '.omp', 'native-evolution.json'); f.git('commit', '-qm', '测试: 原生 OMP 回放策略');
  const policy = readPolicy(f.root, 'native-evolution.json');
  assert.equal(policy.targets[0].entry, '.omp/skills/sample/SKILL.md');
  assert.throws(() => validateEvolutionPolicy(f.root, { schema_version: 'evolve-openviking-policy/1.0',
    targets: [{ entry: '.omp/agent/agents/workflow-executor.md', runner: '.omp/tools/replay.mjs', scenarios: '.omp/tools/scenarios.json' }] }), /POLICY_ENTRY_INVALID/);

  const release = await seed(f);
  const cache = await cacheRelease(f.root, f.client, f.project, release.head.release_id, release.manifest);
  const snapshot = await freezeKnowledge(join(f.root, '.agent-memory', 'native-policy-frozen'), cache, f.client, f.project, release.manifest);
  const folder = join(f.root, '.agent-memory', 'native-policy-replay');
  const frozen = await prepareEvolutionScenarios(f.root, f.git('rev-parse', 'HEAD'), policy.targets[0], folder, snapshot.path,
    [{ summary: 'Native OMP target needs migration approval', sources: ['fixture:native-omp'] }]);
  assert.ok('sha256' in frozen);
  const cases = JSON.parse(readFileSync(join(folder, 'scenarios.json'), 'utf8'));
  assert.equal(cases.length, 2);
  assert.ok(cases.some(item => item.baseline === false));
});

test('init keeps migrated Wiki local until an explicit approval is published', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { profile: false, minimalSkills: true });
  f.write('.workflow/knowhow/migration.md', '---\ntitle: Legacy deployment checklist\n---\n\nCheck the legacy deployment window.\n');
  const { entries: [migrated] } = f.evolve('kb', 'import', '--project', 'legacy-project', '--apply');
  const entry = `entries/${migrated.id}`;
  const localFile = join(f.root, 'wiki', `${entry}.md`);
  const original = readFileSync(localFile);
  approve(new Wiki(f.root), 'entries/approved', 'Publish only after review.');

  const initial = f.evolve('openviking', 'init', '--project-id', f.project.project_id);
  const bootstrap = await loadRelease(f.client, f.project, initial.head.release_id);
  assert.deepEqual(initial.local_only_wiki, [entry]);
  assert.deepEqual(bootstrap.wiki.map(item => item.entry), ['entries/approved']);
  assert.equal(bootstrap.files.some(file => file.path === `wiki/${entry}.md`), false);
  assert.deepEqual(readFileSync(localFile), original);
  assert.deepEqual(f.evolve('kb', 'changes', '--entry', entry), []);

  f.open('publish-migrated', 'sample'); completeSample(f, 'publish-migrated');
  const proposal = f.evolve('kb', 'update', entry, '--evidence', 'fixture:reviewed-legacy-checklist');
  f.evolve('kb', 'apply', proposal.id);
  const result = f.sealSession('publish-migrated');
  const release = await loadRelease(f.client, f.project, result.asset_publication.published_release);
  assert.equal(release.wiki.find(item => item.entry === entry).approval.id, proposal.id);
});

test('empty default policy syncs approved knowledge without a model or Skill replay', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { profile: false, minimalSkills: true });
  f.git('rm', 'evolution.json'); f.git('commit', '-qm', '测试: 不预置演进策略');
  const initial = f.evolve('openviking', 'init', '--project-id', f.project.project_id);
  assert.equal(existsSync(join(f.root, 'evolution.json')), false);
  assert.equal(initial.project.evolution_policy, '.evolve/evolution.json');
  assert.deepEqual(JSON.parse(f.git('show', 'HEAD:.evolve/evolution.json')), {
    schema_version: 'evolve-openviking-policy/1.0', targets: [],
  });
  assert.deepEqual(f.evolve('openviking', 'policy'), { mode: 'sync', path: '.evolve/evolution.json', targets: [] });
  f.open('sync-only', 'sample'); completeSample(f, 'sync-only');
  const local = new MemoryStore(defaultMemoryDbPath(f.root));
  await local.put({ id: 'sync-note', content: 'Share the deployment checklist.' }); local.close();
  selectMemory(f.root, 'sync-note', 'share');
  const result = f.sealSession('sync-only');
  const release = await loadRelease(f.client, f.project, result.asset_publication.published_release);
  const original = await loadRelease(f.client, f.project, initial.head.release_id);
  assert.equal(release.verification.kind, 'knowledge');
  assert.deepEqual(release.verification.replay_ids, []);
  assert.deepEqual(release.files.filter(file => file.path.startsWith('skills/')), original.files);
  assert.equal(release.memory[0].origin_id, 'sync-note');

  f.open('reject-skill', 'sample'); completeSample(f, 'reject-skill');
  f.write('skills/sample/unverified.txt', 'Never published');
  f.git('add', '--', 'skills/sample/unverified.txt'); f.git('commit', '-qm', '测试: 未验证 Skill 变更');
  const extra = new MemoryStore(defaultMemoryDbPath(f.root));
  await extra.put({ id: 'next-note', content: 'An approved follow-up.' }); extra.close();
  selectMemory(f.root, 'next-note', 'share');
  assert.throws(() => f.sealSession('reject-skill'));
  assert.equal(f.status('reject-skill').openviking.publication.error, 'OPENVIKING_UNVERIFIED_SKILL_CHANGES');
  assert.equal((await readProjectHead(f.client, f.project)).head.release_id, result.asset_publication.published_release);
});

test('Agent policy preview binds the committed replay inputs and cannot apply after HEAD changes', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { profile: false, minimalSkills: true });
  f.git('rm', 'evolution.json'); f.git('commit', '-qm', '测试: 由 Agent 管理策略');
  const initial = f.evolve('openviking', 'init', '--project-id', f.project.project_id);
  const args = ['openviking', 'policy', '--entry', f.entry, '--runner', 'tools/replay.mjs', '--scenarios', 'tools/scenarios.json'];
  const before = f.git('rev-parse', 'HEAD');
  const preview = f.evolve(...args);
  assert.equal(preview.status, 'preview');
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(existsSync(join(f.root, 'evolution.json')), false);
  f.git('commit', '--allow-empty', '-qm', '测试: 预览后更新 HEAD');
  assert.throws(() => f.evolve(...args, '--apply', preview.preview_id), error => /OPENVIKING_POLICY_PREVIEW_STALE/.test(error.stderr));
  const apply = f.evolve(...args, '--apply', f.evolve(...args).preview_id);
  assert.equal(apply.status, 'applied');
  assert.equal(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', apply.commit), '.evolve/evolution.json');
  assert.equal(f.evolve(...args).status, 'unchanged');
  assert.equal(f.evolve('openviking', 'policy').targets[0].entry, f.entry);
  assert.equal((await readProjectHead(f.client, f.project)).head.release_id, initial.head.release_id);
});

test('merged Skill trees are replayed on the frozen knowledge before their release can become current', async t => {
  const server = await protocol(t); const f = projectFixture(t, server); const base = await seed(f);
  const ours = await evolved(f, base);
  const theirs = structuredClone(ours.manifest); const theirBytes = new Map(ours.bytes);
  const path = 'skills/sample/concurrent.txt'; const body = Buffer.from('Independent machine release note.\n');
  theirs.files.push(fileRecord(path, body)); theirBytes.set(path, body);
  const merged = mergeProjectAssets(base.manifest, ours.manifest, theirs, base.bytes, ours.bytes, theirBytes, join(f.root, '.agent-memory/merge-validated'));
  const commit = createAssetCommit(f.root, ours.replay.candidate, merged.manifest.files, merged.bytes, [], '测试: 合并并发资产');
  const snapshot = join(f.root, '.agent-memory/fixed-input');
  const proof = verifySkillCommit(f.root, commit, [{ entry: f.entry, runner: 'tools/replay.mjs', scenarios: 'tools/scenarios.json' }], snapshot);
  assert.ok(proof.targets[0].observations.every(item => item.passed));
  assert.equal(proof.knowledge_sha256, frozenKnowledgeHash(snapshot));
  merged.manifest.source_commit = commit; merged.manifest.parent = ours.head.release_id;
  merged.manifest.verification.validation_id = proof.id;
  const result = await publishRelease(f.client, f.project, merged.manifest, merged.bytes, (await readProjectHead(f.client, f.project)).raw);
  assert.equal((await loadRelease(f.client, f.project, result.release_id)).verification.validation_id, proof.id);
  assert.equal((await readProjectHead(f.client, f.project)).head.release_id, result.release_id);
});

test('unplugging a pinned Session uses verified cache and local Memory without any new HTTP request', async t => {
  const server = await protocol(t); const f = projectFixture(t, server);
  approve(new Wiki(f.root), 'entries/pinned-rule', 'Pinned deployment rule', { repositories: [f.project.project_id] });
  const store = new MemoryStore(defaultMemoryDbPath(f.root));
  await store.put({ id: 'remote', content: 'Remote deployment record 00123' });
  await store.put({ id: 'local', content: 'Local deployment fallback guidance' }); store.close();
  selectMemory(f.root, 'remote', 'share'); const release = await seed(f);
  f.open('unplugged', 'sample');
  const id = `ov:${release.head.release_id}:${Buffer.from('remote').toString('base64url')}`;
  assert.equal(f.evolve('kb', 'get', id, '--kind', 'episodic', '--workflow-session', 'unplugged').content, 'Remote deployment record 00123');
  f.evolve('openviking', 'config', '--enabled', 'false'); await server.update({ unavailable: true });
  const before = (await server.inspect()).calls.length;
  assert.equal(f.evolve('kb', 'get', id, '--kind', 'episodic', '--workflow-session', 'unplugged').content, 'Remote deployment record 00123');
  assert.equal(f.evolve('search', 'deployment', '--mode', 'context', '--session', 'unplugged').constraints[0].content.trim(), 'Pinned deployment rule');
  const fallback = f.evolve('kb', 'search', 'deployment', '--kind', 'episodic', '--workflow-session', 'unplugged');
  assert.equal(fallback.knowledge_backend.active, 'local'); assert.match(fallback.knowledge_backend.fallback_reason, /DISABLED/);
  assert.ok(fallback.results.some(item => item.id === 'local'));
  assert.equal((await server.inspect()).calls.length, before);
});

test('frozen readers retain composite IDs and original versions after a newer remote knowledge release', async t => {
  const server = await protocol(t); const f = projectFixture(t, server);
  const local = new MemoryStore(defaultMemoryDbPath(f.root)); f.dispose(() => local.close());
  await local.put({ id: 'versioned', content: 'Original deployment version 00123' });
  const record = await local.put({ id: 'versioned', content: 'Approved deployment version 00123', sourceMessageIds: ['source:reviewed-message-00123'] });
  selectMemory(f.root, 'versioned', 'share'); const first = await seed(f);
  const cache = await cacheRelease(f.root, f.client, f.project, first.head.release_id, first.manifest);
  const snapshot = await freezeKnowledge(join(f.root, '.agent-memory/metadata-frozen'), cache, f.client, f.project, first.manifest);
  await local.put({ id: 'versioned', content: 'Later deployment version 00456' }); selectMemory(f.root, 'versioned', 'share');
  const second = releaseFromProject(f, first.head.release_id);
  await publishRelease(f.client, f.project, second.manifest, second.bytes, (await readProjectHead(f.client, f.project)).raw);
  f.env.EVOLVE_KNOWLEDGE_SNAPSHOT = snapshot.path; f.env.AGENT_MEMORY_DB = join(snapshot.path, 'memory.db');
  const id = `ov:${first.head.release_id}:${Buffer.from('versioned').toString('base64url')}`;
  const loaded = f.evolve('kb', 'get', id, '--kind', 'episodic');
  assert.equal(loaded.content, record.content);
  assert.equal(loaded.version, record.version);
  assert.deepEqual(loaded.sources, record.sourceMessageIds);
  assert.equal(f.evolve('kb', 'search', '00123', '--kind', 'episodic').results[0].id, id);
  assert.equal(frozenKnowledgeHash(snapshot.path), snapshot.hash);
});
