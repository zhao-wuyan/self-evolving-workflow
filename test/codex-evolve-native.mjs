import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'evolve-native-loop-'));
const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
const loop = fileURLToPath(new URL('../skills/workflow-evolve/scripts/evolve-loop.mjs', import.meta.url));
const entry = 'skills/migration-preflight/SKILL.md';
const db = join(root, 'memory.db');
const evidence = 'history:staging-preflight:correction';
const env = { ...process.env, AGENT_MEMORY_CLI: cli, AGENT_MEMORY_DB: db,
  MAESTRO_REPLAY_CLI: join(root, 'unused-host.js'), AGENT_MEMORY_REPLAY_CLI: join(root, 'unused-alias.js') };
const run = (command, ...args) => execFileSync(command, args, {
  cwd: root, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
});
const writeJson = (name, value) => writeFileSync(join(root, name), JSON.stringify(value));

try {
  mkdirSync(join(root, dirname(entry)), { recursive: true });
  writeFileSync(join(root, entry), [
    '---', 'name: migration-preflight', '---', '# Migration preflight', '',
    'Read relevant migration memories before selecting commands.',
    'For staging preflight, return the schema check and migration commands on separate lines.',
    'Use `schema check staging` and `migrate staging` for staging preflight.',
    'For tracker status, return `migrate status`.', '',
  ].join('\n'));
  run('git', 'init', '-q');
  run('git', 'config', 'core.autocrlf', 'false');
  run('git', 'config', 'user.name', 'Evolve fixture');
  run('git', 'config', 'user.email', 'evolve@example.invalid');
  run('git', 'add', entry);
  run('git', 'commit', '-qm', 'Migration preflight baseline');
  run(process.execPath, cli, 'kb', 'add', 'Staging migration preflight starts with a schema check.',
    '--db', db, '--id', 'staging-schema-check');

  writeJson('scenarios.json', [
    { id: 'staging-preflight', baseline: false, input: {
      task: 'Prepare the two staging migration preflight commands. Search for staging migration and read the matching memory. Return the commands in order, one per line.',
      expected: 'schema check staging\nmigrate staging --dry-run',
    }, knowledge_reads: { searched_sources: ['memory'], loaded_ids: ['staging-schema-check'] } },
    { id: 'tracker-status', baseline: true, input: {
      task: 'Return the migration tracker status command.', expected: 'migrate status',
    } },
  ]);
  writeJson('history.json', { signals: [{
    kind: 'correction', summary: 'For staging preflight, run the schema check first and use migrate staging --dry-run as the second command.',
    sources: [evidence],
  }] });

  const result = JSON.parse(run(process.execPath, loop, '--skill', entry, '--iterations', '1',
    '--scenarios', 'scenarios.json', '--history', 'history.json', '--auto'));
  const [round] = result.rounds;
  assert.equal(round.status, 'applied');
  assert.equal(round.agy.approved, true);
  assert.equal(run('git', 'rev-parse', 'HEAD').trim(), round.applied.commit);
  assert.ok(round.verified.every(item => item.observation.passed));
  const replay = JSON.parse(readFileSync(join(result.output_dir, 'round-1', 'replay.json'), 'utf8'));
  assert.deepEqual(replay.scenarios.map(item => [item.baseline.passed, item.candidate.passed]), [[false, true], [true, true]]);
  console.log('Codex, Agent Memory, and Agy verified the native automatic evolution loop.');
} finally {
  // 临时仓库由本次验收独占。
  rmSync(root, { recursive: true, force: true });
}
