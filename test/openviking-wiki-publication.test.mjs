import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { protocol, projectFixture, releaseFromProject, seed, completeSample } from './openviking-support.mjs';
import { loadRelease, publishRelease, readProjectHead } from '../dist/openviking/assets.js';
import { selectMemory } from '../dist/openviking/knowledge.js';
import { Wiki } from '../dist/wiki.js';
import { applyWikiChange, proposeWikiChange } from '../dist/wiki-change.js';
import { MemoryStore, defaultMemoryDbPath } from '../dist/memory.js';
import { harvestCompletion } from '../dist/closeout.js';

// 与既有 OpenViking fixture 相同的本地审批入口：先提案，再应用。
function approve(wiki, entry, body, metadata = {}) {
  const change = proposeWikiChange(wiki, {
    operation: 'create', entry, title: entry, mode: 'constraint', scope: ['project'], body, ...metadata,
  }, ['fixture:human-approval']);
  applyWikiChange(wiki, change.id);
  return change;
}

const isWrite = call => call.path === '/api/v1/content/batch-write' || call.path === '/api/v1/fs/mkdir';
const isModel = call => call.path === '/chat/completions';
const remoteHead = async f => (await readProjectHead(f.client, f.project)).head.release_id;
const localCalls = async server => (await server.inspect()).calls;

// 断言 CLI 在本地正式 Wiki 应用后返回真实的、离线同步提示。
function assertSyncHint(result, entries, root) {
  const sync = result.openviking_sync;
  assert.ok(sync, '成功应用正式 Wiki 后应返回 openviking_sync');
  assert.equal(sync.state, 'unchecked');
  assert.equal(sync.configured, true);
  assert.equal(sync.requires_confirmation, true);
  assert.deepEqual(sync.entries, entries);
  assert.ok(sync.change_ids.every(id => /^[a-f0-9]{64}$/.test(id)));
  assert.deepEqual([...sync.change_ids].sort(), sync.change_ids, 'change_ids 必须排序');
  assert.deepEqual(sync.preview.slice(0, 4), ['evolve', 'openviking', 'knowledge', 'preview']);
  assert.equal(sync.preview.at(-2), '--root');
  assert.equal(sync.preview.at(-1), resolve(root), 'preview 必须绑定当前项目根');
  assert.match(sync.note, /not remote synced/i);
  assert.match(sync.note, /not checked/i);
  return sync;
}

test('无 Session 的 preview/publish 只更新选定 Wiki 并保留远端 Skills、Memory 与未选条目', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { minimalSkills: true });
  const wiki = new Wiki(f.root);
  approve(wiki, 'entries/base-rule', 'Baseline deployment rule.');
  const store = new MemoryStore(defaultMemoryDbPath(f.root));
  await store.put({ id: 'base-note', content: 'Remote deployment note 00123' });
  store.close();
  selectMemory(f.root, 'base-note', 'share');
  const base = await seed(f);
  const baseManifest = await loadRelease(f.client, f.project, base.head.release_id);
  const head = await remoteHead(f);
  const callsBefore = (await localCalls(server)).length;

  // 本地正式写入与未验证 Skill/待共享 Memory 不应成为独立发布的一部分。
  const added = f.evolve('kb', 'add', 'Independent reference guidance', '--kind', 'reference',
    '--evidence', 'fixture:human-approval', '--apply');
  const unselected = f.evolve('kb', 'add', 'Unselected reference guidance', '--kind', 'reference',
    '--evidence', 'fixture:human-approval', '--apply');
  f.write('skills/sample/local-only.txt', 'Local unverified Skill change.\n');
  f.git('add', '--', 'skills/sample/local-only.txt'); f.git('commit', '-qm', '测试: 本地未验证 Skill');
  const local = new MemoryStore(defaultMemoryDbPath(f.root));
  await local.put({ id: 'local-note', content: 'Pending local share 00999' });
  local.close();
  selectMemory(f.root, 'local-note', 'share');
  const gitHead = f.git('rev-parse', 'HEAD');

  // 首次发布完全不需要 Session。
  const preview = f.evolve('openviking', 'knowledge', 'preview', added.entry);
  assert.equal(preview.state, 'preview');
  assert.equal(preview.base_release, head);
  assert.equal(preview.remote_checked, true);
  assert.match(preview.approval, /^[a-f0-9]{64}$/);
  const selected = preview.wiki.find(item => item.entry === added.entry);
  assert.ok(selected, 'preview 必须列出选定条目');
  assert.equal(selected.change_id, added.id);
  assert.equal(selected.before, null);
  assert.ok(selected.after.includes('Independent reference guidance'));
  assert.deepEqual(preview.next_action.argv, [
    'evolve', 'openviking', 'knowledge', 'publish', '--root', f.root, '--approval', preview.approval,
  ]);
  // preview 只读远端：新增调用中不能出现 batch-write 或 mkdir。
  const previewCalls = (await localCalls(server)).slice(callsBefore);
  assert.ok(previewCalls.length > 0, 'preview 应实际检查远端');
  assert.equal(previewCalls.filter(isWrite).length, 0);

  const callsBeforePublish = (await localCalls(server)).length;
  const published = f.evolve('openviking', 'knowledge', 'publish', '--approval', preview.approval);
  assert.equal(published.state, 'published');
  assert.match(published.release_id, /^[a-f0-9]{64}$/);
  assert.equal(published.replayed, false);
  assert.equal(published.current_head.release_id, published.release_id);
  const release = await loadRelease(f.client, f.project, published.release_id);
  assert.equal(await remoteHead(f), published.release_id);
  assert.equal(f.git('rev-parse', 'HEAD'), gitHead, '独立发布不得创建 Git 提交');

  assert.equal(release.verification.kind, 'knowledge');
  assert.equal(release.verification.session_id, null);
  assert.equal(release.verification.approval, preview.approval);
  assert.deepEqual(release.verification.replay_ids, []);
  assert.equal(release.source_commit, baseManifest.source_commit);
  const skills = manifest => manifest.files.filter(file => !file.path.startsWith('wiki/') && !file.path.startsWith('memory/'));
  assert.deepEqual(skills(release), skills(baseManifest), '必须保留远端 Skills，不能携带本地新 Skill');
  assert.deepEqual(release.memory, baseManifest.memory, '必须保留远端 Memory，不能携带待共享 Memory');
  assert.equal(release.files.some(file => file.path === 'skills/sample/local-only.txt'), false);
  assert.deepEqual(release.memory.map(item => item.origin_id), baseManifest.memory.map(item => item.origin_id));
  const entries = release.wiki.map(item => item.entry);
  assert.ok(entries.includes('entries/base-rule'), '必须保留远端未选 Wiki');
  assert.ok(entries.includes(added.entry), '必须包含选定 Wiki');
  assert.equal(entries.includes(unselected.entry), false, '不得上传未选 Wiki');
  const publishCalls = (await localCalls(server)).slice(callsBeforePublish);
  assert.equal(publishCalls.filter(isModel).length, 0, '独立发布不得调用模型');

  // 已同步条目再预览为 no_change，且不产生任何远端写。
  const noChangeCalls = (await localCalls(server)).length;
  const noChange = f.evolve('openviking', 'knowledge', 'preview', added.entry);
  assert.equal(noChange.state, 'no_change');
  assert.deepEqual(noChange.wiki, []);
  assert.equal(noChange.approval, undefined);
  assert.equal(noChange.base_release, published.release_id);
  assert.equal((await localCalls(server)).slice(noChangeCalls).filter(isWrite).length, 0);
  assert.equal(await remoteHead(f), published.release_id);
});

test('未审批选择、错误审批与本地/远端漂移都被拒绝且不覆盖远端', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { minimalSkills: true });
  await seed(f);

  // 迁移得到但未审批的条目：显式选择必须拒绝。
  f.write('.workflow/knowhow/legacy.md', '---\ntitle: Legacy deployment notes\n---\n\nKeep this note local.\n');
  const imported = f.evolve('kb', 'import', '--project', 'legacy-project', '--apply');
  const migrated = imported.entries.find(entry => !entry.existing);
  assert.ok(migrated);
  const migratedEntry = `entries/${migrated.id}`;
  assert.throws(() => f.evolve('openviking', 'knowledge', 'preview', migratedEntry), /UNAPPROVED/);

  // 已审批后手工改字节：不再匹配 applied 记录，同样拒绝预览。
  const reviewed = f.evolve('kb', 'add', 'Preflight approval rule', '--kind', 'constraint',
    '--evidence', 'fixture:human-approval', '--apply');
  const path = join(f.root, 'wiki', reviewed.entry + '.md');
  writeFileSync(path, readFileSync(path, 'utf8') + '\nUnreviewed manual edit.\n');
  assert.throws(() => f.evolve('openviking', 'knowledge', 'preview', reviewed.entry), /UNAPPROVED/);

  // 错误或缺失 approval 均拒绝，且不写远端。
  const head = await remoteHead(f);
  const calls = (await localCalls(server)).length;
  assert.throws(() => f.evolve('openviking', 'knowledge', 'publish', '--approval', '0'.repeat(64)), /PREVIEW_REQUIRED/);
  assert.throws(() => f.evolve('openviking', 'knowledge', 'publish'), /approval/i);
  const failed = (await localCalls(server)).slice(calls);
  assert.equal(failed.filter(isWrite).length, 0);
  assert.equal(await remoteHead(f), head);

  // 本地应用新审批后，旧预览必须因正文/审批漂移而失效。
  const drift = f.evolve('kb', 'add', 'Preflight drift rule v1', '--kind', 'constraint',
    '--evidence', 'fixture:human-approval', '--apply');
  const stale = f.evolve('openviking', 'knowledge', 'preview', drift.entry);
  assert.equal(stale.state, 'preview');
  const next = f.evolve('kb', 'update', drift.entry, 'Preflight drift rule v2', '--evidence', 'fixture:approved-again');
  assert.equal(next.openviking_sync, undefined, '未审批提案不得提示上传');
  f.evolve('kb', 'apply', next.id);
  assert.throws(() => f.evolve('openviking', 'knowledge', 'publish', '--approval', stale.approval), /LOCAL_CHANGED/);
  assert.equal(await remoteHead(f), head);

  // 另一台机器推进远端基线后，旧预览拒绝且远端保持新版本。
  const remote = f.evolve('kb', 'add', 'Remote concurrent rule', '--kind', 'constraint',
    '--evidence', 'fixture:human-approval', '--apply');
  const preview = f.evolve('openviking', 'knowledge', 'preview', remote.entry);
  // 审批同时固定服务目的地和项目身份，不能拿旧批准上传到新目标。
  const configPath = join(f.root, '.agent-memory', 'ovcli.conf');
  const originalConfig = readFileSync(configPath, 'utf8');
  writeFileSync(configPath, JSON.stringify({ ...JSON.parse(originalConfig), url: server.url + '/different-service' }));
  assert.throws(() => f.evolve('openviking', 'knowledge', 'publish', '--approval', preview.approval), /PREVIEW_STALE/);
  writeFileSync(configPath, originalConfig);
  const profilePath = join(f.root, '.evolve', 'openviking.json');
  const originalProfile = readFileSync(profilePath, 'utf8');
  writeFileSync(profilePath, JSON.stringify({ ...JSON.parse(originalProfile), account_id: 'different-account' }));
  assert.throws(() => f.evolve('openviking', 'knowledge', 'publish', '--approval', preview.approval), /PREVIEW_STALE/);
  writeFileSync(profilePath, originalProfile);
  const previous = await readProjectHead(f.client, f.project);
  const advanced = releaseFromProject(f, previous.head.release_id);
  await publishRelease(f.client, f.project, advanced.manifest, advanced.bytes, previous.raw);
  const advancedHead = await remoteHead(f);
  assert.notEqual(advancedHead, previous.head.release_id);
  assert.throws(() => f.evolve('openviking', 'knowledge', 'publish', '--approval', preview.approval),
    /PREVIEW_STALE|PUBLICATION_CONFLICT/);
  assert.equal(await remoteHead(f), advancedHead, '冲突失败不得覆盖远端版本');
});

test('发布批准可重放、确认文件丢失可恢复且指针响应丢失安全收敛', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { minimalSkills: true });
  await seed(f);
  const first = f.evolve('kb', 'add', 'Idempotent publication rule', '--kind', 'constraint',
    '--evidence', 'fixture:human-approval', '--apply');
  const preview = f.evolve('openviking', 'knowledge', 'preview', first.entry);
  const published = f.evolve('openviking', 'knowledge', 'publish', '--approval', preview.approval);
  assert.equal(published.state, 'published');
  const confirmation = join(f.root, '.agent-memory', 'openviking', 'published-wiki.json');
  assert.ok(existsSync(confirmation));

  // 相同 approval 重复发布：同一 release，replayed true。
  const replay = f.evolve('openviking', 'knowledge', 'publish', '--approval', preview.approval);
  assert.equal(replay.state, 'published');
  assert.equal(replay.release_id, published.release_id);
  assert.equal(replay.replayed, true);
  assert.equal(await remoteHead(f), published.release_id);

  // 删除本地知识确认后重试：应由远端核实恢复同一版本并重建确认。
  rmSync(confirmation, { force: true });
  const restored = f.evolve('openviking', 'knowledge', 'publish', '--approval', preview.approval);
  assert.equal(restored.state, 'published');
  assert.equal(restored.release_id, published.release_id);
  assert.equal(restored.replayed, true);
  assert.ok(existsSync(confirmation));

  // 指针响应丢失：服务已写指针但客户端未知，publishRelease 读回后仍成功。
  const second = f.evolve('kb', 'add', 'Lost pointer recovery rule', '--kind', 'reference',
    '--evidence', 'fixture:human-approval', '--apply');
  const secondPreview = f.evolve('openviking', 'knowledge', 'preview', second.entry);
  await server.update({ dropPointer: true });
  const recovered = f.evolve('openviking', 'knowledge', 'publish', '--approval', secondPreview.approval);
  assert.equal(recovered.state, 'published');
  assert.match(recovered.release_id, /^[a-f0-9]{64}$/);
  assert.equal(recovered.current_head.release_id, recovered.release_id);
  assert.equal(await remoteHead(f), recovered.release_id);
});

test('完成 Session 后新增 Wiki 独立发布且不改变已固定 Session', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { minimalSkills: true });
  f.write('evolution.json', JSON.stringify({ schema_version: 'evolve-openviking-policy/1.0', targets: [] }));
  f.git('add', 'evolution.json'); f.git('commit', '-qm', '测试: 固定仅同步策略');
  await seed(f);
  f.open('post-closeout', 'sample');
  completeSample(f, 'post-closeout');
  f.sealSession('post-closeout');
  const before = f.status('post-closeout');
  assert.equal(before.status, 'completed');
  assert.equal(typeof before.openviking.release_id, 'string');
  const pinned = before.openviking.release_id;

  const added = f.evolve('kb', 'add', 'Wiki approved after Session closeout', '--kind', 'constraint',
    '--evidence', 'fixture:human-approval', '--apply');
  const preview = f.evolve('openviking', 'knowledge', 'preview', added.entry);
  assert.equal(preview.state, 'preview');
  assert.equal(preview.base_release, await remoteHead(f));
  const published = f.evolve('openviking', 'knowledge', 'publish', '--approval', preview.approval);
  assert.equal(published.state, 'published');
  assert.equal((await loadRelease(f.client, f.project, published.release_id)).verification.kind, 'knowledge');

  const after = f.status('post-closeout');
  assert.equal(after.openviking.release_id, pinned);
  assert.deepEqual(after.openviking, before.openviking);
  assert.equal(after.revision, before.revision);
  assert.equal(await remoteHead(f), published.release_id);
});

test('本地正式 Wiki 写入返回离线同步提示且不增加任何服务调用', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { minimalSkills: true });
  await seed(f);
  const callsBefore = (await localCalls(server)).length;
  const pending = f.evolve('kb', 'add', 'Pending governed rule', '--kind', 'constraint', '--evidence', 'fixture:pending');
  assert.equal(pending.openviking_sync, undefined, '未审批提案不提示');
  const applied = f.evolve('kb', 'add', 'Offline hint reference', '--kind', 'reference',
    '--evidence', 'fixture:human-approval', '--apply');
  const sync = assertSyncHint(applied, [applied.entry], f.root);
  assert.deepEqual(sync.change_ids, [applied.id]);
  assert.equal(sync.preview[4], applied.entry);

  const appliedLater = f.evolve('kb', 'apply', pending.id);
  const later = assertSyncHint(appliedLater, [pending.entry], f.root);
  assert.deepEqual(later.change_ids, [pending.id]);

  // candidates publish 路径也要提示；重放只标记 replayed。
  const fakeModel = () => ({ chat: async () => JSON.stringify([{ memories: [{
    type: 'work_method', content: 'Backup checksum verification note 00123.', source_message_ids: ['check'],
  }] }]) });
  const harvested = await harvestCompletion(new Wiki(f.root), f.project.project_id, {
    schema_version: 'skill-completion/1.0', id: 'completion-1', execution_id: 'execution-1', status: 'succeeded',
    recorded_at: '2026-11-19T00:00:00Z',
    messages: [{ id: 'check', role: 'tool', timestamp: '2026-11-19T00:00:00Z', content: 'Checksums verified.' }],
  }, fakeModel);
  assert.equal(harvested.candidates.length, 1);
  const candidate = harvested.candidates[0];
  const publishArgs = ['kb', 'candidates', 'publish', harvested.id, candidate.id, 'Backup checksum note',
    '--entry', 'entries/backup-checksum-note'];
  const published = f.evolve(...publishArgs);
  const publishedSync = assertSyncHint(published, ['entries/backup-checksum-note'], f.root);
  const changes = f.evolve('kb', 'changes', '--entry', published.id);
  assert.deepEqual(publishedSync.change_ids, changes.filter(change => change.state === 'applied').map(change => change.id).sort());
  const replayed = f.evolve(...publishArgs);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.openviking_sync.replayed, true);
  assert.equal(replayed.openviking_sync.state, 'unchecked');
  assert.deepEqual(replayed.openviking_sync.entries, ['entries/backup-checksum-note']);

  assert.equal((await localCalls(server)).length, callsBefore, '本地写入与提示生成不得触网');
});

test('未配置、禁用与隔离 scope 的本地写入不提供上传下一步', async t => {
  const server = await protocol(t);
  const unconfigured = projectFixture(t, server, { profile: false, minimalSkills: true });
  const callsBefore = (await localCalls(server)).length;
  const localOnly = unconfigured.evolve('kb', 'add', 'Local only reference', '--kind', 'reference',
    '--evidence', 'fixture:local-only', '--apply');
  assert.equal(localOnly.openviking_sync.state, 'local_only');
  assert.equal(localOnly.openviking_sync.configured, false);
  assert.equal(localOnly.openviking_sync.preview, undefined);

  const f = projectFixture(t, server, { minimalSkills: true });
  await seed(f);
  const configuredCalls = (await localCalls(server)).length;
  const pending = f.evolve('kb', 'add', 'Pending isolated rule', '--kind', 'constraint', '--evidence', 'fixture:pending');
  assert.equal(pending.openviking_sync, undefined);
  const episodic = f.evolve('kb', 'add', 'Episodic observation only', '--kind', 'episodic');
  assert.equal(episodic.openviking_sync, undefined);
  const global = f.evolve('kb', 'add', 'Global isolated reference', '--kind', 'reference',
    '--scope', 'global', '--evidence', 'fixture:global', '--apply');
  assert.equal(global.openviking_sync, undefined, '隔离 scope 不得提示上传项目 Wiki');
  const isolated = f.evolve('kb', 'add', 'Isolated Wiki reference', '--kind', 'reference',
    '--wiki-root', join(f.root, 'isolated-wiki'), '--evidence', 'fixture:isolated', '--apply');
  assert.equal(isolated.openviking_sync, undefined, '隔离 Wiki 目录不属于项目上传范围');

  f.evolve('openviking', 'config', '--enabled', 'false');
  const disabled = f.evolve('kb', 'add', 'Disabled reference note', '--kind', 'reference',
    '--evidence', 'fixture:disabled', '--apply');
  assert.equal(disabled.openviking_sync.state, 'disabled');
  assert.equal(disabled.openviking_sync.configured, true);
  assert.equal(disabled.openviking_sync.preview, undefined);

  assert.equal((await localCalls(server)).length, configuredCalls, '本地写入不得触网');
});

test('已发布 Wiki 的连续审批与退役保留可追溯版本且不覆盖分叉', async t => {
  const server = await protocol(t);
  const f = projectFixture(t, server, { minimalSkills: true });
  const original = approve(new Wiki(f.root), 'entries/revisions', 'Original approved deployment rule.');
  const fork = approve(new Wiki(f.root), 'entries/fork', 'Original approved branching rule.');
  await seed(f);
  f.evolve('kb', 'update', original.entry, 'Intermediate approved deployment rule.', '--apply', '--evidence', 'fixture:intermediate');
  const latest = f.evolve('kb', 'update', original.entry, 'Final approved deployment rule.', '--apply', '--evidence', 'fixture:final');
  const preview = f.evolve('openviking', 'knowledge', 'preview', original.entry);
  assert.equal(preview.wiki[0].before, original.after);
  assert.equal(preview.wiki[0].after, latest.after);
  const published = f.evolve('openviking', 'knowledge', 'publish', '--approval', preview.approval);
  const release = await loadRelease(f.client, f.project, published.release_id);
  assert.equal(release.wiki.find(item => item.entry === original.entry).approval.id, latest.id);
  const retired = f.evolve('kb', 'delete', original.entry, '--kind', 'constraint', '--apply', '--evidence', 'fixture:retired');
  const retirePreview = f.evolve('openviking', 'knowledge', 'preview', original.entry);
  assert.equal(retirePreview.wiki[0].after, retired.after);
  const retireResult = f.evolve('openviking', 'knowledge', 'publish', '--approval', retirePreview.approval);
  const retiredRelease = await loadRelease(f.client, f.project, retireResult.release_id);
  assert.equal(retiredRelease.wiki.find(item => item.entry === original.entry).approval.id, retired.id);
  assert.match(retired.after, /status: deprecated/);
  const local = f.evolve('kb', 'update', fork.entry, 'Locally approved divergent rule.', '--apply', '--evidence', 'fixture:local');
  // 远端分叉通过真实治理审批构造后发布；本地另行保留自己的批准版本。
  const localPath = join(f.root, 'wiki', fork.entry + '.md');
  writeFileSync(localPath, fork.after);
  const remoteChange = proposeWikiChange(new Wiki(f.root), { operation: 'update', entry: fork.entry, body: 'Foreign approved deployment rule.' }, ['fixture:foreign']);
  applyWikiChange(new Wiki(f.root), remoteChange.id);
  const remotePreview = f.evolve('openviking', 'knowledge', 'preview', fork.entry);
  f.evolve('openviking', 'knowledge', 'publish', '--approval', remotePreview.approval);
  writeFileSync(localPath, local.after);
  assert.throws(() => f.evolve('openviking', 'knowledge', 'preview', fork.entry), /PUBLICATION_CONFLICT/);
});
