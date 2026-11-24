import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodeGraph, CodeIndexLockedError } from '../dist/code.js';
import { KnowledgeStore } from '../dist/kb.js';
import { KnowledgeReads, validateKnowledgeReads } from '../dist/knowledge-reads.js';
import { MemoryStore } from '../dist/memory.js';
import { parseSearchFrom, search, unifiedSearch } from '../dist/search.js';
import { applyWikiChange, proposeWikiChange } from '../dist/wiki-change.js';
import { Wiki } from '../dist/wiki.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'evolve-unified-search-'));
  const memory = new MemoryStore(':memory:');
  t.after(async () => {
    memory.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, memory, wiki: new Wiki(root) };
}

function publish(wiki, id, kind, body, extra = {}) {
  const change = proposeWikiChange(wiki, {
    operation: 'create', entry: `entries/${id}`, title: id, mode: kind,
    scope: ['project'], body, ...extra,
  }, ['test:unified-search']);
  applyWikiChange(wiki, change.id);
}

function codeHit(id, path, score = 1) {
  return {
    node: { id, name: id, qualifiedName: `${path}::${id}`, filePath: path,
      kind: 'function', language: 'typescript', signature: `function ${id}()`,
      startLine: 1, endLine: 2, startColumn: 0, endColumn: 1, updatedAt: 0 },
    score,
  };
}

test('unified search fuses domain ranks with authority weights and a single global limit', async t => {
  const { memory, wiki } = await fixture(t);
  publish(wiki, 'binding', 'constraint', 'Calibration requires verified units.');
  publish(wiki, 'reference', 'reference', 'Calibration follows the sensor procedure.');
  await memory.put({ id: 'episode', content: 'Calibration failed last week.' });
  const kb = new KnowledgeStore([{ scope: 'project', wiki, memory }]);
  const code = { search: async () => [codeHit('calibration', 'src/calibration.ts', 1e12)] };
  const result = await unifiedSearch({ kb, code }, 'calibration', { limit: 4 });
  assert.equal(result.mode, 'merged');
  assert.deepEqual(result.results.map(hit => hit.kind), ['constraint', 'reference', 'code', 'episodic']);
  assert.deepEqual(result.results.map(hit => hit.source), ['kb', 'kb', 'code', 'kb']);
  for (const hit of result.results) {
    assert.ok(Number.isFinite(hit.score) && hit.score > 0);
    for (const field of ['id', 'title', 'snippet', 'authority', 'scope', 'status', 'content']) {
      assert.equal(typeof hit[field], 'string');
    }
  }
  assert.equal((await unifiedSearch({ kb, code }, 'calibration', { limit: 2 })).results.length, 2);
});

test('project and global duplicates keep the project content without inflating its rank', async t => {
  const project = await fixture(t);
  const global = await fixture(t);
  publish(project.wiki, 'shared', 'reference', 'Calibration project guidance.');
  publish(global.wiki, 'shared', 'reference', 'Calibration global guidance.');
  publish(global.wiki, 'global-only', 'reference', 'Calibration user guidance.');
  const kb = new KnowledgeStore([
    { scope: 'global', wiki: global.wiki }, { scope: 'project', wiki: project.wiki },
  ]);
  const local = await unifiedSearch({ kb }, 'calibration', { from: 'kb', limit: 10 });
  assert.equal(local.results.filter(hit => hit.id === 'entries/shared').length, 1);
  const shared = local.results.find(hit => hit.id === 'entries/shared');
  assert.equal(shared.scope, 'project');
  assert.match(shared.content, /project guidance/);
  const projectOnly = await unifiedSearch({ kb }, 'calibration', { from: 'kb', scope: 'project' });
  assert.deepEqual(projectOnly.results.map(hit => hit.id), ['entries/shared']);
  const globalOnly = await unifiedSearch({ kb }, 'calibration', { from: 'kb', scope: 'global' });
  assert.ok(globalOnly.results.every(hit => hit.scope === 'global'));
});

test('a global copy does not promote a lower-ranked project reference', async t => {
  const project = await fixture(t);
  const global = await fixture(t);
  publish(project.wiki, 'a-independent', 'reference', 'Calibration first guidance.');
  publish(project.wiki, 'z-shared', 'reference', 'Calibration other guidance.');
  publish(global.wiki, 'z-shared', 'reference', 'Calibration other guidance.');
  const baseline = await unifiedSearch({ kb: new KnowledgeStore([{ scope: 'project', wiki: project.wiki }]) },
    'calibration', { from: 'kb' });
  const combined = await unifiedSearch({ kb: new KnowledgeStore([
    { scope: 'project', wiki: project.wiki }, { scope: 'global', wiki: global.wiki },
  ]) }, 'calibration', { from: 'kb' });
  assert.deepEqual(combined.results.map(hit => hit.id), baseline.results.map(hit => hit.id));
});

test('context includes every applicable constraint, related code and auditable source identities', async t => {
  const { memory, wiki } = await fixture(t);
  publish(wiki, 'units', 'constraint', 'Always use SI units.');
  publish(wiki, 'pressure', 'constraint', 'Always validate pressure.');
  publish(wiki, 'other-task', 'constraint', 'Other task only.', { scope: ['task:other'] });
  publish(wiki, 'procedure', 'reference', 'Calibration procedure.');
  await memory.put({ id: 'run-episode', content: 'Calibration incident.', scene: 'analyze', session: 'old-run', type: 'verified_fix' });
  await memory.put({ id: 'other-episode', content: 'Calibration note.', scene: 'analyze', session: 'other-run' });
  const kb = new KnowledgeStore([{ scope: 'project', wiki, memory }]);
  const tracker = new KnowledgeReads();
  const code = { search: async () => [codeHit('calibration', 'src/calibration.ts')] };
  const result = await unifiedSearch({ kb, code }, 'calibration', {
    mode: 'context', limit: 1, task: 'analyze', memorySession: 'old-run',
    contextScope: { session_id: 'active-run' }, knowledgeReads: tracker,
  });
  assert.equal(result.mode, 'context');
  assert.equal(result.constraints.length, 2);
  assert.equal(result.references.length, 1);
  assert.equal(result.episodic.length, 1);
  assert.equal(result.episodic[0].id, 'run-episode');
  assert.equal(result.code.length, 1);
  assert.deepEqual(result.context_scope, { session_id: 'active-run', task_kind: 'analyze' });
  assert.ok(result.constraints.every(hit => /^sha256:[a-f0-9]{64}$/.test(hit.content_sha256)));
  const receipt = validateKnowledgeReads(tracker.toJSON());
  assert.equal(receipt.constraints_bound.length, 2);
  assert.ok(receipt.searches.some(search => search.source === 'code'));
  assert.ok(receipt.searches.some(search => search.source === 'memory'));
  assert.equal(receipt.reads.length, 0);
});

test('context resolves reference applicability and never binds retired constraints', async t => {
  const { wiki } = await fixture(t);
  publish(wiki, 'active-rule', 'constraint', 'Always validate units.');
  publish(wiki, 'retired-rule', 'constraint', 'Previously validate something else.');
  const retirement = proposeWikiChange(wiki, { operation: 'retire', entry: 'entries/retired-rule' }, ['test:retire']);
  applyWikiChange(wiki, retirement.id);
  publish(wiki, 'scoped-reference', 'reference', 'Calibration other task.', { scope: ['task:other'] });
  const kb = new KnowledgeStore([{ scope: 'project', wiki }]);
  const tracker = new KnowledgeReads();
  const context = await unifiedSearch({ kb }, 'calibration', {
    from: 'kb', mode: 'context', includeHistory: true, knowledgeReads: tracker,
  });
  assert.deepEqual(context.constraints.map(hit => hit.id), ['entries/active-rule']);
  assert.deepEqual(context.references, []);
  assert.deepEqual(tracker.toJSON().constraints_bound.map(hit => hit.knowledge_id), ['entries/active-rule']);
});

test('source, kind and path selection exclude unrequested work and reject invalid combinations', async t => {
  const { memory } = await fixture(t);
  await memory.put({ id: 'episode', content: 'Calibration incident.' });
  const kb = new KnowledgeStore([{ scope: 'project', memory }]);
  let codeCalls = 0;
  const code = { search: async () => {
    codeCalls++;
    return [codeHit('calibratePump', 'src/pump.ts'), codeHit('calibrateFan', 'other/fan.ts')];
  } };
  const knowledgeOnly = await unifiedSearch({ kb, code }, 'calibration', { from: 'kb', kind: 'episodic' });
  assert.equal(codeCalls, 0);
  assert.equal(knowledgeOnly.results.length, 1);
  const codeOnly = await unifiedSearch({ kb, code }, 'calibration', { from: 'code', paths: ['src'] });
  assert.deepEqual(codeOnly.results.map(hit => hit.id), ['calibratePump']);
  const global = await unifiedSearch({ kb, code }, 'calibration', { scope: 'global' });
  assert.equal(global.results.length, 0);
  assert.equal(codeCalls, 1);
  await assert.rejects(unifiedSearch({ kb, code }, 'calibration', { from: 'code', scope: 'global' }), /no global source/);
  await assert.rejects(unifiedSearch({ kb, code }, 'calibration', { page: 2 }), /does not support pagination/);
  await assert.rejects(unifiedSearch({ kb }, 'calibration', { mode: 'context', page: 2, from: 'kb' }), /does not support pagination/);
  await assert.rejects(unifiedSearch({ kb }, 'calibration', { limit: 0 }), /limit must be/);
  await assert.rejects(unifiedSearch({ kb }, 'calibration', { hop: 6 }), /hop must be/);
  await assert.rejects(unifiedSearch({ kb }, 'calibration', { scope: 'all' }), /scope must be/);
  for (const filter of [{ kind: 'episodic' }, { categories: ['arch'] }, { status: 'deprecated' },
    { type: 'error' }, { scene: 'execute' }, { session: 'old-run' }, { memorySession: 'old-run' }]) {
    await assert.rejects(unifiedSearch({ code }, 'calibration', { from: 'code', ...filter }), /Knowledge filters require/);
  }
  const codeContext = await unifiedSearch({ code }, 'calibration', {
    from: 'code', mode: 'context', task: 'analyze', contextScope: { session_id: 'active-run' },
  });
  assert.deepEqual(codeContext.context_scope, { session_id: 'active-run', task_kind: 'analyze' });
  assert.deepEqual(parseSearchFrom('code,kb,code'), ['code', 'kb']);
  assert.throws(() => parseSearchFrom('wiki'), /from must be/);
  assert.throws(() => parseSearchFrom(''), /from must be/);
});

test('knowledge-only merged pages have no overlap and retain all candidates', async t => {
  const { memory } = await fixture(t);
  await memory.putMany(Array.from({ length: 127 }, (_, index) => ({
    id: `episode-${String(index).padStart(3, '0')}`, content: `Calibration sample ${index}.`,
  })));
  const kb = new KnowledgeStore([{ scope: 'project', memory }]);
  const ids = [];
  for (let page = 1; page <= 4; page++) {
    const result = await unifiedSearch({ kb }, 'calibration', { from: 'kb', page, limit: 40 });
    ids.push(...result.results.map(hit => hit.id));
    assert.equal(result.pagination.nextPage, page < 4 ? page + 1 : null);
  }
  assert.equal(ids.length, 127);
  assert.equal(new Set(ids).size, 127);
});

test('unified search retrieves actual TypeScript symbols from CodeGraph', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'pump.ts'), 'export function calibratePump(value: number) { return value * 2; }\n');
  const code = new CodeGraph(root, { autoRefresh: true });
  const result = await unifiedSearch({ code }, 'calibratePump', { from: 'code' });
  assert.equal(result.results[0].source, 'code');
  assert.match(result.results[0].title, /calibratePump/);
  assert.equal(result.results[0].path, 'pump.ts');
});

test('unified search filters code paths before candidate limits', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'other'));
  await mkdir(join(root, 'wanted', 'nested'), { recursive: true });
  await Promise.all(Array.from({ length: 105 }, (_, index) => {
    const suffix = String(index).padStart(3, '0');
    return writeFile(join(root, 'other', `a${suffix}.ts`),
      `export function calibration${suffix}() { return ${index}; }\n`);
  }));
  await writeFile(join(root, 'wanted', 'target.ts'), 'export function calibrationZZZ() { return 0; }\n');
  await writeFile(join(root, 'wanted', 'nested', 'extra.ts'), 'export function calibrationZZY() { return 1; }\n');
  const code = new CodeGraph(root);
  await code.build();
  const unfiltered = await code.search('calibration', 100);
  assert.equal(unfiltered.length, 100);
  assert.ok(unfiltered.every(hit => !hit.node.filePath.startsWith('wanted/')));

  for (const [paths, expected] of [
    [['wanted'], ['wanted/nested/extra.ts', 'wanted/target.ts']],
    [['./wanted/'], ['wanted/nested/extra.ts', 'wanted/target.ts']],
    [['wanted/target.ts'], ['wanted/target.ts']],
    [['wanted\\target.ts'], ['wanted/target.ts']],
    [['wanted/*.ts'], ['wanted/target.ts']],
    [['wanted/**/*.ts'], ['wanted/nested/extra.ts', 'wanted/target.ts']],
    [['absent'], []],
  ]) {
    const reads = new KnowledgeReads();
    const result = await unifiedSearch({ code }, 'calibration', { from: 'code', paths, knowledgeReads: reads });
    assert.deepEqual(result.results.map(hit => hit.path).sort(), expected, paths.join(','));
    assert.deepEqual(reads.toJSON().searches[0].returned_ids.sort(), result.results.map(hit => hit.id).sort());
  }
  const limited = await unifiedSearch({ code }, 'calibration', { from: 'code', paths: ['wanted'], limit: 1 });
  assert.equal(limited.results.length, 1);
  assert.ok(limited.results[0].path.startsWith('wanted/'));
  const direct = await code.search('calibration', 1, { paths: ['wanted'] });
  assert.equal(direct.length, 1);
  assert.ok(direct[0].node.filePath.startsWith('wanted/'));
});

test('contextSpecificity reorders Wiki hits before RRF fusion and episodic survives dense code hits in merged mode', async t => {
  const { memory, wiki } = await fixture(t);
  publish(wiki, 'a-generic', 'reference', 'Calibration procedure checklist.');
  publish(wiki, 'z-targeted', 'reference', 'Calibration procedure checklist for planning.', {
    scope: ['task:plan'], categories: ['arch'],
  });
  await memory.put({ id: 'mem-1', content: 'Calibration failed when pump pressure drifted.' });
  const kb = new KnowledgeStore([{ scope: 'project', wiki, memory }]);

  const kbRanked = await kb.search('Calibration procedure', { task: 'plan', categories: ['arch'] });
  assert.equal(kbRanked.results[0].id, 'entries/z-targeted');

  const manyCodeHits = Array.from({ length: 30 }, (_, index) =>
    codeHit(`calibrationFn${String(index).padStart(2, '0')}`, `src/mod${index}.ts`, 100 - index));
  const merged = await unifiedSearch({ kb, code: { search: async () => manyCodeHits } }, 'calibration', { limit: 10 });
  assert.ok(merged.results.some(hit => hit.kind === 'reference'));
  assert.ok(merged.results.some(hit => hit.kind === 'episodic'));
  assert.ok(merged.results.some(hit => hit.kind === 'code'));
});

test('context mode enforces constraints budget and emits explicit overflow notice', async t => {
  const { wiki } = await fixture(t);
  for (let index = 0; index < 25; index++) {
    publish(wiki, `rule-${String(index).padStart(2, '0')}`, 'constraint', `Always validate calibration rule ${index}.`);
  }
  const kb = new KnowledgeStore([{ scope: 'project', wiki }]);
  const result = await unifiedSearch({ kb }, 'calibration', { from: 'kb', mode: 'context' });
  assert.equal(result.constraints.length, 20);
  assert.equal(result.constraints_truncated, true);
  assert.equal(result.constraints_total, 25);
  assert.equal(result.constraints_omitted.length, 5);
  assert.match(result.constraints_notice, /Showing 20 of 25 applicable constraints/);

  const charCapped = await unifiedSearch({ kb }, 'calibration', {
    from: 'kb', mode: 'context', constraintLimit: 50, constraintBudgetChars: 120,
  });
  assert.ok(charCapped.constraints.length >= 1 && charCapped.constraints.length < 25);
  assert.equal(charCapped.constraints_truncated, true);
});

test('unified search keeps kb results when code index is locked on mixed scope', async t => {
  const { memory, wiki } = await fixture(t);
  publish(wiki, 'lock-fallback', 'reference', 'Calibration survives code index lock.');
  const kb = new KnowledgeStore([{ scope: 'project', wiki, memory }]);
  const lockedCode = { search: async () => { throw new CodeIndexLockedError('CodeGraph index is locked by another process'); } };

  const mixed = await unifiedSearch({ kb, code: lockedCode }, 'calibration', { mode: 'context' });
  assert.equal(mixed.references.length, 1);
  assert.deepEqual(mixed.code, []);

  await assert.rejects(
    unifiedSearch({ kb, code: lockedCode }, 'calibration', { from: 'code' }),
    /locked by another process/,
  );

  const busyCode = { search: async () => { throw new Error('SQLITE_BUSY: database is locked'); } };
  const mixedBusy = await unifiedSearch({ kb, code: busyCode }, 'calibration', { mode: 'context' });
  assert.equal(mixedBusy.references.length, 1);
  assert.deepEqual(mixedBusy.code, []);
  const legacyBusy = await search({ wiki, memory, code: busyCode }, 'calibration', { scope: 'all' });
  assert.equal(legacyBusy.wiki.results.length, 1);
  assert.deepEqual(legacyBusy.code, []);

  const unavailableCode = {
    search: async () => {
      const error = new Error('A rebuild of this index is in progress; retry when it finishes.');
      error.name = 'LockUnavailableError';
      throw error;
    },
  };
  const mixedUnavailable = await unifiedSearch({ kb, code: unavailableCode }, 'calibration', { mode: 'context' });
  assert.equal(mixedUnavailable.references.length, 1);
  assert.deepEqual(mixedUnavailable.code, []);
});
