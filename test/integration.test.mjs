import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CodeGraph, KnowledgeReads, MemoryStore, Wiki, applySkillDesign, context, createSearchServer,
  createSkillDesignTask, decideSkillRoute, draftSkillAddition, replaySkillDesign, reviewSession,
  reviewSkillDesign, runSkillDesign, search,
} from 'self-evolving-workflow';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const workflowCli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));

async function temp(t, close = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-memory-'));
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function cliJson(root, ...args) {
  const { stdout } = await run(process.execPath, [cli, '--root', root, ...args], { encoding: 'utf8' });
  return JSON.parse(stdout);
}

async function evolveJson(root, ...args) {
  const { stdout } = await run(process.execPath, [workflowCli, '--root', root, ...args], { encoding: 'utf8' });
  return JSON.parse(stdout);
}

test('Skill evolution replays a failed and a passing case, applies the verified commit, and rolls it back', async t => {
  const root = await temp(t);
  const support = await temp(t);
  const git = (...args) => run('git', args, { cwd: root });
  await git('init', '-q');
  await git('config', 'user.name', 'Evolve test');
  await git('config', 'user.email', 'evolve-test@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  const entry = join(root, 'skills', 'example', 'SKILL.md');
  await mkdir(join(root, 'skills', 'example'), { recursive: true });
  const original = '---\nname: example\n---\n\n# Example\n';
  await writeFile(entry, original);
  await git('add', '.');
  await git('commit', '-qm', 'Initial Skill');
  const runner = join(support, 'runner.mjs');
  await writeFile(runner, [
    "import {readFileSync} from 'node:fs';",
    "import {createHash} from 'node:crypto';",
    "const {entry,input} = JSON.parse(readFileSync(0, 'utf8'));",
    'const body = readFileSync(entry);',
    "const sha256 = createHash('sha256').update(body).digest('hex');",
    "console.log(JSON.stringify({passed: input === 'existing' || body.includes('Verify preflight.'),loaded:[{path: entry,sha256}],knowledge_reads:{schema_version:'knowledge-reads/1.0',constraints_bound:[],searches:[{search_id:'search-1',source:'memory',query:'preflight',filters:{scene:'execute'},returned_ids:['memory-preflight'],total_hits:1}],reads:[{kind:'memory',id:'memory-preflight',from_search_id:'search-1',version:1}]}}));",
  ].join('\n'));
  const draft = join(support, 'draft.json');
  const scenarios = join(support, 'scenarios.json');
  await writeFile(draft, JSON.stringify(draftSkillAddition({
    entry, priority: 'high', instruction: 'Verify preflight.', sources: ['receipt:preflight'],
  })));
  await writeFile(scenarios, JSON.stringify([
    { id: 'missing-preflight', input: 'reproduce', baseline: false, knowledge_reads: { searched_sources: ['memory'], loaded_ids: ['memory-preflight'] } },
    { id: 'existing-flow', input: 'existing', baseline: true },
  ]));
  const receipt = await evolveJson(root, 'skills', 'replay', draft, '--runner', runner, '--scenarios', scenarios);
  assert.equal(await readFile(entry, 'utf8'), original);
  assert.deepEqual(receipt.scenarios.map(item => [item.baseline.passed, item.candidate.passed]), [[false, true], [true, true]]);
  await writeFile(entry, original + '\nLocal edit.\n');
  await assert.rejects(cliJson(root, 'evolve', 'apply', receipt.id), /local changes/);
  await writeFile(entry, original);
  const applied = await cliJson(root, 'evolve', 'apply', receipt.id);
  assert.equal(applied.commit, receipt.candidate);
  assert.match(await readFile(entry, 'utf8'), /Verify preflight/);
  assert.equal((await cliJson(root, 'evolve', 'apply', receipt.id)).replayed, true);
  await cliJson(root, 'evolve', 'rollback', receipt.id);
  assert.equal(await readFile(entry, 'utf8'), original);
  assert.equal((await cliJson(root, 'evolve', 'rollback', receipt.id)).replayed, true);
});

test('CodeGraph indexes real TypeScript, resolves call edges, and syncs edits', async t => {
  const root = await temp(t);
  const path = join(root, 'billing.ts');
  await writeFile(path, 'export function computeTax(value: number) { return value * .06; }\nexport function invoiceTotal(value: number) { return value + computeTax(value); }\n');
  const stats = await cliJson(root, 'code', 'build');
  assert.equal(stats.filesErrored, 0);
  const [tax] = await cliJson(root, 'code', 'search', 'computeTax');
  assert.equal(tax.node.name, 'computeTax');
  assert.equal(tax.node.filePath, 'billing.ts');
  const graph = new CodeGraph(root);
  const [{ node: invoice }] = await graph.neighbors(tax.node.id, 'callers');
  assert.equal(invoice.name, 'invoiceTotal');
  assert.equal((await graph.neighbors(invoice.id, 'callees'))[0].node.id, tax.node.id);
  assert.deepEqual((await graph.trace(invoice.id, tax.node.id, ['calls'])).map(step => step.node.id), [invoice.id, tax.node.id]);
  await writeFile(path, 'export function newBillingTotal() { return 42; }\n');
  await graph.sync();
  assert.equal((await graph.search('newBillingTotal'))[0].node.name, 'newBillingTotal');
  assert.equal((await graph.search('computeTax')).some(hit => hit.node.name === 'computeTax'), false);
  await rm(path);
  assert.equal((await graph.build()).fileCount, 0);
  assert.deepEqual(await graph.search('newBillingTotal'), []);
});

test('Evolve shares Wiki and memory with agent-memory and automatically refreshes code queries', async t => {
  const root = join(await temp(t), 'project with spaces');
  await mkdir(join(root, 'wiki'), { recursive: true });
  await writeFile(join(root, 'wiki', 'billing.md'), '# Billing guide\n\nCheck taxes before invoicing.\n');
  const source = join(root, 'billing.ts');
  await writeFile(source, 'export function computeTax(value: number) { return value * .06; }\n');
  await evolveJson(root, 'wiki', 'build');
  assert.equal((await cliJson(root, 'wiki', 'search', 'billing')).results[0].id, 'billing');
  const memory = await evolveJson(root, 'memory', 'put', 'Check taxes before invoicing.', '--id', 'billing-check');
  assert.deepEqual(await cliJson(root, 'memory', 'get', 'billing-check'), memory);
  const contextArgs = ['context', 'taxes', '--include-memory', '--path', 'billing.ts', '--path', 'wiki/billing.md'];
  assert.deepEqual(await evolveJson(root, ...contextArgs), await cliJson(root, ...contextArgs));
  await assert.rejects(evolveJson(root, 'code', 'search', 'computeTax', '--limit', '0'), /limit must be an integer/);
  await assert.rejects(cliJson(root, 'code', 'search', 'computeTax'), /Code index missing/);
  await assert.rejects(access(join(root, '.codegraph')), { code: 'ENOENT' });

  const { stdout } = await run(process.execPath, [workflowCli, 'search', 'computeTax', '--scope', 'code', '--root', root]);
  const [{ node: tax }] = JSON.parse(stdout).code;
  assert.equal(tax.name, 'computeTax');
  assert.equal((await cliJson(root, 'code', 'search', 'computeTax'))[0].node.id, tax.id);

  const invoice = join(root, 'invoice.ts');
  await writeFile(invoice, "import { computeTax } from './billing';\nexport function invoiceTotal(value: number) { return value + computeTax(value); }\n");
  const callers = await evolveJson(root, 'code', 'callers', tax.id);
  const caller = callers.find(({ node }) => node.name === 'invoiceTotal')?.node;
  assert.ok(caller, `Expected invoiceTotal among ${callers.map(({ node }) => node.name).join(', ')}`);
  assert.ok((await evolveJson(root, 'code', 'callees', caller.id)).some(({ node }) => node.id === tax.id));
  assert.deepEqual((await evolveJson(root, 'code', 'trace', caller.id, tax.id)).map(step => step.node.id), [caller.id, tax.id]);
  await writeFile(source, 'export function computeFee(value: number) { return value * .1; }\n');
  await rm(invoice);
  assert.equal((await evolveJson(root, 'search', 'computeFee')).code[0].node.name, 'computeFee');
  assert.ok(!(await cliJson(root, 'code', 'search', 'computeTax')).some(({ node }) => node.name === 'computeTax'));
  assert.deepEqual(await cliJson(root, 'code', 'search', 'invoiceTotal'), []);
});

test('Opening a Git project Session initializes and incrementally refreshes its code graph', async t => {
  const root = await temp(t);
  await run('git', ['init', '-q'], { cwd: root });
  const open = id => evolveJson(root, 'session', 'open', 'Use the project code graph', '--actor', 'tester', '--id', id);
  const source = join(root, 'cooling.ts');
  await writeFile(source, 'export function initialPumpSpeed() { return 42; }\n');
  assert.equal((await open('initial-index')).status, 'open');
  assert.equal((await cliJson(root, 'code', 'search', 'initialPumpSpeed'))[0].node.name, 'initialPumpSpeed');
  await writeFile(source, 'export function adjustedPumpSpeed() { return 36; }\n');
  assert.equal((await open('incremental-index')).status, 'open');
  assert.equal((await cliJson(root, 'code', 'search', 'adjustedPumpSpeed'))[0].node.name, 'adjustedPumpSpeed');
  assert.deepEqual(await cliJson(root, 'code', 'search', 'initialPumpSpeed'), []);
});

test('Wiki searches CRLF Chinese Markdown, follows links, and removes stale pages', async t => {
  const root = await temp(t);
  await mkdir(join(root, 'wiki', 'concepts'), { recursive: true });
  await writeFile(join(root, 'wiki', 'concepts', 'pump.md'), [
    '---', 'type: concept', 'title: 冷却回路', 'sources: [notes.md]', '---', '', '测试回路压力。[[Heat Exchanger#Design|换热器]]',
  ].join('\r\n'));
  const exchanger = join(root, 'wiki', 'exchanger.md');
  await writeFile(exchanger, '# Heat Exchanger\n\nUses a plate assembly. [[concepts/pump]]\n');
  const wiki = new Wiki(root);
  assert.deepEqual(await cliJson(root, 'wiki', 'build'), { pages: 2, edges: 2 });
  const { results, links } = await cliJson(root, 'wiki', 'search', '回路压力', '--hop', '1');
  assert.equal(results[0].path, 'wiki/concepts/pump.md');
  assert.deepEqual(results[0].sources, ['notes.md']);
  assert.equal(results[0].related[0].id, 'exchanger');
  assert.equal(results[0].related[0].direction, 'both');
  assert.equal(results[1].via, '冷却回路');
  assert.equal(results[1].hop, 1);
  assert.equal(links.length, 2);
  await rm(exchanger);
  assert.deepEqual(wiki.build(), { pages: 1, edges: 0 });
  assert.equal(wiki.search('回路压力', { hop: 1 }).results.length, 1);
});

test('managed Wiki entries resolve active scopes independently of search and preserve history', async t => {
  const root = await temp(t);
  const directory = join(root, 'wiki', 'entries');
  await mkdir(directory, { recursive: true });
  const entry = (title, mode, status, scope, aliases = []) => [
    '---', `title: ${title}`, `mode: ${mode}`, `status: ${status}`, `scope: ${JSON.stringify(scope)}`,
    'sources: [receipt-1]', `aliases: ${JSON.stringify(aliases)}`, '---',
    'Calibration preflight. [[entries/retired]]',
  ].join('\n');
  await writeFile(join(directory, 'required.md'), entry('Calibration', 'constraint', 'active', ['skill:analyze'], ['legacy:spec:S-42']));
  await writeFile(join(directory, 'source-rule.md'), entry('Source calibration', 'constraint', 'active', ['skill:analyze', 'path:src/**']));
  await writeFile(join(directory, 'retired.md'), entry('Old calibration', 'constraint', 'deprecated', ['project']));
  await writeFile(join(directory, 'reference.md'), entry('Calibration notes', 'reference', 'active', ['project']));
  const wiki = new Wiki(root);
  assert.deepEqual(wiki.constraints(), []);
  assert.deepEqual(await cliJson(root, 'wiki', 'constraints', '--skill', 'ew-analyze'), []);
  assert.deepEqual(wiki.constraints({ paths: ['src/gauge.ts'] }).map(page => page.id), ['entries/source-rule']);
  assert.deepEqual(wiki.constraints({ includePathScoped: true }).map(page => page.id), ['entries/source-rule']);
  assert.equal(wiki.getEntry('legacy:spec:S-42').id, 'entries/required');
  assert.equal(wiki.getEntry('retired').entry.status, 'deprecated');
  wiki.build();
  assert.equal(wiki.search('calibration', { hop: 1 }).results.some(hit => hit.id === 'entries/retired'), false);
  assert.equal(wiki.search('calibration', { includeHistory: true }).results.some(hit => hit.id === 'entries/retired'), true);
});

test('Wiki proposals publish by stable ID, recover interrupted writes, and reject stale changes', async t => {
  const root = await temp(t);
  const draft = join(root, 'change.json');
  const propose = async (value, evidence) => {
    await writeFile(draft, JSON.stringify(value));
    return cliJson(root, 'wiki', 'propose', draft, '--evidence', evidence);
  };
  const entry = 'entries/preflight';
  const page = join(root, 'wiki', 'entries', 'preflight.md');
  await assert.rejects(propose({
    operation: 'create', entry, title: 'Migration preflight', mode: 'reference',
    scope: ['skill:migration'], body: 'Verify the database dry-run before applying.',
  }, 'design:preflight'), /Use project, task:<kind>, or path:<glob>/);
  const create = await propose({
    operation: 'create', entry, title: 'Migration preflight', mode: 'reference',
    scope: ['task:migration'], body: 'Verify the database dry-run before applying.',
  }, 'design:preflight');
  assert.equal(create.state, 'pending');
  await assert.rejects(readFile(page), { code: 'ENOENT' });
  const concurrent = await Promise.all([
    cliJson(root, 'wiki', 'apply', create.id), cliJson(root, 'wiki', 'apply', create.id),
  ]);
  assert.ok(concurrent.every(change => change.state === 'applied'));
  assert.deepEqual(concurrent.map(change => change.replayed).sort(), [false, true]);
  assert.deepEqual(await cliJson(root, 'wiki', 'constraints', '--task', 'migration'), []);
  const stale = await propose({ operation: 'update', entry, title: 'Obsolete title' }, 'review:1');
  const promote = await propose({ operation: 'promote', entry, title: 'Verified migration preflight' }, 'review:2');
  assert.equal(promote.before, await readFile(page, 'utf8'));
  assert.equal((await cliJson(root, 'wiki', 'apply', promote.id)).replayed, false);
  await assert.rejects(cliJson(root, 'wiki', 'apply', stale.id), /changed since review/);
  assert.equal((await cliJson(root, 'wiki', 'constraints', '--task', 'migration'))[0].id, entry);
  assert.deepEqual(await cliJson(root, 'wiki', 'constraints', '--task', 'deploy'), []);
  const retire = await propose({ operation: 'retire', entry }, 'review:retire');
  const db = new DatabaseSync(join(root, '.agent-memory', 'closeout.db'));
  // Reproduce a crash after committing the application intent and replacing the page.
  db.prepare("UPDATE wiki_changes SET state = 'applying' WHERE id = ?").run(retire.id);
  db.close();
  await writeFile(page, retire.after);
  assert.equal((await cliJson(root, 'wiki', 'apply', retire.id)).state, 'applied');
  assert.equal((await cliJson(root, 'wiki', 'apply', retire.id)).replayed, true);
  assert.deepEqual(await cliJson(root, 'wiki', 'constraints', '--task', 'migration'), []);
  assert.equal((await cliJson(root, 'wiki', 'get', entry)).entry.status, 'deprecated');
  const history = await cliJson(root, 'wiki', 'changes', '--entry', entry);
  assert.deepEqual(history.map(change => change.state), ['applied', 'pending', 'applied', 'applied']);
  assert.equal(history.at(-1).before, promote.after);
  assert.equal(history.at(-1).baseline_sha256, promote.result_sha256);
});

test('legacy Wiki migration is previewable, idempotent, and preserves constraint provenance', async t => {
  const legacy = await temp(t);
  const root = await temp(t);
  await mkdir(join(legacy, '.workflow', 'specs'), { recursive: true });
  await mkdir(join(legacy, '.workflow', 'knowhow'), { recursive: true });
  await writeFile(join(legacy, '.workflow', 'specs', 'runtime.md'), [
    '<spec-entry title="Current" sid="S-1" keywords="Sensor, calibration">', 'Check the current calibration.', '</spec-entry>',
    '<spec-entry title="Old" sid="S-2" status="deprecated" superseded-by="S-1">', 'Use the old calibration.', '</spec-entry>',
    '<spec-entry title="Disputed" confidence="contested">', 'Check the disputed calibration.', '</spec-entry>',
    '<spec-entry title="Gauge reference" sid="S-3" ref="knowhow/K-1.md">', 'Background on the gauge.', '</spec-entry>',
    '<spec-entry title="Missing reference" sid="S-4" ref="knowhow/missing.md">', 'Missing background.', '</spec-entry>',
  ].join('\n'));
  await writeFile(join(legacy, '.workflow', 'specs', 'coding.md'), '# Coding rules\n\nKeep calibration checks deterministic.\n');
  await writeFile(join(legacy, '.workflow', 'specs', 'scoped.md'), [
    '---', 'appliesToRepoIds: []', '---', '# Scoped rules', '',
    '<spec-entry title="Scoped &lt;rule&gt;" sid="S-5">', 'Use a calibrated sensor.', '</spec-entry>',
  ].join('\n'));
  const repository = 'cd7083c9-6e35-4509-99ad-79adb4ab6404';
  await writeFile(join(legacy, '.workflow', 'specs', 'architecture-constraints.md'), [
    '---', `appliesToRepoIds: [${repository}]`, '---', '# Architecture', '',
    '<spec-entry title="Sensor boundary" sid="S-6" category="review">', 'Validate the sensor boundary.', '</spec-entry>',
  ].join('\n'));
  await writeFile(join(legacy, '.workflow', 'knowhow', 'K-1.md'), '---\ntitle: Calibration tips\n---\n\nInspect the gauge.\n');
  const args = ['wiki', 'migrate', legacy, '--project', 'legacy-project'];
  const preview = await cliJson(root, ...args);
  assert.equal(preview.length, 9);
  assert.deepEqual(await cliJson(root, ...args, '--knowhow-only'),
    preview.filter(row => row.origin.startsWith('.workflow/knowhow/')));
  await assert.rejects(cliJson(root, ...args, '--scope', 'team', '--knowhow-only'),
    /--knowhow-only requires project or global scope/);
  const wiki = new Wiki(root);
  assert.deepEqual(wiki.constraints(), []);
  assert.deepEqual(await cliJson(root, ...args, '--apply'), preview);
  assert.ok((await cliJson(root, ...args, '--apply')).every(row => row.existing));
  assert.deepEqual(wiki.constraints().map(row => row.title).sort(), ['Coding rules', 'Current']);
  assert.match(wiki.getEntry('legacy-project:spec:S-2').body, /Superseding entry/);
  const knowhow = wiki.getEntry('legacy-project:knowhow:K-1');
  assert.equal(knowhow.entry.mode, 'reference');
  const linked = wiki.getEntry('legacy-project:spec:S-3');
  assert.equal(linked.entry.mode, 'reference');
  assert.ok(linked.body.includes(`[[${knowhow.id}|Legacy reference]]`));
  const missing = preview.find(row => row.alias === 'legacy-project:spec:S-4');
  assert.equal(missing.status, 'needs_review');
  assert.deepEqual(missing.issues, ['Unresolved legacy reference']);
  const scoped = wiki.getEntry('legacy-project:spec:S-5');
  assert.equal(scoped.title, 'Scoped <rule>');
  assert.equal(scoped.entry.status, 'needs_review');
  assert.deepEqual(scoped.sources, ['legacy:legacy-project:.workflow/specs/scoped.md#L6']);
  const arch = await cliJson(root, 'wiki', 'constraints', '--category', 'arch', '--repository', repository);
  assert.deepEqual(arch.map(rule => rule.title), ['Sensor boundary']);
  assert.deepEqual(arch[0].entry.repositories, [repository]);
  assert.deepEqual(await cliJson(root, 'wiki', 'constraints', '--category', 'arch'), []);
  assert.deepEqual(await cliJson(root, 'wiki', 'constraints', '--category', 'review', '--repository', repository), []);
  assert.deepEqual((await cliJson(root, 'wiki', 'constraints', '--category', 'coding')).map(rule => rule.title), ['Coding rules']);
  const constrained = (category, keyword) => cliJson(root, 'wiki', 'constraints', '--category', category, '--keyword', keyword);
  assert.deepEqual((await constrained('arch', 'SENSOR')).map(rule => rule.title), ['Current']);
  assert.deepEqual((await constrained('coding', 'CALIBRATION')).map(rule => rule.title).sort(), ['Coding rules', 'Current']);
  assert.deepEqual(await constrained('arch', 'current'), []);
  assert.deepEqual(await constrained('arch', 'deterministic'), []);
  const migratedCurrent = join(root, 'wiki', 'entries', `${preview.find(row => row.alias === 'legacy-project:spec:S-1').id}.md`);
  const canonical = await readFile(migratedCurrent, 'utf8');
  await writeFile(migratedCurrent, canonical.replace(/^keywords:\n(?:  - [^\n]+\n)+/m, ''));
  assert.notEqual(await readFile(migratedCurrent, 'utf8'), canonical);
  assert.deepEqual((await constrained('arch', 'sensor')).map(rule => rule.title), ['Current']);
  assert.ok((await cliJson(root, ...args, '--apply')).every(row => row.existing));
});

test('legacy Knowhow migration resolves Maestro lifecycle IDs and multiple predecessors', async t => {
  const legacy = await temp(t);
  const root = await temp(t);
  const knowhow = join(legacy, '.workflow', 'knowhow');
  await mkdir(knowhow, { recursive: true });
  for (const [id, lifecycle] of [
    ['TIP-1', 'status: deprecated\nsupersededBy: knowhow-tip-3'],
    ['TIP-2', 'status: deprecated\nsupersededBy: knowhow-tip-3'],
    ['TIP-3', 'status: active\nsupersedes: [knowhow-tip-1, TIP-1, knowhow-tip-2]'],
    ['TIP-4', 'status: active\nsupersedes: [knowhow-tip-1, knowhow-missing]'],
  ]) {
    await writeFile(join(knowhow, id + '.md'), `---\nid: ${id}\ntitle: ${id}\n${lifecycle}\n---\n\nKnowledge body.\n`);
  }
  const args = ['wiki', 'migrate', legacy, '--project', 'legacy-project', '--knowhow-only'];
  const preview = await cliJson(root, ...args);
  const [first, second, current, partial] = preview;
  assert.deepEqual(preview.map(row => row.status), ['deprecated', 'deprecated', 'active', 'needs_review']);
  assert.deepEqual(partial.issues, ['Unresolved earlier entry']);
  assert.deepEqual(await cliJson(root, ...args, '--apply'), preview);
  const wiki = new Wiki(root);
  assert.equal(wiki.getEntry(current.id).body.trim(),
    `Knowledge body.\n\n[[entries/${first.id}|Earlier entry]]\n[[entries/${second.id}|Earlier entry]]`);
  assert.ok(wiki.getEntry(first.id).body.includes(`[[entries/${current.id}|Superseding entry]]`));
  assert.ok(wiki.getEntry(partial.id).body.includes(`[[entries/${first.id}|Earlier entry]]`));
});

test('Evolve imports legacy knowledge into the source project or an explicit global destination', async t => {
  const project = await temp(t);
  const globalSource = await temp(t);
  const globalDestination = await temp(t);
  const workflowCli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
  const migrate = async (...args) => JSON.parse((await run(process.execPath,
    [workflowCli, 'knowledge', 'import', ...args], { cwd: project, encoding: 'utf8' })).stdout);

  for (const source of [join(project, '.workflow'), globalSource]) {
    await mkdir(join(source, 'specs'), { recursive: true });
    await mkdir(join(source, 'knowhow'));
    await writeFile(join(source, 'specs', 'test-conventions.md'),
      '<spec-entry title="Calibration gate" sid="S-1">Run the calibration check.</spec-entry>\n');
    await writeFile(join(source, 'knowhow', 'K-1.md'), '# Calibration method\n\nInspect the calibration gauge.\n');
  }
  const preview = await migrate();
  assert.equal(preview.applied, false);
  assert.equal(preview.new_entries, 2);
  assert.deepEqual(new Wiki(project).constraints(), []);
  const knowhowPreview = await migrate('--knowhow-only');
  assert.equal(knowhowPreview.applied, false);
  assert.deepEqual(knowhowPreview.entries, preview.entries.filter(row => row.origin.startsWith('.workflow/knowhow/')));
  const knowhowApplied = await migrate(project, '--knowhow-only', '--apply');
  assert.equal(knowhowApplied.applied, true);
  assert.equal(knowhowApplied.new_entries, 1);
  assert.deepEqual(knowhowApplied.entries, knowhowPreview.entries);
  assert.deepEqual(new Wiki(project).constraints(), []);
  assert.equal((await migrate('--knowhow-only')).existing_entries, 1);
  const applied = await migrate(project, '--apply');
  assert.equal(applied.project, preview.project);
  assert.equal(applied.new_entries, 1);
  assert.equal(applied.existing_entries, 1);
  assert.deepEqual(applied.entries.map(row => row.id), preview.entries.map(row => row.id));
  assert.equal((await migrate('--apply')).existing_entries, 2);
  const projectContext = await cliJson(project, 'context', 'calibration');
  assert.deepEqual(projectContext.constraints.map(entry => entry.title), ['Calibration gate']);
  assert.deepEqual(projectContext.references.map(entry => entry.title), ['Calibration method']);
  const globalKnowhow = await migrate(globalSource, '--global', '--root', globalDestination, '--knowhow-only');
  assert.equal(globalKnowhow.applied, false);
  assert.deepEqual(globalKnowhow.entries.map(row => row.origin), ['knowhow/K-1.md']);
  const global = await migrate(globalSource, '--global', '--root', globalDestination, '--apply');
  assert.equal(global.new_entries, 2);
  assert.equal(global.scope, 'global');
  assert.equal(global.entries.find(row => row.origin === 'knowhow/K-1.md').id, globalKnowhow.entries[0].id);
  assert.deepEqual((await cliJson(globalDestination, 'context', 'calibration')).references.map(entry => entry.title),
    ['Calibration method']);
});

test('Evolve installs selected Skills and their workflow files without replacing project instructions', async t => {
  const root = await temp(t);
  const workflowCli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
  const evolve = async (...args) => (await run(process.execPath, [workflowCli, ...args], { cwd: root, encoding: 'utf8' })).stdout;
  const guidance = join(root, 'AGENTS.md');
  const original = '# Project instructions\r\n\r\nUse the release branch.\r\n';
  await writeFile(guidance, original);

  const installArgs = ['install', '--scope', 'project', '--skill', 'ew-odyssey', '--yes'];
  const installed = JSON.parse(await evolve(...installArgs));
  assert.deepEqual(installed.installed, ['ew-orchestrate', 'ew-odyssey']);
  assert.ok(installed.workflows.some(item => item.id === 'ew-odyssey-review'));
  const after = await readFile(guidance, 'utf8');
  assert.ok(after.startsWith(original));
  assert.match(after, /evolve context/);
  assert.deepEqual(JSON.parse(await evolve(...installArgs)).kept, installed.installed);
  assert.equal(await readFile(guidance, 'utf8'), after);

  const workflows = JSON.parse(await evolve('workflows'));
  assert.equal(new Set(workflows.map(workflow => workflow.id)).size, workflows.length);
  const review = workflows.find(item => item.id === 'ew-odyssey-review');
  assert.equal(await evolve('workflows', 'show', review.id), await readFile(join(root, review.path), 'utf8'));
  await assert.rejects(evolve('workflows', 'show', '../AGENTS.md'), /Unknown workflow/);
  await mkdir(join(root, 'skills', 'team-swarm'));
  await assert.rejects(evolve('install', '--skill', 'team-swarm', '--yes'), /no SKILL.md/);

  const home = await temp(t);
  const agyInstalled = JSON.parse((await run(
    process.execPath,
    [workflowCli, 'install', '--scope', 'user', '--host', 'agy', '--skill', 'ew-knowledge', '--yes'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } },
  )).stdout);
  assert.equal(agyInstalled.root, join(home, '.gemini', 'config'));
  assert.equal(agyInstalled.instructions, join(home, '.gemini', 'AGENTS.md'));
  assert.deepEqual(agyInstalled.installed, ['ew-knowledge']);
  await access(join(home, '.gemini', 'config', 'skills', 'ew-knowledge', 'SKILL.md'));
  assert.match(await readFile(join(home, '.gemini', 'AGENTS.md'), 'utf8'), /evolve context/);
});

test('Evolve installs OMP user Skills without replacing existing Skills or instructions', async t => {
  const root = await temp(t);
  const home = await temp(t);
  const target = join(home, '.omp', 'agent');
  const guidance = join(target, 'AGENTS.md');
  const original = '# User instructions\r\n\r\nKeep local release conventions.\r\n';
  await mkdir(target, { recursive: true });
  await writeFile(guidance, original);
  const evolve = async (...args) => JSON.parse((await run(
    process.execPath, [workflowCli, ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } },
  )).stdout);
  const args = ['install', '--scope', 'user', '--host', 'omp', '--skill', 'ew-knowledge', '--yes'];
  const installed = await evolve(...args);
  assert.equal(installed.status, 'installed');
  assert.equal(installed.scope, 'user');
  assert.equal(installed.host, 'omp');
  assert.equal(installed.root, target);
  assert.equal(installed.instructions, guidance);
  assert.deepEqual(installed.installed, ['ew-knowledge']);
  const entry = join(target, 'skills', 'ew-knowledge', 'SKILL.md');
  const skill = await readFile(entry, 'utf8');
  assert.equal(skill, await readFile(new URL('../skills/ew-knowledge/SKILL.md', import.meta.url), 'utf8'));
  assert.match(skill, /(?:^|\n)description:/);
  const after = await readFile(guidance, 'utf8');
  assert.ok(after.startsWith(original));
  assert.match(after, /evolve context/);
  const customized = skill + '\nLocal Skill instructions must survive reinstall.\n';
  await writeFile(entry, customized);
  const repeated = await evolve(...args);
  assert.deepEqual(repeated.installed, []);
  assert.deepEqual(repeated.kept, ['ew-knowledge']);
  assert.equal(await readFile(entry, 'utf8'), customized);
  assert.equal(await readFile(guidance, 'utf8'), after);
  assert.equal((await evolve('install', '--host', 'omp', '--skill', 'ew-knowledge', '--yes')).scope, 'user');
  await assert.rejects(evolve('install', '--scope', 'project', '--host', 'omp', '--yes'), /--host applies to user installations/);
  await assert.rejects(access(join(root, 'skills')));
});

test('completion harvesting preserves evidence and records zero-candidate receipts', async t => {
  const root = await temp(t);
  const { harvestCompletion, publishReference } = await import('../dist/closeout.js');
  const wiki = new Wiki(root);
  let calls = 0;
  const model = () => ({
    async chat() {
      calls++;
      return JSON.stringify([{ memories: [
        { content: 'Check the preflight flag before migration.', source_message_ids: ['check'] },
        { content: 'An unsupported claim.', source_message_ids: ['absent'] },
      ] }]);
    },
  });
  const receipt = {
    schema_version: 'skill-completion/1.0',
    id: 'completion-1',
    execution_id: 'execution-1',
    status: 'succeeded',
    recorded_at: '2026-11-13T02:00:00Z',
    messages: [{ id: 'check', role: 'tool', timestamp: '2026-11-13T01:00:00Z', content: 'Preflight passed.' }],
  };
  const first = await harvestCompletion(wiki, 'example', receipt, model);
  assert.equal(first.candidates.length, 1);
  assert.deepEqual(first.candidates[0].sources, ['receipt:example:completion-1#check']);
  assert.deepEqual(await harvestCompletion(wiki, 'example', receipt, model), { ...first, replayed: true });
  const empty = { ...receipt, id: 'completion-2', messages: [] };
  assert.deepEqual((await harvestCompletion(wiki, 'example', empty, model)).candidates, []);
  assert.equal((await harvestCompletion(wiki, 'example', empty, model)).replayed, true);
  assert.equal(calls, 1);
  const published = publishReference(wiki, first.id, first.candidates[0].id, 'Migration preflight');
  assert.equal(wiki.getEntry(published.id).entry.mode, 'reference');
  assert.deepEqual(publishReference(wiki, first.id, first.candidates[0].id, 'Migration preflight'), { ...published, replayed: true });
  const corroboration = { ...receipt, id: 'completion-3' };
  assert.deepEqual((await harvestCompletion(wiki, 'example', corroboration, model)).candidates, []);
  assert.deepEqual(wiki.getEntry(published.id).sources, [
    'receipt:example:completion-1#check', 'receipt:example:completion-3#check',
  ]);
});

test('conflicting closeout evidence stays pending until a reviewed Wiki change is applied', async t => {
  const root = await temp(t);
  const { harvestCompletion, publishReference } = await import('../dist/closeout.js');
  const wiki = new Wiki(root);
  const draft = join(root, 'change.json');
  const entry = 'entries/preflight';
  await writeFile(draft, JSON.stringify({
    operation: 'create', entry, title: 'Migration dry-run',
    mode: 'constraint', body: 'Always use a dry-run before applying a database migration.',
  }));
  const original = await cliJson(root, 'wiki', 'propose', draft, '--evidence', 'policy:preflight');
  await cliJson(root, 'wiki', 'apply', original.id);
  const completion = {
    schema_version: 'skill-completion/1.0', id: 'evidence-conflict', execution_id: 'exec-1', status: 'succeeded',
    recorded_at: '2026-11-13T02:00:00Z',
    messages: [{ id: 'check', role: 'tool', timestamp: 0, content: 'The isolated database migration succeeded without a dry-run.' }],
  };
  let compared = false;
  const harvested = await harvestCompletion(wiki, 'example', completion, () => ({ async chat({ label, prompt }) {
    if (label === 'wiki-closeout-compare') {
      compared = true;
      assert.equal(JSON.parse(prompt).entries[0].id, entry);
      return JSON.stringify([{ id: entry, relation: 'conflict' }, { id: 'entries/unknown', relation: 'conflict' }]);
    }
    return JSON.stringify([{ memories: [{
      type: 'work_method', content: 'Skip the dry-run for an isolated test database migration.', source_message_ids: ['check'],
    }] }]);
  } }));
  assert.equal(compared, true);
  const [candidate] = harvested.candidates;
  assert.deepEqual(candidate.related_entries, [{ id: entry, relation: 'conflict', sources: ['policy:preflight'] }]);
  assert.equal(wiki.getEntry(entry).body.trim(), 'Always use a dry-run before applying a database migration.');
  assert.throws(() => publishReference(wiki, harvested.id, candidate.id, 'Conflict'), /related Wiki entries/);
  const update = { operation: 'update', entry, body: 'Use dry-run for production database migration.' };
  const proposeArgs = ['wiki', 'propose', draft, '--closeout', harvested.id, '--candidate', candidate.id];
  await writeFile(draft, JSON.stringify(update));
  await assert.rejects(cliJson(root, ...proposeArgs), /requires a recorded relationship decision/);
  await writeFile(draft, JSON.stringify({
    ...update, review: { relationship: 'conflict', rationale: 'The isolated test result supports a narrower production rule.' },
  }));
  const reviewed = await cliJson(root, ...proposeArgs);
  assert.deepEqual(reviewed.review.related, [entry]);
  assert.deepEqual(reviewed.candidate, { closeout: harvested.id, id: candidate.id });
  await cliJson(root, 'wiki', 'apply', reviewed.id);
  assert.deepEqual(wiki.getEntry(entry).sources, ['policy:preflight', 'receipt:example:evidence-conflict#check']);
});

test('standalone Skill completion survives a failed harvest and is reconciled once', async t => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.match(body.messages[1].content, /Dry-run passed/);
    if (body.messages[0].content.includes('Review the execution timeline')) {
      const source = /receipt:fixture-project:skill-[a-f0-9]{64}#verified/.exec(body.messages[1].content)?.[0];
      assert.ok(source);
      const result = [{ memories: [
        { type: 'verified_fix', content: 'Dry-run passed.', source_message_ids: [source] },
        { type: 'error', content: 'An unsourced claim.', source_message_ids: ['absent'] },
      ] }];
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
      return;
    }
    if (++calls === 1) {
      response.writeHead(503).end();
      return;
    }
    const result = [{
      memories: [{ content: 'Use dry-run before applying a migration.', source_message_ids: ['verified'] }],
    }];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  const root = await temp(t, () => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = {
    ...process.env, AGENT_MEMORY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    AGENT_MEMORY_LLM_MODEL: 'fixture',
  };
  const invoke = async args => JSON.parse((await run(process.execPath,
    [cli, '--root', root, ...args, '--project', 'fixture-project'], { env })).stdout);
  const transcript = join(root, 'evidence.json');
  await writeFile(transcript, JSON.stringify([
    { id: 'verified', role: 'tool', timestamp: 0, content: 'Dry-run passed.' },
  ]));
  const knowledgeReceipt = join(root, 'knowledge-reads.json');
  await writeFile(knowledgeReceipt, JSON.stringify({
    schema_version: 'knowledge-reads/1.0', constraints_bound: [],
    searches: [{ search_id: 'search-1', source: 'memory', query: 'migration retry', filters: { scene: 'execute' }, returned_ids: ['memory-1'], total_hits: 1 }],
    reads: [{ kind: 'memory', id: 'memory-1', from_search_id: 'search-1', version: 1 }],
  }));
  const args = ['closeout', 'skill', 'host-invocation-1', '--skill', 'db-migration',
    '--skill-version', 'git:abc123', '--status', 'failed', '--transcript', transcript, '--knowledge-receipt', knowledgeReceipt];
  assert.deepEqual(await invoke([...args, '--record-only']), await invoke([...args, '--record-only']));
  const { receipt } = await invoke([...args, '--record-only']);
  assert.equal(calls, 0);
  await assert.rejects(invoke(['closeout', 'resume', 'skill-missing']), /receipt not found/);
  await assert.rejects(invoke(['closeout', 'resume', receipt]), /HTTP 503/);
  const pending = await invoke(['closeout', 'scan']);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].candidates.length, 1);
  const repeated = await invoke(args);
  assert.equal(repeated.id, pending[0].id);
  assert.equal(repeated.replayed, true);
  const harvestedById = await invoke(['closeout', 'harvest', receipt]);
  assert.equal(harvestedById.replayed, true);
  assert.deepEqual(await invoke(['closeout', 'show', repeated.receipt]), {
    id: repeated.id,
    candidates: pending[0].candidates,
    session_id: 'host-invocation-1',
    receipt_id: repeated.receipt,
  });
  assert.equal(calls, 2);
  const review = await invoke(['evolve', 'review', 'host-invocation-1']);
  assert.deepEqual(review.skill, { id: 'db-migration', version: 'git:abc123', status: 'failed' });
  assert.equal(review.receipt, receipt);
  assert.equal(review.evidence, 2);
  assert.deepEqual(review.signals.map(({ kind, sources, runIds }) => [kind, sources, runIds]), [
    ['verified_fix', [`receipt:fixture-project:${receipt}#verified`], []],
  ]);
  await assert.rejects(invoke(['evolve', 'review', 'missing-execution']), /receipt not found/);
  await assert.rejects(invoke([...args, '--status', 'cancelled']), /Skill completion changed/);
  assert.deepEqual(await invoke([...args, '--session', 'maestro-1']), { ignored: 'session-owned', session: 'maestro-1' });
  assert.deepEqual(await invoke([...args, '--skill', 'workflow-closeout']), { ignored: 'maintenance-skill' });
  assert.deepEqual(await invoke([...args, '--skill', 'ew-knowledge']), { ignored: 'maintenance-skill' });
});

test('Session retrospective grounds Skill additions in its original evidence', async t => {
  const root = await temp(t);
  const sessionDirectory = join(root, '.workflow', 'sessions', 'review-1');
  await mkdir(sessionDirectory, { recursive: true });
  const snapshotDir = join(sessionDirectory, 'transcript-evidence');
  await mkdir(snapshotDir);
  const quote = 'The first check skipped the linked workflow.';
  const digest = value => createHash('sha256').update(value).digest('hex');
  const hash = digest(quote);
  const locator = ['codex', 'host-1', 'tool-1'];
  const snapshot = join(snapshotDir, `${hash}-${digest(locator.join('\0')).slice(0, 16)}.json`);
  await writeFile(snapshot, JSON.stringify({
    schema_version: 'transcript-evidence/1.0', sha256: hash, normalized_sha256: hash,
    host_kind: locator[0], host_session_id: locator[1], entry_id: locator[2],
    captured_at: '2026-11-13T01:00:00Z', quote,
  }));
  const message = {
    id: 'correction', role: 'user', timestamp: '2026-11-13T02:00:00Z', content: 'Read the saved workflow before re-running the check.',
  };
  const signals = await reviewSession(root, 'review-1', {
    transcript: [message],
    model: () => ({
      async chat({ system, prompt }) {
        assert.match(system, /user corrections/);
        assert.match(prompt, /Read the saved workflow/);
        assert.match(prompt, /first check skipped the linked workflow/);
        return JSON.stringify([{ memories: [
          { content: message.content, type: 'correction', source_message_ids: ['conversation:review-1#correction'] },
          { content: 'Guess an unobserved clause.', source_message_ids: ['absent'] },
        ] }]);
      },
    }),
  });
  assert.equal(signals.evidence, 2);
  assert.equal(signals.signals.length, 1);
  assert.equal(signals.signals[0].kind, 'correction');
  const entry = join(root, 'SKILL.md');
  const baseline = '---\nname: example\n---\n\n# Example Skill\n';
  await writeFile(entry, baseline);
  const input = { entry, instruction: message.content, sources: signals.signals[0].sources };
  const high = draftSkillAddition({ ...input, priority: 'high' });
  assert.match(high.changes[0].content, /---\n\n<!-- evolve:learning:/);
  assert.equal(high.changes.length, 1);
  const normal = draftSkillAddition({ ...input, priority: 'normal', when: 'resuming a saved run' });
  assert.equal(normal.changes.length, 2);
  assert.match(normal.changes[0].content, /\]\(references\/learnings\//);
  assert.match(normal.changes[0].content, /when resuming a saved run/);
  assert.match(normal.changes[1].content, /conversation:review-1#correction/);
  const low = draftSkillAddition({ ...input, priority: 'low' });
  const [lowEntry, lowDocument, lowIndex] = low.changes;
  assert.equal(lowEntry.path, entry);
  assert.match(lowEntry.content, /\]\(references\/learnings\/index\.md\)/);
  assert.doesNotMatch(lowEntry.content, new RegExp(low.id));
  assert.match(lowIndex.content, new RegExp(`\\]\\(\\./${low.id}\\.md\\)`));
  assert.match(lowDocument.content, /conversation:review-1#correction/);
  assert.equal(await readFile(entry, 'utf8'), baseline);
  await mkdir(join(root, 'references', 'learnings'), { recursive: true });
  for (const { path, content } of low.changes) await writeFile(path, content.replace(/\n/g, '\r\n'));
  assert.deepEqual(draftSkillAddition({ ...input, priority: 'low' }).changes, [lowDocument]);
  const nextLow = draftSkillAddition({ ...input, priority: 'low', instruction: 'Record the next useful case.' });
  assert.equal(nextLow.changes.length, 2);
  assert.equal(nextLow.changes[1].path, lowIndex.path);
  assert.ok(nextLow.changes[1].content.includes(`./${low.id}.md`));
  assert.ok(nextLow.changes[1].content.includes(`./${nextLow.id}.md`));
  await writeFile(lowDocument.path, 'An unrelated existing document.');
  assert.throws(() => draftSkillAddition({ ...input, priority: 'low' }), /Existing Skill learning document differs/);
  await writeFile(snapshot, (await readFile(snapshot, 'utf8')).replace(quote, 'A changed quote.'));
  await assert.rejects(reviewSession(root, 'review-1', {
    model: () => { throw new Error('Corrupted evidence reached the model'); },
  }), /Transcript evidence hash mismatch/);
});

test('Session review connects failure and retry receipts to the original Skill version', async t => {
  const root = await temp(t);
  const session = 'review-2';
  const receipts = join(root, '.workflow', 'sessions', session, 'receipts');
  await mkdir(join(receipts, 'transitions'), { recursive: true });
  await mkdir(join(receipts, 'requests'));
  const skillRef = {
    skill_id: 'analyze', commit: 'a'.repeat(40), tree: 'b'.repeat(40),
    package_path: 'skills/analyze', entry: 'SKILL.md',
  };
  const birth = { run_already_created: true, task: { command: 'analyze' }, status: 'running' };
  const pathFor = revision => `${String(revision).padStart(12, '0')}-tr_${revision}.json`;
  async function writeReceipt(revision, targetType, targetId, result, reason = 'Run started', evidence = []) {
    const requestId = `req-${revision}`;
    const filename = pathFor(revision);
    await writeFile(join(receipts, 'transitions', filename), JSON.stringify({
      schema_version: 'transition-receipt/2.0', session_id: session, activity_revision: revision,
      request_id: requestId, transition_id: `tr_${revision}`, participant_id: 'actor',
      target_type: targetType, target_id: targetId, revision_before: revision - 1, revision_after: revision,
      recorded_at: `2026-11-13T01:0${revision}:00Z`, reason, result, evidence_refs: evidence,
    }));
    await writeFile(join(receipts, 'requests', `${requestId}.json`), JSON.stringify({
      schema_version: 'request-receipt/2.0', request_id: requestId, participant_id: 'actor',
      payload_hash: `sha256:${'c'.repeat(64)}`, transition_receipt_ref: `receipts/transitions/${filename}`,
    }));
  }
  const quote = 'Use the required preflight link before retrying.';
  const locator = ['codex', 'host-2', 'correction'];
  const digest = value => createHash('sha256').update(value).digest('hex');
  const sha256 = digest(quote);
  const anchor = `transcript:${locator.join(':')}:${sha256.slice(0, 16)}`;
  const directory = join(receipts, '..', 'transcript-evidence');
  await mkdir(directory);
  await writeFile(join(directory, `${sha256}-${digest(locator.join('\0')).slice(0, 16)}.json`), JSON.stringify({
    schema_version: 'transcript-evidence/1.0', sha256, normalized_sha256: sha256,
    host_kind: locator[0], host_session_id: locator[1], entry_id: locator[2],
    captured_at: '2026-11-13T01:03:00Z', quote,
  }));
  await writeReceipt(1, 'orchestration', session, { ...birth, run_id: 'run-1', skill_ref: skillRef });
  await writeReceipt(2, 'run', 'run-1', { run_id: 'run-1', status: 'blocked' }, 'Workflow link skipped.');
  await writeReceipt(3, 'run', 'run-1', { run_id: 'run-1', status: 'failed' }, 'Required preflight missing.', [anchor]);
  await writeReceipt(4, 'orchestration', session, { ...birth, run_id: 'run-2', retry_of_run_id: 'run-1' });
  await writeReceipt(5, 'orchestration', session, {
    ...birth, run_id: 'run-3', skill_ref: skillRef, retry_of_run_id: 'run-2',
  });
  const skillReads = {
    reference: skillRef, missing: [],
    reads: [
      { path: 'SKILL.md', sha256: `sha256:${'d'.repeat(64)}` },
      { path: 'references/prepare.md', sha256: `sha256:${'e'.repeat(64)}` },
    ],
  };
  const knowledgeReads = {
    schema_version: 'knowledge-reads/1.0',
    constraints_bound: [{ knowledge_id: 'entries/preflight', scope: ['skill:analyze'], categories: ['arch'], content_sha256: `sha256:${'f'.repeat(64)}` }],
    searches: [{ search_id: 'search-1', source: 'memory', query: 'preflight retry', filters: { scene: 'analyze' }, returned_ids: ['memory-preflight'], total_hits: 1 }],
    reads: [{ kind: 'memory', id: 'memory-preflight', from_search_id: 'search-1', content_sha256: `sha256:${'a'.repeat(64)}`, version: 1 }],
  };
  await writeReceipt(6, 'orchestration', session, {
    operation: 'run-complete-and-seal', status: 'sealed', run_id: 'run-3',
    summary: 'Preflight re-run passed.', skill_reads: skillReads, knowledge_reads: knowledgeReads,
  });
  const result = await reviewSession(root, session, { model: () => ({
    async chat({ system, prompt }) {
      assert.match(system, /Allowed types are correction, error, retry/);
      assert.doesNotMatch(system, /work_fact/);
      assert.match(prompt, /run-1 became blocked.*Workflow link skipped/);
      assert.match(prompt, /run-1 became failed.*Required preflight missing/);
      assert.match(prompt, /run-2 \(analyze\) retries run-1/);
      assert.match(prompt, /run-3 completed.*Preflight re-run passed/);
      assert.match(prompt, /run-3 opened Skill documents: SKILL.md, references\/prepare.md/);
      assert.match(prompt, /Knowledge searches: search-1 memory/);
      assert.match(prompt, /memory:memory-preflight from search-1/);
      return JSON.stringify([{ memories: [
        { type: 'retry', content: 'Run was retried.', source_message_ids: ['receipt:tr_4#run:run-2'] },
        { type: 'correction', content: quote, source_message_ids: [anchor] },
        { type: 'verified_fix', content: 'Retry opened preflight and passed.', source_message_ids: [
          'receipt:tr_6#skill-reads:run-3', 'receipt:tr_6#run:run-3',
        ] },
      ] }]);
    },
  }) });
  assert.deepEqual(result.runs, [
    { id: 'run-1', command: 'analyze', skillRef, retryOf: undefined, source: 'receipt:tr_1#run:run-1' },
    { id: 'run-2', command: 'analyze', skillRef: undefined, retryOf: 'run-1', source: 'receipt:tr_4#run:run-2' },
    {
      id: 'run-3', command: 'analyze', skillRef, retryOf: 'run-2', source: 'receipt:tr_5#run:run-3',
      skillReads: { source: 'receipt:tr_6#skill-reads:run-3', files: skillReads.reads },
      knowledgeReads: { source: 'receipt:tr_6#knowledge-reads:run-3', receipt: knowledgeReads },
    },
  ]);
  assert.deepEqual(result.signals.find(signal => signal.kind === 'retry').runIds, ['run-1', 'run-2']);
  assert.deepEqual(result.signals.find(signal => signal.kind === 'correction').runIds, ['run-1']);
  assert.deepEqual(result.signals.find(signal => signal.kind === 'verified_fix').runIds, ['run-3']);
  await writeReceipt(6, 'orchestration', session, {
    operation: 'run-complete-and-seal', status: 'sealed', run_id: 'run-3', summary: 'Preflight re-run passed.',
    skill_reads: { ...skillReads, reference: { ...skillRef, tree: 'f'.repeat(40) } },
  });
  await assert.rejects(reviewSession(root, session, {
    model: () => { throw new Error('Wrong Skill version reached the model'); },
  }), /Skill reads do not match the sealed Run/);
  await writeFile(join(receipts, 'requests', 'req-3.json'), '{}');
  await assert.rejects(reviewSession(root, session, {
    model: () => { throw new Error('Uncommitted evidence reached the model'); },
  }), /Invalid Session request receipt/);
});

test('Session closeout harvests sealed Run knowledge_reads into the LLM evidence', async t => {
  const root = await temp(t);
  const session = 'closeout-knowledge';
  const receipts = join(root, '.workflow', 'sessions', session, 'receipts');
  await mkdir(join(receipts, 'transitions'), { recursive: true });
  await mkdir(join(receipts, 'requests'));
  const knowledgeReads = {
    schema_version: 'knowledge-reads/1.0', constraints_bound: [],
    searches: [{ search_id: 'search-1', source: 'memory', query: 'release freeze', filters: {}, returned_ids: ['memory-freeze'], total_hits: 1 }],
    reads: [{ kind: 'memory', id: 'memory-freeze', from_search_id: 'search-1', content_sha256: `sha256:${'1'.repeat(64)}`, version: 1 }],
  };
  const filename = '000000000001-tr_sealed.json';
  const requestId = 'req-sealed';
  await writeFile(join(receipts, 'transitions', filename), JSON.stringify({
    schema_version: 'transition-receipt/2.0', session_id: session, activity_revision: 1,
    request_id: requestId, transition_id: 'tr_sealed', participant_id: 'actor',
    target_type: 'orchestration', target_id: session, revision_before: 0, revision_after: 1,
    recorded_at: '2026-11-13T04:00:00Z', result: {
      operation: 'run-complete-and-seal', status: 'sealed', run_id: 'run-knowledge',
      summary: 'Release freeze check completed.', knowledge_reads: knowledgeReads,
    }, evidence_refs: [],
  }));
  await writeFile(join(receipts, 'requests', `${requestId}.json`), JSON.stringify({
    schema_version: 'request-receipt/2.0', request_id: requestId, participant_id: 'actor',
    payload_hash: `sha256:${'2'.repeat(64)}`, transition_receipt_ref: `receipts/transitions/${filename}`,
  }));
  const completion = {
    schema_version: 'transition-receipt/2.0', transition_id: 'tr_complete', session_id: session,
    target_type: 'orchestration', target_id: session, recorded_at: '2026-11-13T04:01:00Z',
    result: { status: 'completed', evolve_evidence: [] },
  };
  const { harvestCompletion } = await import('../dist/closeout.js');
  const wiki = new Wiki(root);
  const harvested = await harvestCompletion(wiki, 'closeout-project', completion, () => ({
    async chat({ prompt }) {
      assert.match(prompt, /run-knowledge/);
      assert.match(prompt, /memory-freeze from search-1/);
      return JSON.stringify([{ memories: [{ content: 'Release freeze was checked before closeout.', type: 'verified_fix', source_message_ids: ['run:run-knowledge:knowledge-reads'] }] }]);
    },
  }), join(root, '.workflow', 'sessions', session));
  assert.equal(harvested.candidates.length, 1);
  assert.equal(harvested.candidates[0].sources[0], `receipt:closeout-project:${completion.transition_id}#run:run-knowledge:knowledge-reads`);
});

test('Wiki ingest preserves source attribution and locked pages', async t => {
  const root = await temp(t);
  const source = join(root, 'notes.md');
  await writeFile(source, 'The storage controller holds the calibration.');
  const wiki = new Wiki(root);
  const candidate = [
    '<<<FILE path="wiki/concepts/storage-controller.md">>>',
    '---', 'title: Storage Controller', 'type: concept', '---', '',
    'Retains calibration.', '<<<END>>>',
  ].join('\n');
  const calls = [];
  const llm = { async chat({ label }) {
    calls.push(label);
    return label === 'wiki-analysis' ? 'Create a controller page.' : candidate;
  } };
  const { written } = await wiki.ingest(source, { llm });
  assert.deepEqual(calls, ['wiki-analysis', 'wiki-generate']);
  assert.deepEqual(written, ['wiki/concepts/storage-controller.md']);
  assert.deepEqual(wiki.search('calibration').results[0].sources, ['notes.md']);
  const page = join(root, ...written[0].split('/'));
  const locked = '---\ntitle: Storage Controller\ntype: concept\nlocked: true\n---\n\nHandwritten calibration.\n';
  await writeFile(page, locked);
  assert.deepEqual((await wiki.ingest(source, { llm, mode: 'single-stage' })).written, []);
  assert.equal(await readFile(page, 'utf8'), locked);
});

test('Memory persists scoped records and fuses keyword and vector rankings', async t => {
  let a, b;
  const root = await temp(t, () => { a?.close(); b?.close(); });
  const db = join(root, 'memory.db');
  a = new MemoryStore(db, { namespace: 'a' });
  b = new MemoryStore(db, { namespace: 'b' });
  const input = { id: 'x', content: '用户偏好使用水力计算', type: 'persona', session: 's1', embedding: [1, 1] };
  await a.put(input);
  assert.equal((await a.put(input)).version, 1);
  await a.put({ id: 'y', content: 'Engineering simulation', type: 'work_fact', embedding: [1, 0] });
  await b.put({ id: 'x', content: '水力计算', type: 'persona', embedding: [1, 1] });
  assert.equal((await a.search('水力计算', { embedding: [1, 0] })).strategy, 'hybrid');
  assert.deepEqual((await a.search('水力计算', { embedding: [1, 0] })).results.map(hit => hit.id), ['x', 'y']);
  assert.deepEqual((await a.search('水力计算', { session: 'wrong' })).results, []);
  assert.equal((await cliJson(root, 'memory', 'search', '水力计算', '--db', db, '--namespace', 'b')).results[0].content, '水力计算');
  assert.equal((await a.put({ ...input, content: 'Updated preference' })).version, 2);
  assert.deepEqual((await a.search('水力计算')).results, []);
  assert.equal(a.delete('x'), true);
  assert.equal(b.get('x').content, '水力计算');
});

test('memory search pages cover exact, keyword and hybrid hits without overlap', async t => {
  let memory;
  const root = await temp(t, () => memory?.close());
  const db = join(root, 'memory.db');
  memory = new MemoryStore(db);
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    await memory.put({ id, content: 'Deployment port 4312', session: id, embedding: [1, 0] });
  }
  // 模拟没有新索引的旧条目。
  const sqlite = new DatabaseSync(db);
  sqlite.exec("DELETE FROM memory_literals WHERE memory_key IN (SELECT key FROM memory_records WHERE id IN ('b', 'd', 'f'))");
  sqlite.close();
  const invoke = (query, page) => cliJson(root, 'memory', 'search', query, '--page', String(page), '--limit', '2', '--db', db);
  const first = await invoke('4312', 1);
  const middle = await invoke('4312', 2);
  const last = await invoke('4312', 3);
  assert.deepEqual(first.pagination, { page: 1, limit: 2, previousPage: null, nextPage: 2 });
  assert.deepEqual(last.pagination, { page: 3, limit: 2, previousPage: 2, nextPage: null });
  assert.deepEqual([first, middle, last].flatMap(result => result.results.map(hit => hit.id)), ['a', 'c', 'e', 'b', 'd', 'f']);
  const traced = await cliJson(root, 'memory', 'search', '4312', '--page', '2', '--limit', '2', '--trace', '--db', db);
  assert.equal(traced.knowledge_reads.searches[0].filters.page, 2);
  const keywords = await Promise.all([1, 2, 3].map(page => invoke('Deployment', page)));
  assert.deepEqual(keywords.flatMap(result => result.results.map(hit => hit.id)), ['a', 'b', 'c', 'd', 'e', 'f']);
  const hybrid = await Promise.all([1, 2, 3].map(page => memory.search('Deployment', { embedding: [1, 0], page, limit: 2 })));
  assert.ok(hybrid.every(result => result.strategy === 'hybrid'));
  assert.equal(new Set(hybrid.flatMap(result => result.results.map(hit => hit.id))).size, 6);
  assert.deepEqual((await invoke('4312', 4)).results, []);
  await assert.rejects(memory.search('Deployment', { page: 0 }), /page must be a positive integer/);
});

test('compact memory search shares command arguments and keeps the original scope and receipt', async t => {
  let memory;
  const root = await temp(t, () => memory?.close());
  const db = join(root, "team's memory.db");
  const receipt = join(root, "team's reads.json");
  const namespace = 'team’s $memory "blue"';
  const scene = '-deploy';
  const query = '-004312.50';
  const content = `${'😀'.repeat(240)}\nThe original amount is ${query}.`;
  const id = '-first';
  const options = { session: 'original session', scene, type: 'work_fact' };
  memory = new MemoryStore(db, { namespace });
  await memory.put({ ...options, id, content });
  await memory.put({ ...options, id: 'second', content: query });
  await memory.put({ ...options, id: '-excluded', scene: 'other', content: query });

  // 直接执行参数数组，保留从另一目录读取所需的作用域和参数边界。
  const runView = async (commands, action, slots) => {
    const [executable, ...prefix] = commands.prefix;
    assert.equal(executable, 'evolve');
    const args = commands[action].map(value => typeof value === 'string' ? value : String(slots[value.arg]));
    const { stdout } = await run(process.execPath, [workflowCli, ...prefix, ...args], { cwd: tmpdir(), encoding: 'utf8' });
    return JSON.parse(stdout);
  };

  const filters = ['--db', db, '--namespace', namespace, '--type', options.type, `--scene=${scene}`,
    '--session', options.session, '--limit', '1'];
  const first = await evolveJson(root, 'memory', 'search', ...filters, '--reads', receipt, '--', query);
  const [hit] = first.results;
  assert.deepEqual(hit, { id, content: `${'😀'.repeat(160)}…` });
  assert.deepEqual(Object.keys(first.commands), ['prefix', 'get', 'page']);
  assert.equal(first.pagination.previousPage, null);
  const full = await runView(first.commands, 'get', hit);
  assert.equal(full.content, content);
  assert.deepEqual(full.exactValues, [query]);
  assert.equal(full.knowledge_reads.reads[0].from_search_id, first.knowledge_reads.searches[0].search_id);
  const second = await runView(first.commands, 'page', { page: first.pagination.nextPage });
  assert.equal(second.results[0].id, 'second');
  assert.equal(second.pagination.page, 2);
  assert.equal(second.pagination.nextPage, null);
  assert.deepEqual(second.commands.page, first.commands.page);
  assert.equal((await runView(second.commands, 'page', { page: second.pagination.previousPage })).results[0].id, id);

  const raw = await evolveJson(root, 'memory', 'search', ...filters, '--json', '--', query);
  assert.deepEqual(raw, await memory.search(query, { ...options, limit: 1 }));
});

test('Agent Memory context envelope keeps discovery and exact-read identities separate', async t => {
  const root = await temp(t);
  const entries = join(root, 'wiki', 'entries');
  await mkdir(entries, { recursive: true });
  await writeFile(join(entries, 'preflight.md'), [
    '---', 'title: Migration preflight', 'mode: constraint', 'status: active',
    'scope: [task:migration]', 'sources: [policy:preflight]', '---', '',
    'Run the migration preflight before applying changes.',
  ].join('\n'));
  await writeFile(join(entries, 'calibration.md'), [
    '---', 'title: Calibration reference', 'mode: reference', 'status: active',
    'scope: [project]', 'sources: [notes:calibration]', '---', '',
    'Use a dry-run when the migration target is uncertain.',
  ].join('\n'));
  const wiki = new Wiki(root);
  wiki.build();
  const memory = new MemoryStore(':memory:');
  t.after(() => memory.close());
  await memory.put({ id: 'memory-1', content: 'The migration target is staging.', type: 'work_fact', session: 'session-1', sourceMessageIds: ['message-1'] });

  const envelope = await context({ wiki, memory }, 'migration', {
    context: { task: 'migration' },
    contextScope: { session_id: 'session-1', task_kind: 'migration' },
    includeWorkingMemory: true,
  });
  assert.equal(envelope.schema_version, 'agent-memory-envelope/1.0');
  assert.equal(envelope.trust_boundary, 'untrusted_evidence_data_only');
  assert.equal(envelope.memory_level, 'L3');
  assert.equal(envelope.constraints[0].knowledge_id, 'entries/preflight');
  assert.equal(envelope.references[0].knowledge_id, 'entries/calibration');
  assert.equal(envelope.working_memories[0].memory_id, 'memory-1');
  assert.deepEqual(envelope.working_memories[0].source_ids, ['message-1']);
  assert.equal(wiki.getEntry(envelope.constraints[0].knowledge_id).id, 'entries/preflight');
});

test('L1 extraction is traceable and retryable with a supplied model', async t => {
  const memory = new MemoryStore(':memory:');
  t.after(() => memory.close());
  const messages = [{ id: 'm1', role: 'user', timestamp: 0, content: 'Prefer blue charts.' }];
  const llm = { async chat({ prompt }) {
    assert.match(prompt, /\[m1\].*Prefer blue charts/);
    return '<think>[draft]</think>' + JSON.stringify([{
      scene_name: 'Charts',
      memories: [{ content: 'Prefer blue charts.', type: 'persona', source_message_ids: ['m1', 'hallucinated'] }],
    }]);
  } };
  const options = { session: 'charts', llm };
  const [stored] = await memory.extract(messages, options);
  assert.deepEqual(stored.sourceMessageIds, ['m1']);
  assert.deepEqual(await memory.extract(messages, options), [stored]);
  assert.equal((await memory.search('charts', { session: 'charts' })).results[0].id, stored.id);
  await assert.rejects(memory.extract(messages, { ...options, llm: { chat: async () => 'invalid' } }), /JSON array/);
});

test('identical model summaries preserve the distinct original values and sources of each turn', async t => {
  const memory = new MemoryStore(':memory:');
  t.after(() => memory.close());
  const options = { session: 'deploy', llm: { async chat() {
    return JSON.stringify([{ memories: [{ content: 'Deployment configuration confirmed.' }] }]);
  } } };
  const save = (id, value) => memory.extract([{ id, role: 'user', timestamp: 0, content: `Using port ${value}.` }], options);
  const [first] = await save('first', '04312');
  const [second] = await save('second', '04313');
  assert.notEqual(first.id, second.id);
  assert.equal((await memory.search('04312')).results[0]?.id, first.id);
  assert.equal((await memory.search('04313')).results[0]?.id, second.id);
  assert.deepEqual((await memory.search('4312')).results, []);
  assert.equal(memory.sources(first.id)[0]?.content, 'Using port 04312.');
  assert.equal(memory.sources(second.id)[0]?.id, 'second');
});

test('Shared module API, CLI and HTTP return the same scoped search', async t => {
  let server, memory;
  const root = await temp(t, async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    memory?.close();
  });
  const db = join(root, 'memory.db');
  await writeFile(join(root, 'recall.ts'), 'export function recallEvidence() { return true; }');
  await mkdir(join(root, 'wiki'));
  await writeFile(join(root, 'wiki', 'recall.md'), '# Recall\n\nEvidence for recall.\n');
  await cliJson(root, 'code', 'build');
  await cliJson(root, 'wiki', 'build');
  await cliJson(root, 'memory', 'put', 'recall evidence', '--db', db, '--id', 'test');
  memory = new MemoryStore(db);
  const sources = { code: new CodeGraph(root), wiki: new Wiki(root), memory };
  server = createSearchServer(sources);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/search`;
  const baseUrl = url.slice(0, -'/search'.length);
  const expected = JSON.parse(JSON.stringify(await search(sources, 'recall')));
  assert.deepEqual(await cliJson(root, 'search', 'recall', '--db', db), expected);
  assert.ok(expected.code.length && expected.wiki.results.length && expected.memory.results.length);
  const contextResult = await cliJson(root, 'context', 'recall', '--db', db, '--scope', 'memory', '--include-memory');
  assert.equal(contextResult.schema_version, 'agent-memory-envelope/1.0');
  assert.equal(contextResult.working_memories[0].memory_id, 'test');
  const response = await fetch(url + '?q=recall');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  const contextResponse = await fetch(baseUrl + '/context?q=recall&scope=memory&include_memory=true&skill=legacy');
  assert.equal(contextResponse.status, 200);
  assert.deepEqual(await contextResponse.json(), contextResult);
  assert.deepEqual(await (await fetch(url + '?q=recall&scope=memory')).json(), { memory: expected.memory });
  assert.equal((await fetch(url + '?q=recall&limit=-1')).status, 400);
  assert.equal((await fetch(url + '/missing?q=recall')).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
});

test('Stage search tracing keeps context sessions separate from historical Memory filters', async t => {
  const root = await temp(t);
  const db = join(root, 'memory.db');
  const memory = new MemoryStore(db);
  await memory.put({ id: 'old-memory', content: 'The migration retry needs a dry run.', type: 'error', scene: 'execute', session: 'old-session' });
  memory.close();

  const contextResult = await cliJson(root, 'context', 'migration retry', '--db', db, '--session', 'new-session', '--include-memory', '--trace');
  assert.deepEqual(contextResult.working_memories.map(item => item.memory_id), ['old-memory']);
  assert.equal(contextResult.knowledge_reads.searches[0].source, 'memory');
  assert.deepEqual(contextResult.knowledge_reads.searches[0].returned_ids, ['old-memory']);

  const filtered = await cliJson(root, 'memory', 'search', 'migration retry', '--db', db, '--session', 'old-session', '--trace');
  assert.deepEqual(filtered.results.map(item => item.id), ['old-memory']);
  assert.equal(filtered.knowledge_reads.searches[0].source, 'memory');

  const tracker = new KnowledgeReads();
  const store = new MemoryStore(db);
  const searchResult = await search({ memory: store }, 'migration retry', {
    scope: 'memory', memory: { scene: 'execute' }, knowledgeReads: tracker,
  });
  const searchId = tracker.toJSON().searches[0].search_id;
  store.get(searchResult.memory.results[0].id, { knowledgeReads: tracker, fromSearchId: searchId });
  const receipt = tracker.toJSON();
  assert.equal(receipt.reads[0].id, 'old-memory');
  assert.equal(receipt.reads[0].from_search_id, searchId);
  store.close();
});

test('CLI context profiles and compatibility JSON flags reduce repeated context arguments', async t => {
  const root = await temp(t);
  const profile = join(root, 'context.json');
  await writeFile(profile, JSON.stringify({
    skill: 'analyze', task: 'plan', paths: ['src/solver.ts'], categories: ['arch'], includePathScoped: false,
  }));
  const fromProfile = await cliJson(root, 'context', 'solver layout', '--context-file', profile, '--json');
  const fromFlags = await cliJson(root, 'context', 'solver layout', '--task', 'plan',
    '--path', 'src/solver.ts', '--category', 'arch', '--json');
  assert.deepEqual(fromProfile.context_scope, fromFlags.context_scope);
  assert.deepEqual(fromFlags.context_scope, { task_kind: 'plan', paths: ['src/solver.ts'] });
  assert.deepEqual(fromProfile.constraints, fromFlags.constraints);
  assert.deepEqual(fromProfile.references, fromFlags.references);
  const reads = join(root, 'reads.json');
  await cliJson(root, 'context', 'solver layout', '--context-file', profile, '--reads', reads);
  assert.ok((await readFile(reads, 'utf8')).includes('knowledge-reads/1.0'));
  await mkdir(join(root, 'wiki'), { recursive: true });
  assert.equal((await cliJson(root, 'wiki', 'build', '--json')).pages, 0);
  await mkdir(join(root, 'wiki', 'entries'), { recursive: true });
  await writeFile(join(root, 'wiki', 'entries', 'solver-guide.md'), [
    '---', 'title: Solver guide', 'mode: reference', 'status: active', 'scope: [task:plan]',
    'sources: [fixture:solver]', '---', '', 'Use the sparse solver path.', '',
  ].join('\n'));
  await cliJson(root, 'wiki', 'build');
  const legacyReference = await cliJson(root, 'wiki', 'reference', 'entries/solver-guide', '--task', 'plan');
  const resolvedGet = await cliJson(root, 'wiki', 'get', 'entries/solver-guide', '--resolved', '--task', 'plan');
  assert.deepEqual(resolvedGet, legacyReference);
  await writeFile(join(root, 'wiki', 'entries', 'legacy-guide.md'), [
    '---', 'title: Legacy solver guide', 'mode: reference', 'status: active', 'scope: [skill:analyze]',
    'sources: [fixture:legacy]', '---', '', 'Check the residual before retry.', '',
  ].join('\n'));
  assert.equal(await cliJson(root, 'wiki', 'reference', 'entries/legacy-guide', '--skill', 'analyze'), null);
  assert.equal((await cliJson(root, 'wiki', 'get', 'entries/legacy-guide')).id, 'entries/legacy-guide');
  const draft = join(root, 'change.json');
  await writeFile(draft, JSON.stringify({ operation: 'update', entry: 'entries/legacy-guide', title: 'Solver retry' }));
  await assert.rejects(cliJson(root, 'wiki', 'propose', draft, '--evidence', 'review:solver'), /reviewed scope explicitly/);
  await writeFile(draft, JSON.stringify({ operation: 'update', entry: 'entries/legacy-guide', scope: ['task:plan'] }));
  const proposed = await cliJson(root, 'wiki', 'propose', draft, '--evidence', 'review:solver');
  await cliJson(root, 'wiki', 'apply', proposed.id);
  assert.equal((await cliJson(root, 'wiki', 'reference', 'entries/legacy-guide', '--task', 'plan')).id, 'entries/legacy-guide');
});

test('Knowledge closeout routes local fixes and structural changes to the right Skill flow', () => {
  const addition = decideSkillRoute({
    content: 'The execute Skill must search the error Memory before retrying.',
    sources: ['receipt:run-1#error'], skillId: 'execute', skillVersion: 'v1',
    signalKinds: ['retry'], repeatCount: 2,
  });
  assert.equal(addition.route, 'skill-addition');
  assert.equal(addition.invoke_meta_skill, false);
  assert.equal(addition.priority, 'high');

  const design = decideSkillRoute({
    content: 'Create a workflow for multi-stage release validation.',
    sources: ['receipt:run-2#summary'], crossSkill: true, requiresNewContract: true, stepCount: 4,
  });
  assert.equal(design.route, 'skill-design');
  assert.equal(design.invoke_meta_skill, true);
  assert.equal(design.meta_skill.id, 'ew-skill-design');

  const wiki = decideSkillRoute({ content: 'Use the staging inventory as a reference.', sources: ['receipt:run-3#check'] });
  assert.equal(wiki.route, 'wiki');
  assert.equal(wiki.invoke_meta_skill, false);
});

test('Skill-design route generates a task, reviews a meta design, replays it, and applies it', async t => {
  const root = await temp(t);
  const support = await temp(t);
  const git = (...args) => run('git', args, { cwd: root });
  await git('init', '-q');
  await git('config', 'user.name', 'Skill design test');
  await git('config', 'user.email', 'skill-design@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  const entry = join(root, 'skills', 'example', 'SKILL.md');
  await mkdir(join(root, 'skills', 'example'), { recursive: true });
  const original = '---\nname: example\n---\n\n# Example\n';
  await writeFile(entry, original);
  await git('add', '.');
  await git('commit', '-qm', 'Skill design baseline');

  const decision = decideSkillRoute({
    content: 'Design a new Skill contract for the release workflow.',
    sources: ['receipt:design#summary'], skillId: 'example', skillVersion: 'baseline',
    requiresNewContract: true, stepCount: 3,
  });
  const task = createSkillDesignTask(root, {
    closeoutId: 'a'.repeat(64), candidateId: 'b'.repeat(64), content: decision.meta_skill.instruction,
    sources: ['receipt:design#summary'], decision, skillId: 'example', skillVersion: 'baseline',
  });
  assert.equal(task.replayed, false);

  const packageEntry = new URL('../dist/index.js', import.meta.url).href;
  const designRunner = join(support, 'design-runner.mjs');
  await writeFile(designRunner, [
    "import { readFileSync } from 'node:fs';",
    `import { draftSkillAddition } from ${JSON.stringify(packageEntry)};`,
    "const {task} = JSON.parse(readFileSync(0, 'utf8'));",
    "const draft = draftSkillAddition({ entry: task.target.entry, priority: 'high', instruction: 'Verify release preflight.', sources: task.source.evidence });",
    "console.log(JSON.stringify({ schema_version: 'skill-design/1.0', task_id: task.id, draft }));",
  ].join('\n'));
  const designed = await runSkillDesign(root, task.id, designRunner);
  const reviewed = reviewSkillDesign(root, designed.id);
  assert.equal(reviewed.status, 'reviewed');

  const replayRunner = join(support, 'replay-runner.mjs');
  await writeFile(replayRunner, [
    "import { readFileSync } from 'node:fs';",
    "import { createHash } from 'node:crypto';",
    "const {entry,input} = JSON.parse(readFileSync(0, 'utf8'));",
    "const body = readFileSync(entry, 'utf8');",
    "const sha256 = createHash('sha256').update(body).digest('hex');",
    "console.log(JSON.stringify({ passed: input === 'existing' || body.includes('Verify release preflight.'), loaded: [{ path: entry, sha256 }] }));",
  ].join('\n'));
  const scenarios = [
    { id: 'missing-release-preflight', input: 'reproduce', baseline: false },
    { id: 'existing-release-flow', input: 'existing', baseline: true },
  ];
  const replayed = replaySkillDesign(root, designed.id, { runner: replayRunner, scenarios });
  assert.equal(replayed.status, 'replayed');
  const applied = applySkillDesign(root, designed.id);
  assert.equal(applied.design_id, designed.id);
  assert.match(await readFile(entry, 'utf8'), /Verify release preflight/);
  applySkillDesign(root, designed.id, true);
  assert.equal(await readFile(entry, 'utf8'), original);
});

test('Skill-design supports a new multi-file package with linked Markdown references', async t => {
  const root = await temp(t);
  const support = await temp(t);
  const git = (...args) => run('git', args, { cwd: root });
  await git('init', '-q');
  await git('config', 'user.name', 'Skill package test');
  await git('config', 'user.email', 'skill-package@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  await writeFile(join(root, 'README.md'), 'baseline\n');
  await git('add', '.');
  await git('commit', '-qm', 'package baseline');
  const decision = decideSkillRoute({
    content: 'Create a new multi-file release Skill package.',
    sources: ['receipt:package#summary'], skillId: 'release-package',
    requiresNewContract: true, stepCount: 4,
  });
  const task = createSkillDesignTask(root, {
    closeoutId: 'c'.repeat(64), candidateId: 'd'.repeat(64), content: decision.meta_skill.instruction,
    sources: ['receipt:package#summary'], decision, skillId: 'release-package', skillVersion: '0.1.0',
  });
  const packageEntry = new URL('../dist/index.js', import.meta.url).href;
  const designRunner = join(support, 'package-design-runner.mjs');
  await writeFile(designRunner, [
    "import { readFileSync } from 'node:fs';",
    "const {task} = JSON.parse(readFileSync(0, 'utf8'));",
    "const packagePath = `skills/${task.target.skill_id}`;",
    "const entry = `${packagePath}/SKILL.md`;",
    "const changes = [{ path: entry, content: '---\\nname: release-package\\n---\\n\\n# Release\\n\\n[Checks](references/checks.md)\\n' }, { path: `${packagePath}/references/checks.md`, content: '# Checks\\n' }];",
    "console.log(JSON.stringify({ schema_version: 'skill-design/1.0', task_id: task.id, draft: { mode: 'package', skill_id: task.target.skill_id, package_path: packagePath, entry, sources: task.source.evidence, changes } }));",
  ].join('\n'));
  const designed = await runSkillDesign(root, task.id, designRunner);
  const reviewed = reviewSkillDesign(root, designed.id);
  assert.equal(reviewed.status, 'reviewed');
  const replayRunner = join(support, 'package-replay-runner.mjs');
  await writeFile(replayRunner, [
    "import { readFileSync } from 'node:fs';",
    "import { existsSync } from 'node:fs';",
    "import { createHash } from 'node:crypto';",
    "const {entry, input, mode} = JSON.parse(readFileSync(0, 'utf8'));",
    "const sha256 = value => createHash('sha256').update(value).digest('hex');",
    "if (mode !== 'package') throw new Error('expected package mode');",
    "if (!existsSync(entry)) console.log(JSON.stringify({ passed: input === 'existing', loaded: [] }));",
    "else { const body = readFileSync(entry, 'utf8'); const reference = readFileSync('skills/release-package/references/checks.md', 'utf8'); console.log(JSON.stringify({ passed: body.includes('[Checks]'), loaded: [{ path: entry, sha256: sha256(body) }, { path: 'skills/release-package/references/checks.md', sha256: sha256(reference) }] })); }",
  ].join('\n'));
  const scenarios = [
    { id: 'missing-package', input: 'missing', baseline: false },
    { id: 'existing-package', input: 'existing', baseline: true },
  ];
  const replayed = replaySkillDesign(root, designed.id, { runner: replayRunner, scenarios });
  assert.equal(replayed.status, 'replayed');
  const applied = applySkillDesign(root, designed.id);
  assert.equal(applied.design_id, designed.id);
  assert.match(await readFile(join(root, 'skills', 'release-package', 'SKILL.md'), 'utf8'), /\[Checks\]/);
  assert.equal(await readFile(join(root, 'skills', 'release-package', 'references', 'checks.md'), 'utf8'), '# Checks\n');
  applySkillDesign(root, designed.id, true);
  await assert.rejects(readFile(join(root, 'skills', 'release-package', 'SKILL.md'), 'utf8'));
});

test('CLI ingestion and memory extraction use an OpenAI-compatible endpoint', async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, auth: request.headers.authorization, body: JSON.parse(body) });
    const content = [
      'Create a concept.',
      '<<<FILE path="wiki/concepts/fixture.md">>>\n---\ntype: concept\ntitle: Fixture\n---\n\nFixture reference.\n<<<END>>>',
      '[{"scene_name":"Fixture","memories":[{"content":"Fixture preference","type":"persona","source_message_ids":["m1"]}]}]',
    ][requests.length - 1];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  const root = await temp(t, () => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = {
    ...process.env,
    AGENT_MEMORY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    AGENT_MEMORY_LLM_MODEL: 'fixture-model',
    AGENT_MEMORY_LLM_API_KEY: 'fixture-key',
  };
  const file = join(root, 'source.txt');
  const messages = join(root, 'messages.json');
  await writeFile(file, 'This is a fixture.');
  await writeFile(messages, JSON.stringify([{ id: 'm1', role: 'user', timestamp: 0, content: 'Remember my fixture preference.' }]));
  const invoke = async (...args) => JSON.parse((await run(process.execPath, [cli, '--root', root, ...args], { env })).stdout);
  assert.deepEqual((await invoke('wiki', 'ingest', file)).written, ['wiki/concepts/fixture.md']);
  const [memory] = await invoke('memory', 'extract', messages, '--session', 'fixture');
  assert.equal(memory.content, 'Fixture preference');
  assert.deepEqual(memory.sourceMessageIds, ['m1']);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.path, '/v1/chat/completions');
    assert.equal(request.auth, 'Bearer fixture-key');
    assert.equal(request.body.model, 'fixture-model');
  }
});
