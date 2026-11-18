import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
const baselineSkillSource = fileURLToPath(new URL('./fixtures/release-gate-e2e/baseline', import.meta.url));
const task = JSON.parse(readFileSync(new URL('./fixtures/release-gate-e2e/task.json', import.meta.url), 'utf8'));
const scenariosPath = fileURLToPath(new URL('./fixtures/release-gate-e2e/scenarios.json', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'release-gate-flow-'));
const root = join(fixture, 'project');
const support = join(fixture, 'support');
mkdirSync(root, { recursive: true });
mkdirSync(support, { recursive: true });
mkdirSync(join(fixture, 'home'), { recursive: true });

const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: options.cwd ?? root, env: options.env ?? process.env,
  encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options,
});
const git = (...args) => run('git', args).trim();
const agent = (...args) => JSON.parse(run(process.execPath, [cli, '--root', root, ...args]));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function copySkill() {
  const entry = join(root, 'skills', 'release-gate', 'SKILL.md');
  const reference = join(root, 'skills', 'release-gate', 'references', 'check-checksum.md');
  mkdirSync(dirname(reference), { recursive: true });
  writeFileSync(entry, readFileSync(join(baselineSkillSource, 'SKILL.md')));
  writeFileSync(reference, readFileSync(join(baselineSkillSource, 'references', 'check-checksum.md')));
  return entry;
}

function seedWiki() {
  const changes = task.seed_knowledge.wiki_entries.map(entry => ({
    operation: 'create', entry: entry.entry, title: entry.title, mode: entry.mode,
    scope: entry.scope, categories: entry.categories,
    keywords: entry.keywords, body: entry.body,
  }));
  for (const [index, change] of changes.entries()) {
    const path = join(support, `wiki-change-${index}.json`);
    writeFileSync(path, JSON.stringify(change));
    const proposed = agent('kb', 'propose', path, '--evidence', task.seed_knowledge.wiki_entries[index].evidence);
    agent('kb', 'apply', proposed.id);
  }
  agent('kb', 'build');
}

function seedMemory(db) {
  for (const memory of task.seed_knowledge.memories) {
    agent('kb', 'add', memory.content, '--db', db, '--id', memory.id, '--type', memory.type,
      '--scene', memory.scene, '--session', memory.session, '--priority', String(memory.priority));
  }
}

function writeRunner() {
  const runner = join(support, 'release-gate-runner.mjs');
  writeFileSync(runner, `
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const { entry, input } = JSON.parse(readFileSync(0, 'utf8').replace(/^\\uFEFF/, ''));
const root = process.env.RELEASE_GATE_ROOT;
const cli = process.env.AGENT_MEMORY_CLI;
const db = process.env.RELEASE_GATE_DB;
const body = readFileSync(entry, 'utf8');
const normalizedBody = body.toLowerCase();
const traceFile = root + '/.evolve/release-trace-' + input.id + '.json';
const call = (...args) => JSON.parse(execFileSync(process.execPath, [cli, '--root', root, ...args, '--trace-file', traceFile], {
  env: process.env, encoding: 'utf8', windowsHide: true,
}));
const query = input.query;
let references;
if (normalizedBody.includes('--kind constraint')) {
  call('search', query, '--from', 'kb', '--mode', 'context', '--kind', 'constraint', '--task', 'release', '--category', 'review');
}
if (normalizedBody.includes('--kind reference')) {
  references = call('kb', 'search', query, '--kind', 'reference', '--task', 'release');
}
let memories;
if (input.environment === 'production' && normalizedBody.includes('--kind episodic')) {
  memories = call('kb', 'search', query, '--db', db, '--kind', 'episodic', '--scene', 'release');
}
if (references?.results?.length && normalizedBody.includes('kb get')) {
  const preferred = input.environment === 'production' ? 'entries/prod-freeze-protocol' : 'entries/release-checksum';
  const selected = references.results.find(item => item.rawId === preferred || item.id === preferred) ?? references.results[0];
  const searchId = selected?.search_id ?? references.knowledge_reads?.searches.at(-1)?.search_id;
  if (selected) call('kb', 'get', selected.id, '--kind', 'reference', '--task', 'release', ...(searchId ? ['--from-search', searchId] : []));
}
if (input.environment !== 'production' && normalizedBody.includes('kb get')) {
  call('kb', 'get', 'entries/release-checksum');
}
if (memories?.results?.length && normalizedBody.includes('kb get')) {
  for (const memory of memories.results.filter(item => item.id === 'mem-prod-freeze-01')) {
    const searchId = memory.search_id ?? memories.knowledge_reads?.searches.at(-1)?.search_id;
    call('kb', 'get', memory.id, '--db', db, '--kind', 'episodic', ...(searchId ? ['--from-search', searchId] : []));
  }
}
const trace = JSON.parse(readFileSync(traceFile, 'utf8'));
const freeze = input.environment === 'production' &&
  memories?.results?.some(item => item.id === 'mem-prod-freeze-01') &&
  references?.results?.some(item => item.id === 'entries/prod-freeze-protocol');
const decision = freeze ? 'blocked' : 'approved';
const artifact = {
  schema_version: 'release-gate/1.0', environment: input.environment,
  artifact_sha256: input.artifact_sha256, decision,
  reasons: [freeze ? 'Blocked by active production freeze.' : 'Checksum verified.'],
  consulted_knowledge_ids: [...new Set([...(references?.results ?? []).map(item => item.id), ...trace.constraints_bound.map(item => item.knowledge_id)])],
  consulted_memory_ids: memories?.results?.map(item => item.id) ?? [],
};
const bodyHash = createHash('sha256').update(body).digest('hex');
console.log(JSON.stringify({
  passed: input.environment === 'production' ? decision === 'blocked' : decision === 'approved',
  loaded: [{ path: entry, sha256: bodyHash }],
  artifact, knowledge_reads: trace,
}));
`);
  return runner;
}

try {
  const entry = copySkill();
  git('init', '-q');
  git('config', 'user.name', 'Release gate flow');
  git('config', 'user.email', 'release-gate@example.invalid');
  git('config', 'core.autocrlf', 'false');
  seedWiki();
  const db = join(root, 'memory.db');
  seedMemory(db);
  git('add', '.');
  git('commit', '-qm', 'Release gate baseline');
  const base = git('rev-parse', 'HEAD');
  const runner = writeRunner();
  const env = { ...process.env, HOME: join(fixture, 'home'), USERPROFILE: join(fixture, 'home'),
    RELEASE_GATE_ROOT: root, RELEASE_GATE_DB: db, AGENT_MEMORY_CLI: cli };
  Object.assign(process.env, env);
  const baseline = JSON.parse(run(process.execPath, [runner], {
    cwd: root, env, input: JSON.stringify({
      id: 'baseline-production', entry: 'skills/release-gate/SKILL.md', commit: base,
      input: { environment: 'production', artifact_sha256: task.expected_artifact_after_fix.schema_version.replace('release-gate/1.0', 'sha256:4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a'), query: 'production release freeze' },
    }),
  }));
  assert.equal(baseline.passed, false);
  assert.deepEqual(baseline.artifact.consulted_memory_ids, []);

  const memory = agent('kb', 'search', 'production release freeze', '--db', db, '--scene', 'release');
  assert.equal(memory.results[0].id, 'mem-prod-freeze-01');
  const instruction = 'Before release gates, run evolve kb search "<query>" --kind reference --task release --trace; for production also search --kind episodic, run evolve kb get on freeze IDs, and block before writing outputs/release-gate.json.';
  const draft = agent('skill', 'draft', entry, instruction, '--priority', 'high', '--when', 'every release gate invocation', '--evidence', 'e2e:release-gate:baseline-production');
  const draftPath = join(support, 'release-gate-draft.json');
  writeFileSync(draftPath, JSON.stringify(draft));
  const scenarios = JSON.parse(readFileSync(scenariosPath, 'utf8'));
  const scenariosWithInput = scenarios.map(scenario => ({
    ...scenario,
    input: { ...scenario.input, artifact_sha256: 'sha256:4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a' },
  }));
  const scenariosWithInputPath = join(support, 'scenarios.json');
  writeFileSync(scenariosWithInputPath, JSON.stringify(scenariosWithInput));
  const replay = agent('skill', 'replay', draftPath, '--runner', runner, '--scenarios', scenariosWithInputPath);
  assert.equal(replay.scenarios[0].baseline.passed, false);
  assert.equal(replay.scenarios[0].candidate.passed, true);
  assert.ok(replay.scenarios[0].candidate.knowledgeReads.reads.some(read => read.id === 'mem-prod-freeze-01'));
  assert.ok(replay.scenarios[0].candidate.knowledgeReads.reads.some(read => read.id === 'entries/prod-freeze-protocol'));
  const applied = agent('skill', 'apply', replay.id);
  assert.equal(applied.replayed, false);
  const after = JSON.parse(run(process.execPath, [runner], {
    cwd: root, env, input: JSON.stringify({
      id: 'after-fix-production', entry: 'skills/release-gate/SKILL.md', commit: applied.commit,
      input: { environment: 'production', artifact_sha256: 'sha256:4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a', query: 'production release freeze' },
    }),
  }));
  assert.equal(after.passed, true);
  assert.equal(after.artifact.decision, 'blocked');
  agent('skill', 'rollback', replay.id);
  assert.equal(readFileSync(entry, 'utf8'), readFileSync(join(baselineSkillSource, 'SKILL.md'), 'utf8'));
  console.log(JSON.stringify({
    task: task.test_id, baseline: baseline.artifact, memory_hit: memory.results[0],
    problems: ['baseline approved production during active freeze', 'baseline omitted release Memory and freeze reference reads'],
    fix: { priority: draft.priority, instruction: draft.instruction, evidence: draft.sources },
    replay: {
      id: replay.id,
      candidate_passed: replay.scenarios[0].candidate.passed,
      knowledge_reads: replay.scenarios[0].candidate.knowledgeReads,
    },
    after_fix: after.artifact, rollback: 'verified',
  }, null, 2));
} finally {
  if (!process.env.KEEP_RELEASE_GATE_FLOW) rmSync(fixture, { recursive: true, force: true });
}
