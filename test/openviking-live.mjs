import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const source = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'evolve-openviking-live-'));
const prefix = join(temporary, 'prefix');
const a = join(temporary, 'a');
const b = join(temporary, 'b');
const projectId = randomUUID();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let model;
const evidence = { installation: 'not_run', service: 'not_run', project_id: projectId,
  session_signal_model: 'local_protocol_fixture', agy: 'local_protocol_fixture', real_model_evolution: 'not_verified' };

function execute(command, args, cwd = source, options = {}) {
  return execFileSync(command, args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024, timeout: 600_000, ...options }).trim();
}
function cmdFile(command, args, cwd, options = {}) {
  if (process.platform !== 'win32') return execute(command, args, cwd, options);
  const quote = value => {
    if (/["%!&|<>^\r\n]/.test(value)) throw new Error('Unsafe Windows command argument');
    return '"' + value + '"';
  };
  return execute(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + [command, ...args].map(quote).join(' ') + '"'], cwd, { ...options, windowsVerbatimArguments: true });
}
function npm(args) {
  const script = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(script)) return execute(process.execPath, [script, ...args]);
  return cmdFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, source);
}
function git(root, ...args) { return execute('git', args, root); }
function write(root, path, body) { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); }
const bin = join(prefix, process.platform === 'win32' ? 'evolve.cmd' : 'bin/evolve');
const env = { ...process.env };
function evolve(root, ...args) {
  evidence.command = args.slice(0, 2).filter(arg => /^[a-z-]+$/.test(arg)).join(' ');
  return JSON.parse(cmdFile(bin, ['--root', root, ...args], root, { env }));
}
function fence(root, session) {
  const state = evolve(root, 'session', 'status', '--session', session);
  return ['--session', session, '--actor', 'live', '--expected-orchestration-revision', String(state.revision)];
}
function finishRun(root, session, run, summary) {
  return evolve(root, 'run', 'complete', run.run_id, ...fence(root, session), '--expected-run-revision', '0', '--summary', summary);
}
function propose(root, id, extra = {}) {
  const path = join(temporary, id + '.json');
  writeFileSync(path, JSON.stringify({ operation: 'create', entry: 'entries/' + id, title: id, mode: 'constraint', scope: ['project'],
    repositories: [projectId], body: 'Deployment safety rule ' + id, ...extra }));
  const preview = evolve(root, 'kb', 'propose', path, '--evidence', 'live:explicit-test-approval');
  evolve(root, 'kb', 'apply', preview.id);
}

try {
  evidence.phase = 'pack';
  const pack = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]));
  const tarball = join(temporary, pack[0].filename);
  evidence.phase = 'install';
  npm(['install', '--global', '--prefix', prefix, tarball, '--ignore-scripts']);
  evidence.phase = 'public-bin-help';
  assert.ok(existsSync(bin));
  const help = cmdFile(bin, ['--help'], source, { env });
  assert.match(help, /openviking init/);
  evidence.installation = 'passed'; evidence.public_bin = bin;
  evidence.phase = 'service-connection';

  const connectionPath = process.env.EVOLVE_OPENVIKING_CONFIG ?? join(homedir(), '.openviking', 'ovcli.conf');
  if (!existsSync(connectionPath)) throw new Error('OPENVIKING_CONFIG_MISSING: provide EVOLVE_OPENVIKING_CONFIG or ~/.openviking/ovcli.conf');
  const connection = JSON.parse(readFileSync(connectionPath, 'utf8').replace(/^\uFEFF/, ''));
  const healthResponse = await fetch(new URL('/health', connection.url), { headers: { 'X-API-Key': connection.api_key }, signal: AbortSignal.timeout(120_000) });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  evidence.service_version = health.version;
  env.EVOLVE_OPENVIKING_CONFIG = resolve(connectionPath);
  mkdirSync(a); git(a, 'init', '-q'); git(a, 'config', 'core.autocrlf', 'false');
  git(a, 'config', 'user.name', 'OpenViking isolated live'); git(a, 'config', 'user.email', 'openviking-live@example.invalid');
  write(a, '.gitignore', '.agent-memory/\nindex.db*\n');
  write(a, 'skills/sample/SKILL.md', '---\nname: sample\ncontract:\n  consumes: []\n  produces: []\n  gates: {entry: [], exit: []}\n---\n# Release gate\nPrepare a release from the supplied build.\n');
  write(a, 'skills/sample/scripts/release.mjs', `export function release(input, requireMigration) {
  return requireMigration && !input.migrationApproved ? {decision:'blocked',artifact:null} : {decision:'released',artifact:{build:input.build}};
}\n`);
  const binary = Buffer.from([137, 80, 78, 71, 13, 10, 0, 255, 99, 42]);
  write(a, 'skills/sample/assets/icon.png', binary); write(a, 'skills/sample/assets/empty', Buffer.alloc(0));
  write(a, 'skills/sample/assets/crlf.txt', Buffer.from('\uFEFFexact\r\nbytes\r\n'));
  write(a, 'skills/sample/run.sh', '#!/bin/sh\nprintf live\n');
  write(a, 'tools/replay.mjs', `import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; import {pathToFileURL} from 'node:url'; import {join} from 'node:path';
const request=JSON.parse(readFileSync(0,'utf8'));const body=readFileSync(request.entry,'utf8');const script='skills/sample/scripts/release.mjs';
const {release}=await import(pathToFileURL(join(process.cwd(),script)).href);const result=release(request.input,body.includes('migration_approval'));
console.log(JSON.stringify({passed:request.input.migrationApproved?result.decision==='released'&&result.artifact.build===request.input.build:result.decision==='blocked'&&result.artifact===null,
loaded:[request.entry,script].map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}))}));\n`);
  write(a, 'tools/scenarios.json', JSON.stringify([
    { id: 'approved', baseline: true, input: { migrationApproved: true, build: '00123' } },
    { id: 'unapproved', baseline: false, input: { migrationApproved: false, build: '00123' } },
  ]));
  write(a, 'evolution.json', JSON.stringify({ schema_version: 'evolve-openviking-policy/1.0', targets: [
    { entry: 'skills/sample/SKILL.md', runner: 'tools/replay.mjs', scenarios: 'tools/scenarios.json' },
  ] }));
  git(a, 'add', '.'); git(a, 'update-index', '--chmod=+x', 'skills/sample/run.sh'); git(a, 'commit', '-qm', '测试: 隔离 live 项目');
  for (let index = 0; index < 12; index++) propose(a, 'rule-' + index);
  propose(a, 'other', { repositories: [randomUUID()] });
  propose(a, 'reference', { mode: 'reference' });
  git(a, 'add', 'wiki'); git(a, 'commit', '-qm', '测试: live Wiki 审批');
  evidence.phase = 'bootstrap';
  const first = evolve(a, 'openviking', 'init', '--policy', 'evolution.json', '--project-id', projectId);
  evidence.bootstrap_release = first.head.release_id;
  assert.equal(existsSync(join(a, 'dist')), false); assert.equal(existsSync(join(a, 'node_modules')), false);
  evolve(a, 'session', 'open', 'Pinned live Session', '--id', 'live-a', '--actor', 'live', '--chain', 'sample');
  const runA = evolve(a, 'run', 'next', ...fence(a, 'live-a'));
  evolve(a, 'run', 'skill-read', runA.run_id, '--session', 'live-a');

  evidence.phase = 'second-workspace-clone';
  execute('git', ['clone', '--no-hardlinks', '--config', 'core.autocrlf=false', a, b], temporary);
  git(b, 'config', 'user.name', 'OpenViking isolated live'); git(b, 'config', 'user.email', 'openviking-live@example.invalid');
  git(b, 'rm', '-r', 'skills'); git(b, 'commit', '-qm', '测试: 从远端重新物化全部 Skill');
  evidence.phase = 'second-workspace-sync';
  evolve(b, 'session', 'open', 'Publish live business gate', '--id', 'publisher', '--actor', 'live', '--chain', 'sample');
  const mode = git(b, 'ls-tree', 'HEAD', '--', 'skills/sample/run.sh'); assert.match(mode, /^100755 /);
  assert.deepEqual(execFileSync('git', ['show', 'HEAD:skills/sample/assets/icon.png'], { cwd: b }), binary);
  assert.equal(git(a, 'rev-parse', 'HEAD:skills'), git(b, 'rev-parse', 'HEAD:skills'));
  assert.equal(existsSync(join(b, 'dist')), false); assert.equal(existsSync(join(b, 'node_modules')), false);
  const content = 'Deployment build 00123 must preserve Token-AbC_007. ' + 'Original shared body. '.repeat(50) + 'End of original record.';
  evolve(b, 'kb', 'add', content, '--id', 'shared-live', '--kind', 'episodic', '--memory-backend', 'local');
  evolve(b, 'openviking', 'memory', 'share', 'shared-live');

  const modelPath = join(temporary, 'model.mjs');
  writeFileSync(modelPath, `import {createServer} from 'node:http';import {parentPort} from 'node:worker_threads';
const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks));
const source=input.messages[1].content.match(/evolve:[A-Za-z0-9_-]+#run-[A-Za-z0-9_-]+/)?.[0];
const content=input.model==='no-signals'?'[]':JSON.stringify([{scene_name:'workflow',memories:[{type:'workflow_issue',content:'Require a migration approval check before a deployment release.',source_message_ids:[source]}]}]);
res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content}}]}));});server.listen(0,'127.0.0.1',()=>parentPort.postMessage('http://127.0.0.1:'+server.address().port));\n`);
  model = new Worker(modelPath);
  env.AGENT_MEMORY_LLM_BASE_URL = await new Promise((resolve, reject) => { model.once('message', resolve); model.once('error', reject); });
  env.AGENT_MEMORY_LLM_MODEL = 'protocol-fixture'; env.AGENT_MEMORY_LLM_API_KEY = '';
  const agy = join(temporary, 'agy.mjs');
  writeFileSync(agy, `const p=process.argv.find(x=>x.startsWith('--print=')).slice(8);console.log(JSON.stringify(p.includes('final Agy confirmation')?{approved:true,reason:'Business runner checked'}:{approved:true,priority:'high',instruction:'Require migration_approval before creating a release.',evidence:[p.match(/evolve:[A-Za-z0-9_-]+#run-[A-Za-z0-9_-]+/)[0]]}));\n`);
  env.AGY_EXECUTABLE = agy;
  const runP = evolve(b, 'run', 'next', ...fence(b, 'publisher'));
  evolve(b, 'run', 'skill-read', runP.run_id, '--session', 'publisher');
  finishRun(b, 'publisher', runP, 'Deployment failed because the migration approval check was omitted');
  evidence.phase = 'session-evolution';
  const publication = evolve(b, 'session', 'complete', ...fence(b, 'publisher'));
  const publicationState = publication.asset_publication?.openviking?.publication ?? publication.asset_publication;
  evidence.publication = { state: publicationState?.state, error: String(publicationState?.error ?? '').match(/^OPENVIKING_[A-Z_]+/)?.[0] };
  assert.equal(publicationState?.state, 'published');
  const second = publication.asset_publication.published_release; evidence.evolved_release = second;
  const pinned = evolve(a, 'run', 'skill-read', runA.run_id, '--session', 'live-a');
  assert.doesNotMatch(pinned.markdown, /migration_approval/);
  env.AGENT_MEMORY_LLM_MODEL = 'no-signals';
  finishRun(a, 'live-a', runA, 'Pinned task completed'); evolve(a, 'session', 'complete', ...fence(a, 'live-a'));
  const sessionB = evolve(b, 'session', 'open', 'Read evolved assets', '--id', 'live-b', '--actor', 'live', '--chain', 'sample');
  assert.equal(sessionB.openviking.release_id, second);
  const runB = evolve(b, 'run', 'next', ...fence(b, 'live-b'));
  assert.match(evolve(b, 'run', 'skill-read', runB.run_id, '--session', 'live-b').markdown, /migration_approval/);
  evidence.phase = 'memory-find-and-exact-read';
  const query = evolve(b, 'kb', 'search', 'Deployment', '--kind', 'episodic', '--workflow-session', 'live-b');
  const id = query.results.find(item => item.id.endsWith(Buffer.from('shared-live').toString('base64url'))).id;
  const body = evolve(b, 'kb', 'get', id, '--kind', 'episodic', '--workflow-session', 'live-b'); assert.equal(body.content, content);
  evidence.memory_sha256 = hash(content);
  const context = evolve(b, 'search', 'Deployment', '--mode', 'context', '--session', 'live-b', '--limit', '1'); assert.equal(context.constraints.length, 12);
  const reads = join(b, '.agent-memory', 'live-reads.json');
  const found = evolve(b, 'kb', 'search', 'Deployment', '--kind', 'episodic', '--workflow-session', 'live-b', '--reads', reads);
  const exact = evolve(b, 'kb', 'get', id, '--kind', 'episodic', '--workflow-session', 'live-b', '--reads', reads,
    '--from-search', found.knowledge_reads.searches.at(-1).search_id);
  assert.equal(exact.content, content);
  assert.ok(exact.openviking_reads.some(item => item.record_id === id && item.content_sha256 === hash(content)));

  const project = JSON.parse(readFileSync(join(b, '.evolve/openviking.json')));
  const pointerUri = project.root_uri + '/current.json';
  const downloaded = await fetch(new URL('/api/v1/content/download?' + new URLSearchParams({ uri: pointerUri }), connection.url), { headers: { 'X-API-Key': connection.api_key } });
  assert.equal(downloaded.status, 200); const pointer = Buffer.from(await downloaded.arrayBuffer()); const head = JSON.parse(pointer);
  const cas = formatting => fetch(new URL('/api/v1/content/batch-write', connection.url), {
    method: 'POST', headers: { 'X-API-Key': connection.api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_uri: project.root_uri, wait: true, skip_conflicts: false, defer_processing: true,
      operations: [{ uri: pointerUri, mode: 'replace', expected_sha256: hash(pointer), content_base64: Buffer.from(JSON.stringify(head, null, formatting) + '\n').toString('base64') }] }),
  });
  evidence.phase = 'single-pointer-cas';
  const races = await Promise.all([cas(2), cas('\t')]); assert.deepEqual(races.map(response => response.status).sort(), [200, 409]);
  evidence.cas_statuses = races.map(response => response.status); evidence.service = 'passed';
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.error = error instanceof Error && /^OPENVIKING_CONFIG_MISSING/.test(error.message) ? error.message : 'LIVE_VERIFICATION_FAILED';
  evidence.exit_status = error?.status; evidence.error_code = error?.code;
  evidence.error_name = error?.name;
  evidence.remote_error = String(error?.stderr ?? '').match(/OPENVIKING_[A-Z_]+(?: \(HTTP \d+\))?/)?.[0];
  if (error?.stdout) {
    try {
      const result = JSON.parse(String(error.stdout));
      const publication = result.asset_publication ?? result.openviking?.publication;
      evidence.publication = publication ? { state: publication.state, error: String(publication.error ?? '').match(/^OPENVIKING_[A-Z_]+/)?.[0] } : undefined;
    } catch { evidence.command_output = 'non-JSON'; }
  }
  evidence.debug_dir = temporary;
  console.error(JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
} finally {
  if (model) await model.terminate();
  if (process.exitCode !== 1) rmSync(temporary, { recursive: true, force: true });
}
