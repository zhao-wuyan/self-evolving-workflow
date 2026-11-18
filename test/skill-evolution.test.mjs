import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MemoryStore, decideSkillRoute, draftSkillAddition, draftSkillRetirement, listSkillLearnings } from 'self-evolving-workflow';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
const loop = fileURLToPath(new URL('../skills/workflow-evolve/scripts/evolve-loop.mjs', import.meta.url));
const original = '---\nname: example\nversion: 1.0.0\n---\n\n# Example\n';

async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'skill-evolution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function evolve(root, ...args) {
  const { stdout } = await execute(process.execPath, [cli, '--root', root, ...args], { encoding: 'utf8', cwd: root });
  return JSON.parse(stdout);
}

/** 建立含单个 Skill 的 Git 仓库，并写入按提交读取 Skill 的确定性 runner。 */
async function fixture(t) {
  const root = await temp(t);
  const git = async (...args) => (await execute('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
  await git('init', '-q');
  await git('config', 'user.name', 'Evolve test');
  await git('config', 'user.email', 'evolve-test@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  const entry = join(root, 'skills', 'example', 'SKILL.md');
  await mkdir(join(root, 'skills', 'example'), { recursive: true });
  await writeFile(entry, original);
  await git('add', '.');
  await git('commit', '-qm', 'Initial Skill');
  const runner = join(root, '..', `${root.split(/[\\/]/).at(-1)}-runner.mjs`);
  t.after(() => rm(runner, { force: true }));
  await writeFile(runner, [
    "import {readFileSync} from 'node:fs';",
    "import {execFileSync} from 'node:child_process';",
    "import {createHash} from 'node:crypto';",
    "const {entry,input,commit} = JSON.parse(readFileSync(0, 'utf8'));",
    "const show = path => { try { return execFileSync('git', ['show', commit + ':' + path]); } catch { return undefined; } };",
    "const loaded = [entry, entry.replace(/SKILL\\.md$/, 'references/learnings/index.md')].concat(",
    "  [...String(show(entry)).matchAll(/references\\/learnings\\/([a-f0-9]{20})\\.md/g)].map(m => entry.replace(/SKILL\\.md$/, m[0])));",
    "const files = loaded.filter(path => show(path) !== undefined).map(path => ({ path, sha256: createHash('sha256').update(show(path)).digest('hex') }));",
    "const text = files.map(file => String(show(file.path))).join('\\n') + [...String(show(entry.replace(/SKILL\\.md$/, 'references/learnings/index.md')) ?? '').matchAll(/\\.\\/([a-f0-9]{20})\\.md/g)].map(m => String(show(entry.replace(/SKILL\\.md$/, 'references/learnings/' + m[1] + '.md')))).join('\\n');",
    "const passed = input.task === 'existing' || (text.includes(input.needs) && !text.includes('Skip preflight.'));",
    "console.log(JSON.stringify({ passed, loaded: files, ...(passed ? {} : { feedback: 'answer lacked ' + input.needs }) }));",
  ].join('\n'));
  return { root, entry, runner, git };
}

test('Skill learnings support supersede and retire without touching unrelated content', async t => {
  const root = await temp(t);
  const entry = join(root, 'SKILL.md');
  await writeFile(entry, original);
  const write = async draft => {
    for (const change of draft.changes) {
      if (change.content === null) await rm(change.path);
      else {
        await mkdir(join(change.path, '..'), { recursive: true });
        await writeFile(change.path, change.content);
      }
    }
  };
  const high = draftSkillAddition({ entry, priority: 'high', instruction: 'Verify preflight.', sources: ['receipt:a'] });
  assert.equal(high.operation, 'add');
  await write(high);
  assert.deepEqual(listSkillLearnings(await readFile(entry, 'utf8')).map(item => [item.id, item.placement]), [[high.id, 'inline']]);
  const replacement = draftSkillAddition({
    entry, priority: 'normal', instruction: 'Verify staging preflight before migrating.', when: 'migrating staging',
    sources: ['receipt:b'], supersedes: [high.id],
  });
  assert.equal(replacement.operation, 'supersede');
  assert.deepEqual(replacement.supersedes, [high.id]);
  await write(replacement);
  const superseded = await readFile(entry, 'utf8');
  assert.doesNotMatch(superseded, new RegExp(high.id));
  assert.match(superseded, new RegExp(`references/learnings/${replacement.id}\\.md`));
  assert.throws(() => draftSkillRetirement({ entry, retire: [high.id], sources: ['receipt:c'] }), /Unknown Skill learning/);
  const retired = draftSkillRetirement({ entry, retire: [replacement.id], sources: ['receipt:c'], reason: 'covered by the main body' });
  assert.deepEqual(retired.changes.map(change => change.content === null), [false, true]);
  await write(retired);
  assert.equal(await readFile(entry, 'utf8'), original);
  assert.equal(existsSync(join(root, 'references', 'learnings', `${replacement.id}.md`)), false);

  const first = draftSkillAddition({ entry, priority: 'low', instruction: 'First low example.', sources: ['receipt:d'] });
  await write(first);
  const second = draftSkillAddition({ entry, priority: 'low', instruction: 'Second low example.', sources: ['receipt:e'] });
  await write(second);
  assert.deepEqual(listSkillLearnings(await readFile(entry, 'utf8'),
    await readFile(join(root, 'references', 'learnings', 'index.md'), 'utf8')).map(item => item.placement), ['indexed', 'indexed']);
  const retireLow = draftSkillRetirement({ entry, retire: [first.id, second.id], sources: ['receipt:f'] });
  await write(retireLow);
  assert.equal(await readFile(entry, 'utf8'), original);
  assert.equal(existsSync(join(root, 'references', 'learnings', 'index.md')), false);
  // 未提供 supersedes 时 ID 与旧版本保持一致。
  assert.equal(draftSkillAddition({ entry, priority: 'high', instruction: 'Verify preflight.', sources: ['receipt:a'] }).id, high.id);
});

test('Skill replay records pass^k samples, feedback, trailers and version bumps; rollback tolerates later commits', async t => {
  const { root, entry, runner, git } = await fixture(t);
  const support = await temp(t);
  const scenarios = join(support, 'scenarios.json');
  await writeFile(scenarios, JSON.stringify([
    { id: 'missing-preflight', input: { task: 'reproduce', needs: 'Verify preflight.' }, baseline: false, samples: 3 },
    { id: 'existing-flow', input: { task: 'existing' }, baseline: true },
  ]));
  const wrong = join(support, 'wrong.json');
  await writeFile(wrong, JSON.stringify(draftSkillAddition({ entry, priority: 'high', instruction: 'Check logs.', sources: ['receipt:x'] })));
  await assert.rejects(evolve(root, 'skill', 'replay', wrong, '--runner', runner, '--scenarios', scenarios),
    /candidate failed \(0\/3 samples passed\): answer lacked Verify preflight\./);
  const draft = join(support, 'draft.json');
  await writeFile(draft, JSON.stringify(draftSkillAddition({ entry, priority: 'high', instruction: 'Verify preflight.', sources: ['receipt:preflight'] })));
  const receipt = await evolve(root, 'skill', 'replay', draft, '--runner', runner, '--scenarios', scenarios);
  assert.equal(receipt.scenarios[0].candidate.samples.length, 3);
  assert.equal(receipt.scenarios[0].baseline.samples[0].feedback, 'answer lacked Verify preflight.');
  const message = await git('log', '-1', '--format=%B', receipt.candidate);
  assert.match(message, /^chore: 演进 Skill example \(add\)/);
  assert.match(message, /Evolve-Operation: add/);
  assert.match(message, /Evolve-Evidence: receipt:preflight/);
  await evolve(root, 'skill', 'apply', receipt.id);
  assert.match(await readFile(entry, 'utf8'), /version: 1\.0\.1/);
  await writeFile(join(root, 'unrelated.txt'), 'later work');
  await git('add', 'unrelated.txt');
  await git('commit', '-qm', 'Unrelated work');
  const rolledBack = await evolve(root, 'skill', 'rollback', receipt.id);
  assert.equal(rolledBack.replayed, false);
  assert.equal(await readFile(entry, 'utf8'), original);
  assert.equal(await readFile(join(root, 'unrelated.txt'), 'utf8'), 'later work');
  assert.equal((await evolve(root, 'skill', 'rollback', receipt.id)).replayed, true);

  const normal = join(support, 'normal.json');
  await writeFile(normal, JSON.stringify(draftSkillAddition({
    entry, priority: 'normal', instruction: 'Verify preflight.', when: 'running a migration', sources: ['receipt:normal'],
  })));
  const normalReceipt = await evolve(root, 'skill', 'replay', normal, '--runner', runner, '--scenarios', scenarios);
  await evolve(root, 'skill', 'apply', normalReceipt.id);
  const [learning] = listSkillLearnings(await readFile(entry, 'utf8'));
  const retire = join(support, 'retire.json');
  const retireScenarios = join(support, 'retire-scenarios.json');
  await writeFile(retireScenarios, JSON.stringify([
    { id: 'no-preflight-needed', input: { task: 'reproduce', needs: 'Example' }, baseline: false },
    { id: 'existing-flow', input: { task: 'existing' }, baseline: true },
  ]));
  // 让基线失败：被退役的 learning 含有冲突指令。
  await writeFile(join(root, 'skills', 'example', 'references', 'learnings', `${learning.id}.md`),
    (await readFile(join(root, 'skills', 'example', 'references', 'learnings', `${learning.id}.md`), 'utf8')) + 'Skip preflight.\n');
  await git('commit', '-qam', 'Conflicting learning');
  const retirement = await evolve(root, 'skill', 'retire', entry, learning.id, '--evidence', 'receipt:retire', '--reason', 'conflicts');
  await writeFile(retire, JSON.stringify(retirement));
  const retireReceipt = await evolve(root, 'skill', 'replay', retire, '--runner', runner, '--scenarios', retireScenarios);
  assert.ok(retireReceipt.files.includes(`skills/example/references/learnings/${learning.id}.md`));
  await evolve(root, 'skill', 'apply', retireReceipt.id);
  assert.equal(existsSync(join(root, 'skills', 'example', 'references', 'learnings', `${learning.id}.md`)), false);
  assert.match(await git('log', '-1', '--format=%B'), /Evolve-Operation: retire/);
  assert.match(await readFile(entry, 'utf8'), /version: 1\.0\.2/);
});

test('Evolution loop feeds replay failures back, persists a scenario bank and skips addressed signals', async t => {
  const { root, runner } = await fixture(t);
  const agy = join(root, '..', `${root.split(/[\\/]/).at(-1)}-agy.mjs`);
  t.after(() => rm(agy, { force: true }));
  await writeFile(agy, [
    "const prompt = process.argv.find(arg => arg.startsWith('--print=')).slice(8);",
    "if (prompt.includes('confirmation gate')) { console.log(JSON.stringify({ approved: true, reason: 'replay passed', required_changes: [] })); process.exit(0); }",
    "const retry = !prompt.includes('proposing again): none');",
    "console.log(JSON.stringify({ approved: true, operation: 'add', priority: 'high', instruction: retry ? 'Verify preflight.' : 'Check logs.',",
    "  evidence: ['history:preflight'], signals: ['signal-preflight'], rationale: 'attributed correction', needs_revision: [] }));",
  ].join('\n'));
  await writeFile(join(root, '..', `${root.split(/[\\/]/).at(-1)}-history.json`), JSON.stringify({ signals: [
    { id: 'signal-preflight', kind: 'correction', summary: 'Verify preflight first.', sources: ['history:preflight'] },
  ] }));
  const history = join(root, '..', `${root.split(/[\\/]/).at(-1)}-history.json`);
  t.after(() => rm(history, { force: true }));
  const scenarios = join(root, '..', `${root.split(/[\\/]/).at(-1)}-scenarios.json`);
  t.after(() => rm(scenarios, { force: true }));
  await writeFile(scenarios, JSON.stringify([
    { id: 'missing-preflight', input: { task: 'reproduce', needs: 'Verify preflight.' }, baseline: false },
    { id: 'existing-flow', input: { task: 'existing' }, baseline: true },
  ]));
  const evolveLoop = async () => JSON.parse((await execute(process.execPath, [loop, '--skill', 'skills/example/SKILL.md',
    '--iterations', '1', '--scenarios', scenarios, '--history', history, '--runner', runner, '--agy', agy,
    '--memory-cli', cli, '--max-retries', '1', '--auto'], { cwd: root, encoding: 'utf8' })).stdout);
  const result = await evolveLoop();
  const [round] = result.rounds;
  assert.equal(result.status, 'completed');
  assert.equal(round.status, 'applied');
  assert.equal(round.retries, 1);
  assert.deepEqual(round.addressed_signals, ['signal-preflight']);
  const bank = JSON.parse(await readFile(join(root, '.evolve', 'evolution', 'bank', 'example.json'), 'utf8'));
  assert.deepEqual(bank.scenarios.map(item => [item.id, item.baseline]), [['missing-preflight', true], ['existing-flow', true]]);
  assert.deepEqual(bank.addressed_signals.map(item => item.id), ['signal-preflight']);

  await writeFile(scenarios, JSON.stringify([
    { id: 'new-failure', input: { task: 'reproduce', needs: 'Unwritten guidance.' }, baseline: false },
    { id: 'existing-flow', input: { task: 'existing' }, baseline: true },
  ]));
  const second = await evolveLoop();
  assert.equal(second.bank_scenarios, 1);
  assert.equal(second.rounds[0].status, 'no_attributable_signals');
  assert.equal(second.rounds[0].addressed_signals, 1);
});

test('Learning usage counts exposures from sealed Run reads and flags retire candidates', async t => {
  const { root, entry, git } = await fixture(t);
  const draft = draftSkillAddition({ entry, priority: 'normal', instruction: 'Verify preflight.', when: 'migrating', sources: ['receipt:u'] });
  for (const change of draft.changes) {
    await mkdir(join(change.path, '..'), { recursive: true });
    await writeFile(change.path, change.content);
  }
  await git('add', '.');
  await git('commit', '-qm', 'Add learning');
  const commit = await git('rev-parse', 'HEAD');
  const skill = { skill_id: 'example', commit, tree: commit, package_path: 'skills/example', entry: 'SKILL.md' };
  const doc = `references/learnings/${draft.id}.md`;
  const runs = [
    { id: 'r1', status: 'sealed', verdict: 'done_with_concerns', reads: { 'SKILL.md': 'x', [doc]: 'y' } },
    { id: 'r2', status: 'failed', reads: { 'SKILL.md': 'x', [doc]: 'y' } },
    { id: 'r3', status: 'sealed', verdict: 'done', reads: { 'SKILL.md': 'x', [doc]: 'y' } },
    { id: 'r4', status: 'sealed', verdict: 'done', reads: { 'SKILL.md': 'x' }, retry_of_run_id: 'r2' },
    { id: 'r5', status: 'running', reads: { 'SKILL.md': 'x', [doc]: 'y' } },
  ].map(run => ({ ...run, skill, task: { command: 'example', args: [], goal: '' }, finished_at: '2026-11-17T00:00:00.000Z' }));
  await mkdir(join(root, '.evolve'), { recursive: true });
  const { DatabaseSync } = await import('../dist/common.js');
  const db = new DatabaseSync(join(root, '.evolve', 'workflow.db'));
  try {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
    db.prepare('INSERT INTO sessions (id, body) VALUES (?, ?)').run('s1', JSON.stringify({ id: 's1', runs }));
  } finally {
    db.close();
  }
  const usage = await evolve(root, 'skill', 'learnings', entry);
  assert.equal(usage.observed_runs, 4);
  assert.deepEqual(usage.learnings.map(item => [item.id, item.eligible_runs, item.exposures, item.clean, item.non_clean, item.recommendation]),
    [[draft.id, 4, 3, 1, 2, 'retire_candidate']]);
});

test('Learning bloat routes to Skill design and memory updates keep prior versions', async t => {
  const { root, entry } = await fixture(t);
  let text = original;
  for (const instruction of ['One.', 'Two.', 'Three.', 'Four.']) {
    await writeFile(entry, text);
    text = draftSkillAddition({ entry, priority: 'high', instruction, sources: ['receipt:bloat'] }).changes[0].content;
  }
  await writeFile(entry, text);
  const usage = await evolve(root, 'skill', 'learnings', entry);
  assert.equal(usage.inline, 4);
  assert.equal(usage.consolidate_recommended, true);
  assert.equal(usage.observed_runs, 0);
  const decision = decideSkillRoute({ content: 'Add one more check.', sources: ['receipt:bloat'], skillId: 'example', learnings: usage });
  assert.equal(decision.route, 'skill-design');
  assert.match(decision.reasons.join('\n'), /learning 已膨胀/);

  const memory = new MemoryStore(join(root, 'memory.db'));
  try {
    await memory.put({ id: 'm1', content: 'first' });
    await memory.update('m1', { content: 'second' });
    await memory.put({ id: 'm1', content: 'second' });
    memory.delete('m1');
    assert.deepEqual(memory.history('m1').map(item => [item.version, item.content, item.reason]), [[2, 'second', 'delete'], [1, 'first', 'update']]);
  } finally {
    // 先关闭数据库，再由临时目录清理删除 WAL 文件。
    memory.close();
  }
  const cliHistory = await evolve(root, 'kb', 'history', 'm1', '--db', join(root, 'memory.db'), '--scope', 'project');
  assert.equal(cliHistory.current, null);
  assert.equal(cliHistory.history.length, 2);
});
