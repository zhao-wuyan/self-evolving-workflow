import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './evolve-workflow-support.mjs';
import { OpenVikingClient } from '../dist/openviking/client.js';
import { privateProjectUri } from '../dist/openviking/config.js';
import { skillAssets } from '../dist/openviking/git.js';
import { exportWiki, exportMemory, fileRecord } from '../dist/openviking/knowledge.js';
import { publishRelease, sha256, stableJson } from '../dist/openviking/assets.js';

export async function protocol(t) {
  const worker = new Worker(new URL('./openviking-protocol.mjs', import.meta.url));
  t.after(() => worker.terminate());
  const url = await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', message => resolve(message.url)); });
  let sequence = 0;
  const pending = new Map();
  worker.on('message', message => { if (pending.has(message.id)) { pending.get(message.id)(message.value); pending.delete(message.id); } });
  const send = data => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); worker.postMessage({ id, ...data }); });
  return { url, update: update => send({ update }), inspect: () => send({ inspect: true }) };
}

const entry = 'skills/sample/SKILL.md';
const environments = new WeakMap();
export function projectFixture(t, server, options = {}) {
  if (!environments.has(t)) {
    const old = process.env.EVOLVE_OPENVIKING_CONFIG;
    environments.set(t, old);
    t.after(() => { if (old === undefined) delete process.env.EVOLVE_OPENVIKING_CONFIG; else process.env.EVOLVE_OPENVIKING_CONFIG = old; });
  }
  const f = fixture('evolve-openviking-');
  const disposers = [];
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); f.cleanup(); });
  f.git('rm', '-r', 'skills');
  if (options.driver) f.evolve('skill', 'install', 'workflow-evolve');
  f.write(entry, '---\nname: sample\ncontract:\n  consumes: []\n  produces: []\n  gates: {entry: [], exit: []}\n---\n# Sample deployment\nPrepare a release from the supplied build.\n');
  f.write('skills/sample/scripts/release.mjs', `export function release(input, requireMigration) {
  if (requireMigration && !input.migrationApproved) return { decision: 'blocked', artifact: null };
  return { decision: 'released', artifact: { build: input.build } };
}\n`);
  f.write('tools/replay.mjs', `import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const request = JSON.parse(readFileSync(0, 'utf8'));
const body = readFileSync(request.entry, 'utf8');
if (process.env.FIXTURE_FAIL_AFTER_APPLY === '1' && process.cwd() === process.env.FIXTURE_PROJECT_ROOT && body.includes('migration_approval')) throw new Error('Post-apply business runner failed');
const script = 'skills/sample/scripts/release.mjs';
const {release} = await import(pathToFileURL(join(process.cwd(), script)).href);
const result = release(request.input, body.includes('migration_approval'));
const passed = request.input.migrationApproved ? result.decision === 'released' && result.artifact.build === request.input.build
  : result.decision === 'blocked' && result.artifact === null;
console.log(JSON.stringify({passed, loaded: [request.entry, script].map(path => ({path, sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}))}));\n`);
  f.write('tools/scenarios.json', JSON.stringify([
    { id: 'approved-release', input: { build: '00123', migrationApproved: true }, baseline: true },
    { id: 'unapproved-migration', input: { build: '00123', migrationApproved: false }, baseline: false },
  ]));
  f.write('evolution.json', JSON.stringify({ schema_version: 'evolve-openviking-policy/1.0', targets: [{ entry, runner: 'tools/replay.mjs', scenarios: 'tools/scenarios.json' }] }));
  f.git('add', 'skills', 'tools', 'evolution.json'); f.git('commit', '-qm', '测试: 建立业务回放项目');
  const config = join(f.root, '.agent-memory', 'ovcli.conf');
  mkdirSync(join(f.root, '.agent-memory'), { recursive: true });
  writeFileSync(config, JSON.stringify({ url: server.url, api_key: 'fixture-key' }));
  process.env.EVOLVE_OPENVIKING_CONFIG = config; f.env.EVOLVE_OPENVIKING_CONFIG = config;
  f.env.FIXTURE_PROJECT_ROOT = f.root;
  const id = options.id ?? randomUUID();
  const project = { schema_version: 'evolve-openviking-project/1.0', project_id: id, account_id: 'fixture-account', user_id: 'fixture',
    root_uri: privateProjectUri('fixture', id), evolution_policy: 'evolution.json', enabled: true, failure_policy: 'local' };
  if (options.profile !== false) {
    f.write('.evolve/openviking.json', JSON.stringify(project)); f.git('add', '-f', '.evolve/openviking.json'); f.git('commit', '-qm', '测试: 固定项目描述');
  }
  return { ...f, project, client: new OpenVikingClient(), entry, dispose: callback => disposers.push(callback) };
}

let tick = 0;
export function releaseFromProject(f, parent = null) {
  const commit = f.git('rev-parse', 'HEAD');
  const skills = skillAssets(f.root, commit);
  const wiki = exportWiki(f.root);
  const memory = exportMemory(f.root);
  for (const [path, body] of [...wiki.bodies, ...memory.bodies]) skills.bytes.set(path, body);
  const manifest = { schema_version: 'evolve-project-release/1.0', project_id: f.project.project_id, account_id: f.project.account_id, user_id: f.project.user_id,
    parent, created_at: new Date(Date.UTC(2026, 10, 16, 0, 0, tick++)).toISOString(), source_commit: commit, cli_version: '0.1.5',
    upstream: { cli_version: '0.1.5', skills_sha256: sha256(stableJson(skills.files)) },
    files: [...skills.files, ...[...wiki.bodies, ...memory.bodies].map(([path, body]) => fileRecord(path, body))], wiki: wiki.wiki, memory: memory.memory,
    verification: { kind: parent ? 'knowledge' : 'bootstrap', session_id: parent ? 'fixture' : null, replay_ids: [], validation_id: null } };
  return { manifest, bytes: skills.bytes };
}
export async function seed(f) {
  const release = releaseFromProject(f);
  const head = await publishRelease(f.client, f.project, release.manifest, release.bytes, null);
  return { ...release, head };
}
export function fakeAgy(f) {
  const path = join(f.root, '.agent-memory', 'agy-fixture.mjs');
  writeFileSync(path, `const prompt=process.argv.find(arg=>arg.startsWith('--print=')).slice(8);
if(prompt.includes('final Agy confirmation')) console.log(JSON.stringify({approved:process.env.FIXTURE_REJECT_CONFIRM!=='1',reason:'Business replay checked'}));
else console.log(JSON.stringify({approved:process.env.FIXTURE_REJECT_DISCUSSION!=='1',priority:'high',instruction:'Require migration_approval before creating a release.',evidence:[process.env.FIXTURE_BAD_SOURCE==='1'?'unrelated:source':prompt.match(/evolve:[A-Za-z0-9_-]+#run-[A-Za-z0-9_-]+/)[0]]}));\n`);
  f.env.AGY_EXECUTABLE = path;
  return path;
}
export function completeSample(f, session, summary = 'Deployment finished') {
  const run = f.next(session);
  f.evolve('run', 'skill-read', run.run_id, '--session', session);
  f.finish(session, run, summary);
  return run;
}
