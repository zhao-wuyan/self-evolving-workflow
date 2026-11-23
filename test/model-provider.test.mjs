import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));

test('OMP closeout uses memory role without HTTP configuration and stages evidence without publishing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'evolve-memory-role-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = join(root, 'omp.mjs');
  const calls = join(root, 'calls.jsonl');
  await writeFile(worker, `import assert from 'node:assert/strict';
import {readFileSync,appendFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8').slice('/evolve-worker '.length));
assert.equal(request.mode,'memory'); assert.equal(request.model,'@memory');
assert.ok(request.system.includes('source_message_ids')); assert.ok(request.prompt.includes('preflight --strict'));
assert.equal(request.binding,undefined);
appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({mode:request.mode,model:request.model})+'\\n');
const output=process.env.FIXTURE_BAD_OUTPUT==='1'?'invalid output':JSON.stringify([{type:'work_method',content:'Run preflight --strict before deploy.',source_message_ids:['m1']}]);
console.log(JSON.stringify({type:'evolve_worker_result',request_id:request.request_id,output}));
`);
  const receipt = join(root, 'receipt.json');
  await writeFile(receipt, JSON.stringify({
    schema_version: 'skill-completion/1.0', id: 'memory-role-completion', execution_id: 'memory-role-execution',
    status: 'succeeded', recorded_at: '2026-11-23T00:00:00Z',
    messages: [{ id: 'm1', role: 'user', timestamp: '2026-11-23T00:00:00Z', content: 'Run preflight --strict before deploy.' }],
  }));
  const env = { ...process.env, HOME: root, USERPROFILE: root, PI_SESSION_ID: 'fixture-omp-session',
    OMP_EXECUTABLE: worker, FIXTURE_CALLS: calls };
  for (const name of ['EVOLVE_MODEL_PROVIDER', 'AGENT_MEMORY_LLM_BASE_URL', 'AGENT_MEMORY_LLM_MODEL', 'AGENT_MEMORY_LLM_API_KEY']) delete env[name];
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, '--root', root, ...args], { env })).stdout);
  const result = await run('kb', 'harvest', 'receipt', receipt, '--project', 'fixture');
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.content, 'Run preflight --strict before deploy.');
  assert.deepEqual(candidate.sources, ['receipt:fixture:memory-role-completion#m1']);
  const listed = await run('kb', 'list', '--kind', 'reference', '--scope', 'project');
  assert.deepEqual(listed.results, []);
  const replay = await run('kb', 'harvest', 'receipt', receipt, '--project', 'fixture');
  assert.equal(replay.replayed, true);
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);

  const invalidReceipt = join(root, 'invalid.json');
  const invalid = JSON.parse(await readFile(receipt, 'utf8'));
  invalid.id = 'invalid-completion'; invalid.execution_id = 'invalid-execution';
  await writeFile(invalidReceipt, JSON.stringify(invalid));
  await assert.rejects(exec(process.execPath, [cli, '--root', root, 'kb', 'harvest', 'receipt', invalidReceipt, '--project', 'fixture'], {
    env: { ...env, FIXTURE_BAD_OUTPUT: '1' },
  }));
  assert.deepEqual((await run('kb', 'list', '--kind', 'reference', '--scope', 'project')).results, []);
});
