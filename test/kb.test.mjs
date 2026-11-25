import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { KnowledgeStore } from '../dist/kb.js';
import { KnowledgeReads } from '../dist/knowledge-reads.js';
import { MemoryStore } from '../dist/memory.js';
import { Wiki } from '../dist/wiki.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'evolve-kb-'));
  const project = join(root, 'project');
  const global = join(root, 'global');
  await mkdir(project);
  await mkdir(global);
  const memory = new MemoryStore(join(project, '.evolve', 'memory.db'));
  const globalMemory = new MemoryStore(join(global, '.evolve', 'memory.db'));
  const wiki = new Wiki(project);
  const globalWiki = new Wiki(global);
  const kb = new KnowledgeStore([
    { scope: 'project', wiki, memory },
    { scope: 'global', wiki: globalWiki, memory: globalMemory },
  ]);
  t.after(async () => { memory.close(); globalMemory.close(); await rm(root, { recursive: true, force: true }); });
  return { root, project, global, kb, memory, globalMemory, wiki, globalWiki };
}

test('kb unifies three kinds and preserves episodic metadata during update', async t => {
  const { kb, memory } = await fixture(t);
  const original = await kb.add({
    id: 'lesson', content: 'Calibration needs a dry run.', type: 'verified_fix',
    scene: 'execute', session: 'session-1', priority: 72, sources: ['message-1'],
  });
  assert.equal(original.kind, 'episodic');
  assert.equal(original.authority, 'unverified_episodic');
  const updated = await kb.update('lesson', { content: 'Calibration requires a verified dry run.' });
  assert.equal(updated.type, 'verified_fix');
  assert.equal(updated.scene, 'execute');
  assert.equal(updated.session, 'session-1');
  assert.equal(updated.priority, 72);
  assert.deepEqual(updated.sources, ['message-1']);
  assert.equal(updated.createdAt, original.createdAt);
  assert.equal(updated.version, 2);
  await assert.rejects(kb.add({ id: 'lesson', content: 'duplicate' }), /already exists/);

  const reference = await kb.add({
    id: 'calibration', kind: 'reference', title: 'Calibration guide',
    content: 'Read the calibration guide.', scope: ['task:execute'], categories: ['arch'],
  }, { evidence: ['test:guide'], apply: true });
  assert.equal(reference.state, 'applied');
  assert.equal(kb.get('entries/calibration').kind, 'reference');
  assert.equal(kb.get('entries/calibration', { resolved: true }), undefined);
  assert.equal(kb.get('entries/calibration', { resolved: true, task: 'execute' }).title, 'Calibration guide');

  const promoted = await kb.update('entries/calibration', {
    kind: 'constraint', title: 'Calibration required',
  }, { evidence: ['test:review'], apply: true });
  assert.equal(promoted.operation, 'promote');
  assert.equal(kb.get('entries/calibration').kind, 'constraint');
  assert.equal(kb.get('entries/calibration').authority, 'binding');
  await assert.rejects(kb.update('entries/calibration', { kind: 'reference' }), /cannot be downgraded/);

  const retired = await kb.delete('entries/calibration', { evidence: ['test:retire'], apply: true });
  assert.equal(retired.state, 'applied');
  assert.equal(kb.get('entries/calibration').status, 'deprecated');
  assert.equal((await kb.list()).results.some(record => record.id === 'entries/calibration'), false);
  assert.equal((await kb.list({ status: 'deprecated' })).results[0].kind, 'constraint');
  assert.deepEqual(await kb.delete('lesson'), { deleted: true });
  assert.equal(memory.get('lesson'), undefined);
});

test('kb formal mutations stage governed changes and require evidence', async t => {
  const { kb } = await fixture(t);
  await assert.rejects(kb.add({ kind: 'reference', id: 'without-evidence', content: 'Missing evidence.' }), /evidence/);
  const staged = await kb.add({
    kind: 'reference', id: 'staged', content: 'Review before publication.',
  }, { evidence: ['test:stage'] });
  assert.equal(staged.state, 'pending');
  assert.equal(kb.get('entries/staged'), undefined);
  await assert.rejects(kb.add({
    kind: 'constraint', id: 'bad-scope', content: 'Invalid scope.', scope: ['skill:execute'],
  }, { evidence: ['test:invalid'] }), /Use project, task/);
  await assert.rejects(kb.add({
    kind: 'episodic', content: 'Cannot silently store unsupported categories.', categories: ['arch'],
  }), /do not support/);
});

test('kb filtering, stable pages and scoped precedence do not conflate kinds', async t => {
  const { kb, globalMemory } = await fixture(t);
  await kb.add({ id: 'same', content: 'Calibration project lesson.', scene: 'execute', session: 's1' });
  await globalMemory.put({ id: 'same', content: 'Calibration global lesson.', scene: 'execute', session: 's1' });
  await kb.add({ id: 'other', content: 'Calibration review lesson.', scene: 'review', session: 's2' });
  await kb.add({
    kind: 'reference', id: 'entries/same', content: 'Calibration architecture notes.',
    scope: ['path:src/**'], categories: ['arch'],
  }, { evidence: ['test:scope'], apply: true });
  await kb.add({
    id: 'entries/same', content: 'Calibration memory shares the raw wiki ID.', scene: 'execute',
  });
  assert.equal(kb.get('same').scope, 'project');
  assert.equal(kb.get('same', { scope: 'global' }).content, 'Calibration global lesson.');
  assert.throws(() => kb.get('entries/same'), /ambiguous/);
  assert.equal(kb.get('entries/same', { kind: 'reference' }).storageKind, 'wiki');
  assert.equal(kb.get('entries/same', { kind: 'episodic' }).storageKind, 'memory');
  assert.deepEqual((await kb.list({ task: 'execute', session: 's1' })).results.map(record => record.id), ['same']);
  assert.deepEqual((await kb.search('Calibration', { paths: ['src/a.ts'], categories: ['arch'] })).results.map(record => record.kind), ['reference']);
  assert.deepEqual((await kb.search('Calibration', { paths: ['docs/a.md'], categories: ['arch'] })).results, []);
  assert.deepEqual((await kb.search('Calibration', { type: 'absent' })).results, []);
  const pages = await Promise.all([1, 2, 3].map(page => kb.list({ limit: 2, page })));
  const ids = pages.flatMap(page => page.results.map(record => record.kind + ':' + record.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 4);
  assert.equal(pages[0].pagination.nextPage, 2);
  assert.equal(pages.at(-1).pagination.nextPage, null);
  await assert.rejects(kb.list({ page: 0 }), /page must be/);
  await assert.rejects(kb.list({ categories: ['unknown'] }), /Unknown knowledge category/);
  await assert.rejects(kb.list({ task: 'execute', scene: 'review' }), /must agree/);
});

test('kb search filters complete wiki candidates before pagination and preserves hop search', async t => {
  const { kb, project, wiki } = await fixture(t);
  const folder = join(project, 'wiki', 'entries');
  await mkdir(folder, { recursive: true });
  const page = (id, body, categories = ['coding']) => [
    '---', 'title: Calibration ' + id, 'mode: reference', 'status: active',
    'scope: [project]', 'sources: [test:candidates]', 'categories: ' + JSON.stringify(categories), '---', body,
  ].join('\n');
  for (let index = 0; index < 105; index++) {
    const id = String(index).padStart(3, '0');
    await writeFile(join(folder, id + '.md'), page(id,
      index === 104 ? 'Calibration needle with architecture context.' : 'Calibration needle.',
      index === 104 ? ['arch'] : ['coding']));
  }
  await writeFile(join(folder, 'linked.md'), page('linked', 'Only a remote linked target.'));
  await writeFile(join(folder, 'seed.md'), page('seed', 'Uniquehop [[entries/linked]]'));
  const result = await kb.search('Calibration needle', { categories: ['arch'] });
  assert.deepEqual(result.results.map(record => record.id), ['entries/104']);
  const first = await kb.search('Calibration needle', { limit: 100, page: 1 });
  const second = await kb.search('Calibration needle', { limit: 100, page: 2 });
  assert.equal(first.results.length, 100);
  assert.equal(second.results.length, 7);
  assert.equal(new Set([...first.results, ...second.results].map(record => record.id)).size, 107);
  assert.equal(wiki.search('Calibration', { limit: 10 }).results.length, 10);
  const linked = await kb.search('Uniquehop', { hop: 1 });
  assert.ok(linked.results.some(record => record.id === 'entries/linked' && record.hop === 1));
});

test('kb context binds all applicable constraints and records per-layer search provenance', async t => {
  const { kb, globalMemory } = await fixture(t);
  await kb.add({
    kind: 'constraint', id: 'required', content: 'Always perform a dry run.',
    scope: ['task:execute'], categories: ['arch'],
  }, { evidence: ['test:required'], apply: true });
  await kb.add({ id: 'local', content: 'Calibration migration.' });
  await globalMemory.put({ id: 'remote', content: 'Calibration global note.' });
  const reads = new KnowledgeReads();
  const hits = await kb.search('Calibration', { knowledgeReads: reads });
  const receipt = reads.toJSON();
  const remoteSearch = receipt.searches.find(search => search.source === 'memory' &&
    search.filters.scope === 'global');
  assert.ok(remoteSearch.returned_ids.includes('remote'));
  assert.ok(!remoteSearch.returned_ids.includes('local'));
  kb.get('remote', { scope: 'global', knowledgeReads: reads, fromSearchId: remoteSearch.search_id });
  assert.equal(reads.toJSON().reads[0].kind, 'memory');
  const constraints = kb.constraints({ task: 'execute', categories: ['arch'], limit: 1, knowledgeReads: reads });
  assert.equal(constraints.length, 1);
  assert.equal(constraints[0].id, 'entries/required');
  assert.equal(reads.toJSON().constraints_bound[0].knowledge_id, 'entries/required');
  assert.deepEqual(kb.constraints({ task: 'review' }), []);
  assert.ok(hits.results.every(record => record.source === 'kb'));
});

test('kb project/global copies do not earn duplicate fusion credit', async t => {
  const { kb, globalMemory } = await fixture(t);
  await kb.add({ id: 'a', content: 'Calibration needle.' });
  await kb.add({ id: 'b', content: 'Calibration needle.' });
  const before = await kb.search('Calibration needle');
  await globalMemory.put({ id: 'b', content: 'Calibration needle.' });
  const after = await kb.search('Calibration needle');
  assert.deepEqual(after.results.map(({ id, score }) => ({ id, score })),
    before.results.map(({ id, score }) => ({ id, score })));
});

test('MemoryStore.update preserves original extraction evidence when only metadata changes', async t => {
  const { memory } = await fixture(t);
  const [record] = await memory.extract([
    { id: 'message-1', role: 'user', timestamp: 1, content: 'The machine ID is 04312.', location: { path: '/fixture/chat', byteOffset: 5 } },
  ], {
    session: 'sourced', llm: { chat: async () => JSON.stringify([{ memories: [{
      content: 'The machine ID is 04312.', type: 'work_fact', source_message_ids: ['message-1'],
    }] }]) },
  });
  const before = memory.sources(record.id);
  await memory.update(record.id, { priority: 91 });
  assert.deepEqual(memory.sources(record.id), before);
  assert.deepEqual(memory.get(record.id).sourceMessageIds, ['message-1']);
  assert.ok((await memory.search('04312')).results.some(hit => hit.id === record.id));
});

test('kb delete respects formal kinds and episodic sources updates preserve omitted values', async t => {
  const { kb } = await fixture(t);
  await kb.add({ id: 'rule', kind: 'constraint', content: 'Validate calibration.' }, {
    evidence: ['test:rule'], apply: true,
  });
  assert.deepEqual(await kb.delete('entries/rule', {
    kind: 'reference', evidence: ['test:wrong-kind'], apply: true,
  }), { deleted: false });
  assert.equal(kb.get('entries/rule').status, 'active');
  assert.equal((await kb.delete('entries/rule', {
    kind: 'constraint', evidence: ['test:retire'], apply: true,
  })).state, 'applied');

  await kb.add({ id: 'source', content: 'Original content.', sources: ['message-1'] });
  assert.deepEqual((await kb.update('source', { sources: ['message-2'] })).sources, ['message-2']);
  assert.deepEqual((await kb.update('source', { priority: 82 })).sources, ['message-2']);
  assert.deepEqual((await kb.update('source', { sourceMessageIds: ['message-3'], sources: ['ignored'] })).sources, ['message-3']);
  assert.deepEqual((await kb.update('source', { sources: [] })).sources, []);
});

function embeddingGate(count = 2) {
  let entered = 0;
  let markReady;
  let release;
  const ready = new Promise(resolve => { markReady = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  return { ready, release, embed: async () => {
    if (++entered === count) markReady();
    await released;
    return [1, 0];
  } };
}

test('kb concurrent creates reject duplicate IDs across database connections', async t => {
  const { project, memory } = await fixture(t);
  const gate = embeddingGate();
  const stores = [1, 2].map(() => new MemoryStore(join(project, '.evolve', 'memory.db'), { embed: gate.embed }));
  try {
    const inputs = ['First content.', 'Second content.'];
    const calls = stores.map((store, index) => new KnowledgeStore([{ scope: 'project', memory: store }])
      .add({ id: 'race', content: inputs[index] }));
    await gate.ready;
    gate.release();
    const results = await Promise.allSettled(calls);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failed = results.find(result => result.status === 'rejected');
    assert.match(failed.reason.message, /already exists/);
    assert.equal(memory.get('race').content, inputs[results.findIndex(result => result.status === 'fulfilled')]);
    assert.equal(memory.get('race').version, 1);
  } finally {
    gate.release();
    stores.forEach(store => store.close());
  }
});

test('kb concurrent patches detect stale snapshots and permit a safe retry', async t => {
  const { project, kb, memory } = await fixture(t);
  await kb.add({ id: 'patch', content: 'Calibration record.', priority: 50, type: 'initial' });
  const gate = embeddingGate();
  const stores = [1, 2].map(() => new MemoryStore(join(project, '.evolve', 'memory.db'), { embed: gate.embed }));
  const patches = [{ priority: 90 }, { type: 'changed' }];
  try {
    const calls = stores.map((store, index) => store.update('patch', patches[index]));
    await gate.ready;
    gate.release();
    const results = await Promise.allSettled(calls);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const retry = results.findIndex(result => result.status === 'rejected');
    assert.match(results[retry].reason.message, /changed.*update|conflict/i);
    await stores[retry].update('patch', patches[retry]);
    assert.equal(memory.get('patch').priority, 90);
    assert.equal(memory.get('patch').type, 'changed');
    assert.equal(memory.get('patch').version, 3);
  } finally {
    gate.release();
    stores.forEach(store => store.close());
  }
});

test('pending memory updates do not resurrect deleted or replaced records', async t => {
  const { project, memory } = await fixture(t);
  for (const replacement of [false, true]) {
    const gate = embeddingGate(1);
    const other = new MemoryStore(join(project, '.evolve', 'memory.db'), { embed: gate.embed });
    try {
      await memory.put({ id: 'record', content: 'Original content.' });
      const pending = other.update('record', { priority: 90 });
      await gate.ready;
      memory.delete('record');
      if (replacement) await memory.put({ id: 'record', content: 'Replacement content.' });
      gate.release();
      if (replacement) {
        await assert.rejects(pending, /changed.*update|conflict/i);
        assert.equal(memory.get('record').content, 'Replacement content.');
        assert.equal(memory.get('record').priority, 50);
      } else {
        assert.equal(await pending, undefined);
        assert.equal(memory.get('record'), undefined);
      }
    } finally {
      gate.release();
      other.close();
    }
  }
});

test('memory content edits reindex exact values while retaining original provenance', async t => {
  const { memory } = await fixture(t);
  const [original] = await memory.extract([
    { id: 'message-1', role: 'user', timestamp: 1, content: 'The machine ID is 04312.', location: { path: '/fixture/chat', byteOffset: 5 } },
  ], { session: 'sourced', llm: { chat: async () => JSON.stringify([{ memories: [{
    content: 'The machine ID is 04312.', type: 'work_fact', source_message_ids: ['message-1'],
  }] }]) } });
  const sources = memory.sources(original.id);
  await memory.update(original.id, { content: 'The machine ID is 04313.' });
  assert.deepEqual(memory.get(original.id).exactValues, ['04313']);
  assert.deepEqual((await memory.search('04313')).results.map(record => record.id), [original.id]);
  assert.deepEqual((await memory.search('04312')).results, []);
  assert.deepEqual(memory.sources(original.id), sources);
  await memory.update(original.id, { priority: 92 });
  assert.deepEqual(memory.get(original.id).exactValues, ['04313']);
  await memory.update(original.id, { content: 'The machine has been renamed.' });
  await memory.update(original.id, { priority: 93 });
  assert.deepEqual((await memory.search('04312')).results, []);
  assert.deepEqual((await memory.search('04313')).results, []);
  assert.deepEqual(memory.sources(original.id), sources);
});

test('Memory exact search ranks by priority then recency and get resolves unique short hex prefixes', async t => {
  const { kb, memory } = await fixture(t);
  const lowId = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff66667777888899990001';
  const highId = 'bbbb1111bbbb2222cccc3333dddd4444eeee5555ffff66667777888899990002';
  await memory.put({ id: lowId, content: 'Server runs on port 9090.', priority: 40 });
  await memory.put({ id: highId, content: 'Server moved to port 9090.', priority: 90 });

  const exact = await memory.search('9090');
  assert.deepEqual(exact.results.map(item => item.id), [highId, lowId]);

  assert.equal(kb.get(highId.slice(0, 8))?.id, highId);
  assert.equal(kb.get(lowId.slice(0, 8))?.id, lowId);

  const collide1 = 'deadbeef0000111122223333444455556666777788889999aaaabbbbcccc0001';
  const collide2 = 'deadbeef0000111122223333444455556666777788889999aaaabbbbcccc0002';
  await memory.put({ id: collide1, content: 'First colliding record.' });
  await memory.put({ id: collide2, content: 'Second colliding record.' });
  assert.throws(() => kb.get('deadbeef'), /Ambiguous memory ID prefix/);
  assert.equal(kb.get(collide2)?.id, collide2);
});

test('kb.list and kb.search retain episodic memory when filtering Wiki by repository UUID', async t => {
  const { kb } = await fixture(t);
  const activeRepo = 'c7c015e1-7254-4156-b716-27931b51cc01';
  const otherRepo = 'd8d126f2-8365-4267-8827-38042c62dd02';
  await kb.add({ id: 'mem-rotor', content: 'Calibration rotor tooth parameter contract.' });
  await kb.add({
    id: 'wiki-current', kind: 'reference', title: 'Current repo guide',
    content: 'Calibration guide for current repo.', repositories: [activeRepo],
  }, { evidence: ['test:repo-current'], apply: true });
  await kb.add({
    id: 'wiki-other', kind: 'reference', title: 'Other repo guide',
    content: 'Calibration guide for other repo.', repositories: [otherRepo],
  }, { evidence: ['test:repo-other'], apply: true });

  const listed = await kb.list({ repository: activeRepo, limit: 20 });
  assert.ok(listed.results.some(item => item.kind === 'episodic' && item.id === 'mem-rotor'));
  assert.ok(listed.results.some(item => item.id === 'entries/wiki-current'));
  assert.ok(!listed.results.some(item => item.id === 'entries/wiki-other'));

  const searched = await kb.search('Calibration', { repository: activeRepo, limit: 20 });
  assert.ok(searched.results.some(item => item.kind === 'episodic' && item.id === 'mem-rotor'));
  assert.ok(searched.results.some(item => item.id === 'entries/wiki-current'));
  assert.ok(!searched.results.some(item => item.id === 'entries/wiki-other'));

  const episodicOnly = await kb.search('Calibration', { kind: 'episodic', repository: activeRepo, limit: 20 });
  assert.deepEqual(episodicOnly.results.map(item => item.id), ['mem-rotor']);
});


