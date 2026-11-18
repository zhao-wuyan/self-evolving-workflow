import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
const runner = fileURLToPath(new URL('../skills/workflow-evolve/scripts/codex-replay.mjs', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'evolve-codex-replay-'));
const repo = join(fixture, 'repo');
const env = { ...process.env, AGENT_MEMORY_DB: join(fixture, 'memory.db') };
const packagePath = 'skills/migration-preflight';
const entry = `${packagePath}/SKILL.md`;
const baseline = [
  '---', 'name: migration-preflight', 'description: Select a synthetic migration command for a request.',
  'contract:', '  contract_version: 2.1', '  produces: []', '  consumes: []', '---', '',
  '# Migration preflight', '',
  'For a migration request, return exactly `migrate staging` unless an applicable learning changes it.',
  'For a status request, return exactly `migrate status`.', '',
].join('\n');
const migration = { task: 'Prepare a migration request for the staging database.', expected: 'migrate staging --dry-run' };
const status = { task: 'Handle a status request for the migration tracker.', expected: 'migrate status' };
const invoke = (command, args, input) => execFileSync(command, args, {
  cwd: repo, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
});
const git = (...args) => invoke('git', args).trim();
const agent = (...args) => JSON.parse(invoke(process.execPath, [cli, '--root', repo, ...args]));

try {
  mkdirSync(join(repo, packagePath), { recursive: true });
  writeFileSync(join(repo, entry), baseline);
  git('init', '-q');
  git('config', 'user.name', 'Evolve replay fixture');
  git('config', 'user.email', 'evolve-replay@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('add', entry);
  git('commit', '-qm', 'Migration preflight fixture');
  agent('kb', 'add', 'Staging migration checks record schema and row counts before applying changes.',
    '--db', env.AGENT_MEMORY_DB, '--id', 'staging-checks');

  const draft = join(fixture, 'draft.json');
  const cases = join(fixture, 'cases.json');
  writeFileSync(draft, JSON.stringify(agent('skill', 'draft', entry,
    'For migration requests targeting staging, return exactly `migrate staging --dry-run`.',
    '--priority', 'normal', '--when', 'handling a migration request for staging',
    '--evidence', 'fixture:staging-preflight-correction')));
  writeFileSync(cases, JSON.stringify([
    { id: 'staging-preflight', input: migration, baseline: false },
    { id: 'status-regression', input: status, baseline: true },
  ]));
  const receipt = agent('skill', 'replay', draft, '--runner', runner, '--scenarios', cases);
  assert.deepEqual(receipt.scenarios.map(item => [item.baseline.passed, item.candidate.passed]), [[false, true], [true, true]]);
  assert.ok(receipt.scenarios.every(item => item.candidate.knowledgeReads.searches.some(search => search.source === 'memory')));
  const learning = receipt.files.find(path => path.includes('/references/learnings/'));
  assert.ok(learning);
  assert.ok(receipt.scenarios[0].candidate.loaded.some(file => file.path === learning));
  assert.ok(!receipt.scenarios[1].candidate.loaded.some(file => file.path === learning));
  console.log('Codex replay passed the staging regression and preserved the status case.');

  assert.equal(agent('skill', 'apply', receipt.id).commit, receipt.candidate);
  const applied = JSON.parse(invoke(process.execPath, [runner], JSON.stringify({
    id: 'verify-applied', input: migration, entry, commit: git('rev-parse', 'HEAD'),
  })));
  assert.equal(applied.passed, true);
  assert.deepEqual(applied.loaded, receipt.scenarios[0].candidate.loaded);
  agent('skill', 'rollback', receipt.id);
  assert.equal(readFileSync(join(repo, entry), 'utf8'), baseline);
  const rolledBack = JSON.parse(invoke(process.execPath, [runner], JSON.stringify({
    id: 'verify-rollback', input: migration, entry, commit: git('rev-parse', 'HEAD'),
  })));
  assert.equal(rolledBack.passed, receipt.scenarios[0].baseline.passed);
  assert.deepEqual(rolledBack.loaded, receipt.scenarios[0].baseline.loaded);
  console.log('Codex loaded the applied revision and reproduced the baseline after rollback.');

  const index = `${packagePath}/references/learnings/index.md`;
  const reference = {
    task: 'Explicitly consult the optional Skill references for the staging timeout troubleshooting example. Return the documented command if present. If there is no optional reference, return exactly `no example`.',
    expected: 'migrate status --timeout 45',
  };
  const lowDraft = agent('skill', 'draft', entry,
    'For the staging timeout example, return exactly `migrate status --timeout 45`.',
    '--priority', 'low', '--when', 'staging timeout troubleshooting', '--evidence', 'fixture:timeout-case');
  const lowDocument = `${packagePath}/references/learnings/${lowDraft.id}.md`;
  // 旧草稿保存的是单个参考文件，回放时使用固定版本的完整索引链。
  const documentChange = lowDraft.changes.find(change => change.path.replaceAll('\\', '/').endsWith(lowDocument));
  assert.ok(documentChange);
  writeFileSync(draft, JSON.stringify({ ...lowDraft, changes: [documentChange] }));
  writeFileSync(cases, JSON.stringify([
    { id: 'look-up-timeout', input: reference, baseline: false },
    { id: 'status-without-lookup', input: status, baseline: true },
  ]));
  const lowReceipt = agent('skill', 'replay', draft, '--runner', runner, '--scenarios', cases);
  assert.ok(lowReceipt.scenarios[0].candidate.loaded.some(file => file.path === index));
  assert.ok(lowReceipt.scenarios[0].candidate.loaded.some(file => file.path === lowDocument));
  assert.deepEqual(lowReceipt.scenarios[1].candidate.loaded.map(file => file.path), [entry]);
  console.log('Codex followed the optional reference index only for the explicit lookup.');

  writeFileSync(draft, JSON.stringify(agent('skill', 'draft', entry,
    'For any staging migration request, include `--dry-run` in the returned command.',
    '--priority', 'high', '--evidence', 'fixture:staging-preflight-gate')));
  writeFileSync(cases, JSON.stringify([
    { id: 'required-staging-gate', input: migration, baseline: false },
    { id: 'status-with-gate', input: status, baseline: true },
  ]));
  const highReceipt = agent('skill', 'replay', draft, '--runner', runner, '--scenarios', cases);
  assert.deepEqual(highReceipt.files, [entry]);
  assert.deepEqual(highReceipt.scenarios.map(item => item.candidate.loaded.map(file => file.path)), [[entry], [entry]]);
  console.log('Codex applied the required staging gate after reading the entry.');
} finally {
  assert.match(realpathSync(fixture), /[\\/]evolve-codex-replay-[a-zA-Z0-9]+$/);
  rmSync(fixture, { recursive: true, force: true });
}
