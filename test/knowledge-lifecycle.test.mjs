import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  MemoryStore,
  Wiki,
  applyBoundedExploration,
  classifyKnowledgeRelation,
  computeDecayFactor,
  findHeuristicConflicts,
  lintKnowledge,
} from 'self-evolving-workflow';
import { harvestCompletion } from '../dist/closeout.js';
import { KnowledgeStore } from '../dist/kb.js';
import { unifiedSearch } from '../dist/search.js';
import { applyWikiChange, proposeWikiChange } from '../dist/wiki-change.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));

async function makeTempDir(t, prefix = 'evolve-lifecycle-', onClose) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await onClose?.();
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('computeDecayFactor decays asymptotically to floor and slows down with readCount', () => {
  const now = Date.parse('2026-11-24T00:00:00Z');
  const dayMs = 86_400_000;

  const fresh = computeDecayFactor({ kind: 'episodic', contentChangedAt: now, readCount: 0, nowMs: now });
  assert.equal(fresh, 1);

  const halfLife30 = computeDecayFactor({
    kind: 'episodic',
    contentChangedAt: now - 30 * dayMs,
    readCount: 0,
    nowMs: now,
  });
  assert.ok(Math.abs(halfLife30 - 0.65) < 0.001);

  const ancient = computeDecayFactor({
    kind: 'episodic',
    contentChangedAt: now - 5000 * dayMs,
    readCount: 0,
    nowMs: now,
  });
  assert.ok(ancient >= 0.3 && ancient < 0.301);

  const refAt30 = computeDecayFactor({
    kind: 'reference',
    contentChangedAt: now - 30 * dayMs,
    readCount: 0,
    nowMs: now,
  });
  const constraintAt30 = computeDecayFactor({
    kind: 'constraint',
    contentChangedAt: now - 30 * dayMs,
    readCount: 0,
    nowMs: now,
  });
  assert.ok(halfLife30 < refAt30 && refAt30 < constraintAt30);

  const reinforced = computeDecayFactor({
    kind: 'episodic',
    contentChangedAt: now - 30 * dayMs,
    readCount: 10,
    nowMs: now,
  });
  assert.ok(reinforced > halfLife30);
});

test('MemoryStore tracks search hits and reads, preserves content_changed_at, and applies decay with consumption resistance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'evolve-lifecycle-mem-'));
  const dbPath = join(root, '.evolve', 'memory.db');
  const memory = new MemoryStore(dbPath);
  t.after(async () => {
    memory.close();
    await rm(root, { recursive: true, force: true });
  });

  await memory.put({ id: 'mem-a', content: 'Calibration uses sensor alpha.' });
  await memory.put({ id: 'mem-b', content: 'Calibration uses sensor alpha.' });
  const usageBefore = memory.getUsage('mem-a');
  assert.ok(usageBefore);
  assert.equal(usageBefore.searchHits, 0);
  assert.equal(usageBefore.readCount, 0);

  // Re-putting identical content preserves content_changed_at, while new content resets it.
  await memory.put({ id: 'mem-a', content: 'Calibration uses sensor alpha.' });
  assert.equal(memory.getUsage('mem-a').contentChangedAt, usageBefore.contentChangedAt);

  // Age mem-a by 120 days and mem-b by 120 days, but give mem-b 15 reads to slow decay.
  memory.db.prepare('UPDATE memory_usage SET content_changed_at = ? WHERE memory_key IN (SELECT key FROM memory_records WHERE id IN (?, ?))')
    .run('2026-07-01T00:00:00.000Z', 'mem-a', 'mem-b');
  for (let i = 0; i < 15; i++) memory.get('mem-b');
  assert.equal(memory.getUsage('mem-b').readCount, 15);
  assert.equal(memory.getUsage('mem-a').readCount, 0);

  const nowMs = Date.parse('2026-11-24T00:00:00.000Z');
  const searchRes = await memory.search('Calibration sensor alpha', { nowMs, limit: 2 });
  assert.equal(searchRes.results[0].id, 'mem-b');
  assert.ok(searchRes.results[0].score > searchRes.results[1].score);
  assert.equal(memory.getUsage('mem-a').searchHits, 1);
  assert.equal(memory.getUsage('mem-b').searchHits, 1);
});

test('applyBoundedExploration promotes low-exposure eligible candidates without dropping paginated items', () => {
  const items = [
    { id: 'a', score: 10 },
    { id: 'b', score: 9 },
    { id: 'c', score: 8 },
    { id: 'd', score: 7 },
    { id: 'e', score: 5 }, // >= 35% of 10
    { id: 'f', score: 2 }, // < 35% of 10
  ];
  const hits = new Map([
    ['a', 20],
    ['b', 15],
    ['c', 12],
    ['d', 10],
    ['e', 0],
    ['f', 0],
  ]);

  const reordered = applyBoundedExploration(items, {
    limit: 4,
    page: 1,
    getId: item => item.id,
    getScore: item => item.score,
    searchHits: hits,
  });
  assert.deepEqual(reordered.slice(0, 4).map(item => item.id), ['a', 'b', 'c', 'e']);
  assert.deepEqual(reordered.map(item => item.id).sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('Wiki preserves usage across rebuilds and penalizes stale and contested entries', async t => {
  const root = await makeTempDir(t);
  const wiki = new Wiki(root);
  const oldChange = proposeWikiChange(wiki, {
    operation: 'create',
    entry: 'entries/legacy-note',
    title: 'Legacy sensor note',
    mode: 'reference',
    body: 'Calibration checklist for sensor pipeline.',
  }, ['test:1']);
  applyWikiChange(wiki, oldChange.id);
  // Stamp historical timestamp on legacy-note.
  await writeFile(
    join(root, 'wiki', 'entries', 'legacy-note.md'),
    [
      '---',
      'title: Legacy sensor note',
      'mode: reference',
      'status: active',
      'scope:',
      '  - project',
      'sources:',
      '  - test:1',
      'timestamp: 2025-01-01T00:00:00.000Z',
      '---',
      '',
      'Calibration checklist for sensor pipeline.',
      '',
    ].join('\n'),
  );

  const contestedChange = proposeWikiChange(wiki, {
    operation: 'create',
    entry: 'entries/contested-note',
    title: 'Contested sensor note',
    mode: 'reference',
    confidence: 'contested',
    body: 'Calibration checklist for sensor pipeline (contested draft).',
  }, ['test:2']);
  applyWikiChange(wiki, contestedChange.id);

  const freshChange = proposeWikiChange(wiki, {
    operation: 'create',
    entry: 'entries/fresh-note',
    title: 'Fresh sensor note',
    mode: 'reference',
    body: 'Calibration checklist for sensor pipeline (verified latest).',
  }, ['test:3']);
  applyWikiChange(wiki, freshChange.id);

  const kb = new KnowledgeStore([{ scope: 'project', wiki }]);
  const nowMs = Date.parse('2026-11-24T00:00:00.000Z');
  const res = await unifiedSearch({ kb }, 'Calibration checklist sensor pipeline', {
    from: 'kb',
    mode: 'merged',
    limit: 3,
    nowMs,
    explore: false,
  });
  assert.equal(res.results[0].id, 'entries/fresh-note');
  assert.equal(res.results.at(-1).id, 'entries/contested-note');
  assert.equal(wiki.getUsage('entries/fresh-note')?.searchHits, 1);

  kb.get('entries/fresh-note');
  assert.equal(wiki.getUsage('entries/fresh-note')?.readCount, 1);
  // Rebuilding wiki preserves accumulated usage counters.
  wiki.build();
  assert.equal(wiki.getUsage('entries/fresh-note')?.searchHits, 1);
  assert.equal(wiki.getUsage('entries/fresh-note')?.readCount, 1);
});

test('Heuristic conflict detector catches opposite stances and value divergence without false positives', () => {
  const enConflict = classifyKnowledgeRelation(
    'Always use mTLS for internal RPC.',
    'Never use mTLS for internal RPC.',
  );
  assert.equal(enConflict?.relation, 'conflict');
  assert.equal(enConflict?.reason, 'opposite_stance');

  const zhConflict = classifyKnowledgeRelation(
    '发布前必须运行完整校准检查。',
    '发布前禁止运行完整校准检查。',
  );
  assert.equal(zhConflict?.relation, 'conflict');
  assert.equal(zhConflict?.reason, 'opposite_stance');

  const portConflict = classifyKnowledgeRelation(
    'Billing API service listens on port 8080.',
    'Billing API service listens on port 9090.',
  );
  assert.equal(portConflict?.relation, 'conflict');
  assert.equal(portConflict?.reason, 'value_divergence');

  const ordinalOk = classifyKnowledgeRelation(
    'Always validate calibration rule 0.',
    'Always validate calibration rule 1.',
  );
  assert.notEqual(ordinalOk?.relation, 'conflict');

  const scopedConflicts = findHeuristicConflicts(
    { content: 'Never use mock fixtures in verify.', scope: ['task:verify'] },
    [
      { id: 'plan-rule', content: 'Always use mock fixtures in verify.', scope: ['task:plan'] },
      { id: 'verify-rule', content: 'Always use mock fixtures in verify.', scope: ['task:verify'] },
    ],
  );
  assert.deepEqual(scopedConflicts.map(item => item.id), ['verify-rule']);
});

test('kb.add and closeout harvest surface heuristic conflicts even without BM25 top-5 matches', async t => {
  let memory;
  const root = await makeTempDir(t, 'evolve-lifecycle-closeout-', () => memory?.close());
  memory = new MemoryStore(join(root, '.evolve', 'memory.db'));
  const wiki = new Wiki(root);
  const kb = new KnowledgeStore([{ scope: 'project', wiki, memory }]);

  await kb.add({ id: 'port-old', content: 'Auth gateway listens on port 8080.' });
  const added = await kb.add({ id: 'port-new', content: 'Auth gateway listens on port 9090.' });
  assert.ok(added.conflicts?.some(item => item.id === 'port-old' && item.relation === 'conflict'));

  const rule = proposeWikiChange(wiki, {
    operation: 'create',
    entry: 'entries/mtls-policy',
    title: 'mTLS policy',
    mode: 'constraint',
    body: 'Always enable mTLS on internal RPC.',
  }, ['seed:mtls']);
  applyWikiChange(wiki, rule.id);

  // Even if LLM fails to emit conflict (returns []), heuristic catches opposite stance.
  const harvested = await harvestCompletion(wiki, 'proj', {
    schema_version: 'skill-completion/1.0',
    id: 'comp-conflict-1',
    execution_id: 'exec-conflict-1',
    status: 'succeeded',
    recorded_at: '2026-11-24T00:00:00.000Z',
    messages: [{ id: 'm1', role: 'user', timestamp: '2026-11-24T00:00:00.000Z', content: 'Never enable mTLS on internal RPC.' }],
  }, () => ({
    async chat({ label }) {
      if (label === 'closeout-harvest') {
        return JSON.stringify([{ memories: [{ type: 'work_method', content: 'Never enable mTLS on internal RPC.', source_message_ids: ['m1'] }] }]);
      }
      return '[]';
    },
  }));
  assert.equal(harvested.candidates.length, 1);
  assert.ok(harvested.candidates[0].related_entries?.some(
    item => item.id === 'entries/mtls-policy' && item.relation === 'conflict',
  ));
});

test('evolve kb lint reports conflicts, stale entries, broken links, orphans and missing code anchors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'evolve-lifecycle-lint-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'real.ts'), 'export const ok = true;\n');

  const wiki = new Wiki(root);
  const c1 = proposeWikiChange(wiki, {
    operation: 'create',
    entry: 'entries/rule-positive',
    title: 'RPC auth enabled',
    mode: 'constraint',
    body: 'Always enable mTLS on internal RPC. See [[entries/missing-page]] and `src/deleted.ts`.',
  }, ['test:c1']);
  applyWikiChange(wiki, c1.id);

  const c2 = proposeWikiChange(wiki, {
    operation: 'create',
    entry: 'entries/rule-negative',
    title: 'RPC auth disabled',
    mode: 'reference',
    body: 'Never enable mTLS on internal RPC.',
  }, ['test:c2']);
  applyWikiChange(wiki, c2.id);

  // Make c2 old to also trigger stale_knowledge.
  await writeFile(
    join(root, 'wiki', 'entries', 'rule-negative.md'),
    [
      '---',
      'title: RPC auth disabled',
      'mode: reference',
      'status: active',
      'scope:',
      '  - project',
      'sources:',
      '  - test:c2',
      'timestamp: 2025-01-01T00:00:00.000Z',
      '---',
      '',
      'Never enable mTLS on internal RPC.',
      '',
    ].join('\n'),
  );
  wiki.build();

  const memory = new MemoryStore(join(root, '.evolve', 'memory.db'));
  await memory.put({ id: 'ep-1', content: 'Gateway runs on port 8080.' });
  await memory.put({ id: 'ep-2', content: 'Gateway runs on port 9090.' });
  memory.close();

  const readOnlyMemory = new MemoryStore(join(root, '.evolve', 'memory.db'), { readOnly: true });
  t.after(async () => {
    readOnlyMemory.close();
    await rm(root, { recursive: true, force: true });
  });
  const report = lintKnowledge({
    root,
    scope: 'project',
    layers: [{ scope: 'project', wiki, memory: readOnlyMemory }],
    nowMs: Date.parse('2026-11-24T00:00:00.000Z'),
  });
  const categories = new Set(report.findings.map(item => item.category));
  assert.ok(categories.has('potential_conflict'));
  assert.ok(categories.has('broken_wikilink'));
  assert.ok(categories.has('stale_code_anchor'));
  assert.ok(categories.has('orphan_page'));
  assert.ok(categories.has('stale_knowledge'));

  const { stdout } = await execFileAsync(
    process.execPath,
    [cliPath, '--root', root, 'kb', 'lint', '--scope', 'project'],
    { encoding: 'utf8' },
  );
  const cliReport = JSON.parse(stdout);
  assert.equal(cliReport.schema_version, 'evolve-kb-lint/1.0');
  assert.ok(cliReport.summary.findings_total >= 4);

  const { stdout: compactOut } = await execFileAsync(
    process.execPath,
    [cliPath, '--root', root, 'kb', 'lint', '--scope', 'project', '--format', 'compact'],
    { encoding: 'utf8' },
  );
  assert.match(compactOut, /kb lint \| scope: project/);
  assert.match(compactOut, /potential_conflict/);
});
