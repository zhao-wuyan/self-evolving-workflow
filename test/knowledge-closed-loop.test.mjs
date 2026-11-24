import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  MemoryStore,
  Wiki,
  classifyKnowledgeRelation,
  computeDecayFactor,
  findHeuristicConflicts,
  lintKnowledge,
} from 'self-evolving-workflow';
import { harvestCompletion, publishReference } from '../dist/closeout.js';
import { DatabaseSync } from '../dist/common.js';
import { KnowledgeStore } from '../dist/kb.js';
import { KnowledgeReads, validateKnowledgeReads } from '../dist/knowledge-reads.js';
import { unifiedSearch } from '../dist/search.js';
import { applyWikiChange, proposeWikiChange } from '../dist/wiki-change.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));

async function makeWorkspace(t, prefix, onClose) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await onClose?.();
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function runCliJson(root, ...args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, '--root', root, ...args], {
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

test('Closed Loop 1: Rule lifecycle from storage -> search -> code drift & conflict -> contested penalty -> retire -> clean lint', async t => {
  const root = await makeWorkspace(t, 'evolve-loop-1-');
  await mkdir(join(root, 'src', 'auth'), { recursive: true });
  await writeFile(join(root, 'src', 'auth', 'verify.ts'), 'export function verifyMtls() { return true; }\n');

  const wiki = new Wiki(root);
  const kb = new KnowledgeStore([{ scope: 'project', wiki }]);

  // 1. Storage: publish initial binding constraint + linked reference anchored to src/auth/verify.ts
  await kb.add({
    id: 'auth-mtls',
    kind: 'constraint',
    title: 'Internal RPC mTLS required',
    content: 'Internal services must enable mTLS across all RPC boundaries.',
    scope: ['project'],
    categories: ['arch'],
  }, { evidence: ['adr:001'], apply: true });

  await kb.add({
    id: 'auth-rollout',
    kind: 'reference',
    title: 'mTLS verification guide',
    content: 'Verify mTLS certificates in `src/auth/verify.ts` per [[entries/auth-mtls]].',
    scope: ['project'],
    categories: ['arch'],
  }, { evidence: ['doc:001'], apply: true });

  // 2. Search: verify active constraint & reference surface normally
  const initialCtx = await unifiedSearch({ kb }, 'Internal services mTLS RPC', { from: 'kb', mode: 'context' });
  assert.deepEqual(initialCtx.constraints.map(item => item.id), ['entries/auth-mtls']);
  assert.equal(initialCtx.references[0].id, 'entries/auth-rollout');

  // 3. Simulate code refactor (anchor file deleted) + incoming conflicting rule staged as contested
  await unlink(join(root, 'src', 'auth', 'verify.ts'));
  const conflictAdd = await kb.add({
    id: 'auth-dev-bypass',
    kind: 'reference',
    title: 'Dev RPC bypass',
    content: 'Internal services must not enable mTLS across local RPC boundaries.',
    scope: ['project'],
    categories: ['arch'],
  }, { evidence: ['issue:102'], apply: false });
  assert.ok(conflictAdd.conflicts?.some(item => item.id === 'entries/auth-mtls' && item.relation === 'conflict'));

  // Publish conflicting proposal explicitly marked confidence: 'contested'
  const contestedProposal = proposeWikiChange(wiki, {
    operation: 'create',
    entry: 'entries/auth-dev-bypass',
    title: 'Dev RPC bypass',
    mode: 'reference',
    confidence: 'contested',
    conflicts_with: ['entries/auth-mtls'],
    body: 'Internal services must not enable mTLS across local RPC boundaries. See [[entries/auth-mtls]].',
  }, ['issue:102']);
  applyWikiChange(wiki, contestedProposal.id);

  // 4. Search under conflict: contested entry is penalized and tagged in output
  const merged = await unifiedSearch({ kb }, 'Internal services mTLS RPC boundaries', {
    from: 'kb', mode: 'merged', explore: false,
  });
  const rolloutIdx = merged.results.findIndex(item => item.id === 'entries/auth-rollout');
  const contestedIdx = merged.results.findIndex(item => item.id === 'entries/auth-dev-bypass');
  assert.ok(rolloutIdx >= 0 && contestedIdx > rolloutIdx);
  assert.equal(merged.results[contestedIdx].confidence, 'contested');

  // 5. Lint catches potential_conflict, needs_review/contested, and stale_code_anchor
  const dirtyLint = lintKnowledge({ root, scope: 'project', layers: [{ scope: 'project', wiki }] });
  const dirtyCats = new Set(dirtyLint.findings.map(item => item.category));
  assert.ok(dirtyCats.has('potential_conflict'));
  assert.ok(dirtyCats.has('needs_review'));
  assert.ok(dirtyCats.has('stale_code_anchor'));

  // 6. Cleanup & resolution: retire old constraint, resolve contested reference & fix stale anchor
  await kb.delete('entries/auth-mtls', { evidence: ['adr:002-supersede'], apply: true });
  const resolveRollout = proposeWikiChange(wiki, {
    operation: 'update',
    entry: 'entries/auth-rollout',
    body: 'Verify mTLS certificates in gateway policy per [[entries/auth-dev-bypass]].',
  }, ['adr:002']);
  applyWikiChange(wiki, resolveRollout.id);

  const resolveBypass = proposeWikiChange(wiki, {
    operation: 'update',
    entry: 'entries/auth-dev-bypass',
    confidence: 'high',
    conflicts_with: [],
    body: 'Internal services must not enable mTLS across local RPC boundaries.',
  }, ['adr:002']);
  applyWikiChange(wiki, resolveBypass.id);

  // 7. Post-cleanup verification: retired rule is excluded by default, preserved in history, and lint is clean
  const postCtx = await unifiedSearch({ kb }, 'Internal services mTLS RPC', { from: 'kb', mode: 'context' });
  assert.deepEqual(postCtx.constraints, []);
  assert.equal(kb.get('entries/auth-mtls')?.status, 'deprecated');
  assert.equal((await kb.list({ status: 'deprecated' })).results.map(item => item.id).includes('entries/auth-mtls'), true);

  const cleanLint = lintKnowledge({ root, scope: 'project', layers: [{ scope: 'project', wiki }] });
  assert.equal(cleanLint.summary.findings_total, 0, JSON.stringify(cleanLint.findings));
});

test('Closed Loop 2: Exposure vs consumption decay divergence, bounded exploration slot, and cascade delete', async t => {
  let memory;
  const root = await makeWorkspace(t, 'evolve-loop-2-', () => memory?.close());
  const dbPath = join(root, '.evolve', 'memory.db');
  memory = new MemoryStore(dbPath);
  const kb = new KnowledgeStore([{ scope: 'project', memory }]);

  // Create 6 related memories; 4 hot items, 1 useful aged item, 1 unused aged item
  for (const id of ['hot-1', 'hot-2', 'hot-3', 'hot-4', 'aged-useful', 'aged-unused']) {
    await kb.add({ id, content: `Telemetry pipeline calibration check for ${id}.` });
  }

  // Age 'aged-useful' and 'aged-unused' by 120 days; give 'hot-*' heavy exposure (search_hits)
  const sqlite = new DatabaseSync(dbPath);
  sqlite.prepare(`
    UPDATE memory_usage SET content_changed_at = '2026-07-15T00:00:00.000Z'
    WHERE memory_key IN (SELECT key FROM memory_records WHERE id IN ('aged-useful', 'aged-unused'))
  `).run();
  sqlite.prepare(`
    UPDATE memory_usage SET search_hits = 25
    WHERE memory_key IN (SELECT key FROM memory_records WHERE id IN ('hot-1', 'hot-2', 'hot-3', 'hot-4'))
  `).run();
  sqlite.close();

  const nowMs = Date.parse('2026-11-24T00:00:00.000Z');
  const readsPath = join(root, 'reads.json');

  // Repeatedly expose 'aged-unused' via search WITHOUT reading it -> exposure alone must NOT slow decay
  for (let i = 0; i < 5; i++) {
    await kb.search('Telemetry pipeline calibration', { limit: 6, nowMs, explore: false });
  }
  assert.equal(memory.getUsage('aged-unused')?.searchHits, 5);
  assert.equal(memory.getUsage('aged-unused')?.readCount, 0);

  // Explicitly consume 'aged-useful' via CLI `kb get --reads` -> readCount grows & receipt records read
  for (let i = 0; i < 12; i++) {
    await runCliJson(root, 'kb', 'get', 'aged-useful', '--reads', readsPath);
  }
  const receipt = validateKnowledgeReads(JSON.parse(await readFile(readsPath, 'utf8')));
  assert.equal(receipt.reads.length, 1);
  assert.equal(memory.getUsage('aged-useful')?.readCount, 12);

  // Verify decay divergence: aged-useful outranks aged-unused and beats stale threshold better
  const usefulFactor = computeDecayFactor({
    kind: 'episodic',
    contentChangedAt: '2026-07-15T00:00:00.000Z',
    readCount: 12,
    nowMs,
  });
  const unusedFactor = computeDecayFactor({
    kind: 'episodic',
    contentChangedAt: '2026-07-15T00:00:00.000Z',
    readCount: 0,
    nowMs,
  });
  assert.ok(usefulFactor > unusedFactor);

  // Exploration slot check:
  // 1) Non-paginated top-K search (page omitted) promotes a lower-exposure candidate into slot 4
  const topK = await kb.search('Telemetry pipeline calibration', { limit: 4, nowMs });
  assert.equal(topK.results.length, 4);
  assert.ok(topK.results.some(item => item.id === 'aged-useful' || item.id === 'aged-unused'));

  // 2) Paginated traversal across page 1 + page 2 preserves all 6 items without overlap or loss
  const page1 = await kb.search('Telemetry pipeline calibration', { limit: 4, page: 1, nowMs });
  const page2 = await kb.search('Telemetry pipeline calibration', { limit: 4, page: 2, nowMs });
  const allIds = [...page1.results, ...page2.results].map(item => item.id);
  assert.equal(page1.results.length, 4);
  assert.equal(page2.results.length, 2);
  assert.equal(new Set(allIds).size, 6);

  // Lint catches stale unused entry & exposure concentration; delete aged-unused and verify cascade + history
  const lintBefore = lintKnowledge({ root, scope: 'project', layers: [{ scope: 'project', memory }], nowMs });
  assert.ok(lintBefore.findings.some(item => item.category === 'stale_knowledge' && item.targets.includes('aged-unused')));

  const delRes = await runCliJson(root, 'kb', 'delete', 'aged-unused');
  assert.deepEqual(delRes, { deleted: true });
  assert.equal(memory.get('aged-unused'), undefined);
  assert.equal(memory.getUsage('aged-unused'), undefined);

  const hist = await runCliJson(root, 'kb', 'history', 'aged-unused');
  assert.equal(hist.current, null);
  assert.equal(hist.history.length, 1);
  assert.equal(hist.history[0].reason, 'delete');

  const lintAfter = lintKnowledge({ root, scope: 'project', layers: [{ scope: 'project', memory }], nowMs });
  assert.equal(lintAfter.findings.some(item => item.targets.includes('aged-unused')), false);
});

test('Closed Loop 3: Cross-scope (project vs global) parameter conflict, metadata vs content update freshness, and exact literal reindex', async t => {
  let projectMem, globalMem;
  const root = await makeWorkspace(t, 'evolve-loop-3-', () => {
    projectMem?.close();
    globalMem?.close();
  });
  const projectDir = join(root, 'project');
  const globalDir = join(root, 'global');
  await mkdir(projectDir);
  await mkdir(globalDir);

  const projectDb = join(projectDir, '.evolve', 'memory.db');
  const globalDb = join(globalDir, '.evolve', 'memory.db');
  projectMem = new MemoryStore(projectDb);
  globalMem = new MemoryStore(globalDb);

  const kb = new KnowledgeStore([
    { scope: 'project', memory: projectMem },
    { scope: 'global', memory: globalMem },
  ]);

  // Global holds older baseline port 8080; Project holds newer port 9090
  await globalMem.put({ id: 'api-port-global', content: 'Billing API 服务监听端口 8080。', priority: 60 });
  await kb.add({ id: 'api-port-project', content: 'Billing API 服务监听端口 9090。', priority: 70 });

  // Cross-scope heuristic conflict comparison catches value_divergence across languages
  const crossConflicts = findHeuristicConflicts(
    { content: 'Billing API 服务监听端口 9090。' },
    [{ id: 'api-port-global', content: 'Billing API 服务监听端口 8080。' }],
  );
  assert.equal(crossConflicts.length, 1);
  assert.equal(crossConflicts[0].relation, 'conflict');
  assert.equal(crossConflicts[0].reason, 'value_divergence');

  // Age project entry 90 days; metadata-only update (priority) MUST NOT reset content_changed_at
  const sqlite = new DatabaseSync(projectDb);
  sqlite.prepare("UPDATE memory_usage SET content_changed_at = '2026-08-01T00:00:00.000Z'").run();
  sqlite.close();

  await kb.update('api-port-project', { priority: 95 });
  assert.equal(projectMem.getUsage('api-port-project')?.contentChangedAt, '2026-08-01T00:00:00.000Z');

  // Real content update DOES reset content_changed_at, archives prior versions, and reindexes exact literal 9443
  await kb.update('api-port-project', { content: 'Billing API 服务监听端口 9443。' });
  const updatedUsage = projectMem.getUsage('api-port-project');
  assert.notEqual(updatedUsage?.contentChangedAt, '2026-08-01T00:00:00.000Z');
  assert.equal(projectMem.history('api-port-project').length, 2);
  assert.equal(projectMem.history('api-port-project')[0].reason, 'update');
  assert.equal((await projectMem.search('9090')).results.length, 0);
  assert.equal((await projectMem.search('9443')).results[0].id, 'api-port-project');
});

test('Closed Loop 4: Multi-hop Wiki graph decay + orphan/broken-link lint + rebuild cleanup of deleted pages', async t => {
  const root = await makeWorkspace(t, 'evolve-loop-4-');
  const wiki = new Wiki(root);

  const p1 = proposeWikiChange(wiki, {
    operation: 'create',
    entry: 'entries/gateway',
    title: 'Gateway entry',
    mode: 'reference',
    body: 'API gateway entry point. Routes to [[entries/rate-limit]].',
  }, ['doc:1']);
  applyWikiChange(wiki, p1.id);

  const p2 = proposeWikiChange(wiki, {
    operation: 'create',
    entry: 'entries/rate-limit',
    title: 'Rate limit',
    mode: 'reference',
    body: 'Token bucket limiter details and [[entries/missing-target]].',
  }, ['doc:2']);
  applyWikiChange(wiki, p2.id);

  const p3 = proposeWikiChange(wiki, {
    operation: 'create',
    entry: 'entries/orphan-note',
    title: 'Orphan note',
    mode: 'reference',
    body: 'Unlinked standalone observation.',
  }, ['doc:3']);
  applyWikiChange(wiki, p3.id);

  // Record hits & reads on gateway and orphan-note
  const hitRes = wiki.search('gateway', { hop: 1, trackUsage: true });
  assert.ok(hitRes.results.some(item => item.id === 'entries/rate-limit' && item.hop === 1));
  wiki.getEntry('entries/gateway', { trackUsage: true });
  wiki.getEntry('entries/orphan-note', { trackUsage: true });
  assert.equal(wiki.getUsage('entries/gateway')?.readCount, 1);
  assert.equal(wiki.getUsage('entries/orphan-note')?.readCount, 1);

  // Lint catches broken_wikilink and orphan_page
  const lintBefore = lintKnowledge({ root, scope: 'project', layers: [{ scope: 'project', wiki }] });
  assert.ok(lintBefore.findings.some(item => item.category === 'broken_wikilink' && item.targets.includes('entries/rate-limit')));
  assert.ok(lintBefore.findings.some(item => item.category === 'orphan_page' && item.targets.includes('entries/orphan-note')));

  // Delete orphan-note physically & repair broken link on rate-limit, then rebuild
  await unlink(join(root, 'wiki', 'entries', 'orphan-note.md'));
  const fixLink = proposeWikiChange(wiki, {
    operation: 'update',
    entry: 'entries/rate-limit',
    body: 'Token bucket limiter details linked back to [[entries/gateway]].',
  }, ['doc:4']);
  applyWikiChange(wiki, fixLink.id);

  // Surviving page retains usage counters; deleted page is purged from wiki_usage on rebuild
  assert.equal(wiki.getUsage('entries/gateway')?.readCount, 1);
  assert.equal(wiki.getUsage('entries/orphan-note'), undefined);

  const lintAfter = lintKnowledge({ root, scope: 'project', layers: [{ scope: 'project', wiki }] });
  assert.equal(lintAfter.summary.findings_total, 0, JSON.stringify(lintAfter.findings));
});

test('Closed Loop 5: Closeout harvest conflict gate, exact-body source merge, governed resolution and idempotent apply', async t => {
  const root = await makeWorkspace(t, 'evolve-loop-5-');
  const wiki = new Wiki(root);

  const rule = proposeWikiChange(wiki, {
    operation: 'create',
    entry: 'entries/cache-policy',
    title: 'Cache migration policy',
    mode: 'constraint',
    body: 'Always bypass local cache during schema migration.',
  }, ['seed:cache']);
  applyWikiChange(wiki, rule.id);

  const ref = proposeWikiChange(wiki, {
    operation: 'create',
    entry: 'entries/backup-policy',
    title: 'Backup policy',
    mode: 'reference',
    body: 'Take a snapshot before schema migration.',
  }, ['seed:backup']);
  applyWikiChange(wiki, ref.id);

  // Harvest returns 2 items: one exact duplicate of backup-policy (auto-merges sources),
  // one direct contradiction to cache-policy (even with LLM returning [])
  const harvested = await harvestCompletion(wiki, 'proj', {
    schema_version: 'skill-completion/1.0',
    id: 'exec-closeout-loop',
    execution_id: 'exec-closeout-loop',
    status: 'succeeded',
    recorded_at: '2026-11-24T00:00:00.000Z',
    messages: [
      { id: 'm1', role: 'user', timestamp: '2026-11-24T00:00:00.000Z', content: 'Take a snapshot before schema migration.' },
      { id: 'm2', role: 'user', timestamp: '2026-11-24T00:00:00.000Z', content: 'Never bypass local cache during schema migration.' },
    ],
  }, () => ({
    async chat({ label }) {
      if (label === 'closeout-harvest') {
        return JSON.stringify([{
          memories: [
            { type: 'work_method', content: 'Take a snapshot before schema migration.', source_message_ids: ['m1'] },
            { type: 'work_method', content: 'Never bypass local cache during schema migration.', source_message_ids: ['m2'] },
          ],
        }]);
      }
      return '[]';
    },
  }));

  // Exact duplicate auto-merged sources into entries/backup-policy; only conflicting candidate remains pending
  assert.equal(wiki.getEntry('entries/backup-policy')?.sources.length, 2);
  assert.equal(harvested.candidates.length, 1);
  const candidate = harvested.candidates[0];
  assert.ok(candidate.related_entries?.some(item => item.id === 'entries/cache-policy' && item.relation === 'conflict'));

  // Direct publishReference MUST reject conflicting candidate
  assert.throws(
    () => publishReference(wiki, harvested.id, candidate.id, 'Cache override'),
    /related Wiki entries/,
  );

  // Proposing without relationship decision MUST fail governance check
  assert.throws(
    () => proposeWikiChange(wiki, {
      operation: 'update',
      entry: 'entries/cache-policy',
      body: 'Never bypass local cache during schema migration.',
    }, [], {
      closeout: harvested.id,
      id: candidate.id,
      sources: candidate.sources,
      related: ['entries/cache-policy'],
    }),
    /requires a recorded relationship decision/,
  );

  // Governed resolution with explicit conflict rationale succeeds and applies idempotently
  const resolved = proposeWikiChange(wiki, {
    operation: 'update',
    entry: 'entries/cache-policy',
    body: 'Never bypass local cache during schema migration.',
    review: {
      relationship: 'conflict',
      rationale: 'Updated cache safety policy verified in exec-closeout-loop.',
      related: ['entries/cache-policy'],
    },
  }, [], {
    closeout: harvested.id,
    id: candidate.id,
    sources: candidate.sources,
    related: ['entries/cache-policy'],
  });
  const applied = applyWikiChange(wiki, resolved.id);
  assert.equal(applied.replayed, false);
  assert.equal(applyWikiChange(wiki, resolved.id).replayed, true);
  assert.match(wiki.getEntry('entries/cache-policy')?.body ?? '', /Never bypass/);
});

test('Closed Loop 6: Pure CLI end-to-end flow, read-only isolation, and legacy DB backward compatibility', async t => {
  let legacyStore;
  const root = await makeWorkspace(t, 'evolve-loop-6-', () => legacyStore?.close());

  // 1. Legacy memory.db without memory_usage table
  const dbPath = join(root, '.evolve', 'memory.db');
  legacyStore = new MemoryStore(dbPath);
  await legacyStore.put({ id: 'legacy-1', content: 'Legacy service must use TLS 1.3.' });
  await legacyStore.put({ id: 'legacy-2', content: 'Legacy service must not use TLS 1.3.' });
  legacyStore.close();

  const dropUsage = new DatabaseSync(dbPath);
  dropUsage.exec('DROP TABLE memory_usage');
  dropUsage.close();

  // Read-only store WITHOUT trackUsage must NEVER mutate disk or create memory_usage
  const beforeMtime = (await stat(dbPath)).mtimeMs;
  const ro = new MemoryStore(dbPath, { readOnly: true });
  assert.equal((await ro.search('Legacy service')).results.length, 2);
  assert.equal(ro.get('legacy-1')?.id, 'legacy-1');
  ro.close();
  assert.equal((await stat(dbPath)).mtimeMs, beforeMtime);

  // 2. CLI `kb lint` handles legacy DB cleanly without memory_usage and catches the conflict
  const legacyLint = await runCliJson(root, 'kb', 'lint', '--scope', 'project');
  assert.equal(legacyLint.summary.episodic_total, 2);
  assert.ok(legacyLint.findings.some(item => item.category === 'potential_conflict'));

  // 3. CLI `search` + `kb get --pick` lazily initializes memory_usage and tracks hits/reads
  const readsFile = join(root, 'cli-reads.json');
  const searchOut = await runCliJson(root, 'search', 'Legacy service', '--from', 'kb', '--reads', readsFile);
  assert.ok(searchOut.search_id);
  const picked = await runCliJson(root, 'kb', 'get', '--pick', '1', '--reads', readsFile);
  assert.ok(picked.id);

  const verifyStore = new MemoryStore(dbPath, { readOnly: true });
  const usage = verifyStore.getUsage(picked.id);
  verifyStore.close();
  assert.ok(usage && usage.searchHits >= 1 && usage.readCount >= 1);

  // 4. Direct classification API sanity check
  const rel = classifyKnowledgeRelation('Legacy service must use TLS 1.3.', 'Legacy service must not use TLS 1.3.');
  assert.equal(rel?.relation, 'conflict');

  // 5. CLI cleanup of conflicting legacy-2 -> clean lint
  await runCliJson(root, 'kb', 'delete', 'legacy-2');
  const finalLint = await runCliJson(root, 'kb', 'lint', '--scope', 'project');
  assert.equal(finalLint.summary.findings_total, 0);
});
