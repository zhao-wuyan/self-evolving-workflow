import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const maestro = process.env.MAESTRO_REPLAY_CLI;
assert.ok(maestro && isAbsolute(maestro), 'Set MAESTRO_REPLAY_CLI to the built Maestro JavaScript entry.');
const memory = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'evolve-codex-standalone-'));
const execute = promisify(execFile);
const project = 'standalone-fixture';
const skill = 'preflight-standalone';
const finalText = 'Check the dry-run output before deployment.';
let calls = 0;
const endpoint = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  const prompt = body.messages[1].content;
  calls++;
  let memories = [];
  if (body.messages[0].content.includes('Review the execution timeline')) {
    const source = /receipt:standalone-fixture:skill-[a-f0-9]{64}#outcome/.exec(prompt)?.[0];
    if (!source || !prompt.includes('Codex exited with')) {
      response.writeHead(400).end('Skill review did not include the failed host outcome');
      return;
    }
    memories = [{ type: 'error', content: 'The Skill host exited before completing the task.', source_message_ids: [source] }];
  } else if (/status (?:failed|cancelled)/.test(prompt)) {
    assert.match(prompt, /Codex exited with/);
  } else {
    if (!prompt.includes(finalText) || !prompt.includes('references/preflight.md') || !prompt.includes('status succeeded')) {
      response.writeHead(400).end('Skill evidence did not include the expected result');
      return;
    }
    memories = [{ type: 'work_method', content: finalText, source_message_ids: ['answer', 'skill'] }];
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ memories }]) } }] }));
});

async function invoke(command, args, env) {
  return (await execute(command, args, { cwd: root, env, encoding: 'utf8', windowsHide: true })).stdout;
}

try {
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  const env = {
    ...process.env, MAESTRO_EVOLVE_CLI: memory, MAESTRO_EVOLVE_PROJECT: project, MAESTRO_EVOLVE_WIKI_ROOT: root,
    AGENT_MEMORY_LLM_BASE_URL: `http://127.0.0.1:${endpoint.address().port}/v1`, AGENT_MEMORY_LLM_MODEL: 'fixture',
  };
  delete env.AGENT_MEMORY_LLM_API_KEY;
  delete env.MAESTRO_SESSION_ID;
  if (process.env.CODEX_REPLAY_EXECUTABLE) env.MAESTRO_CODEX_EXECUTABLE = process.env.CODEX_REPLAY_EXECUTABLE;
  const dir = join(root, 'skills', skill);
  await mkdir(join(dir, 'references'), { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), [
    '---', `name: ${skill}`, 'description: Return a preflight checklist.', 'required_links:', '  - references/preflight.md', '---',
    '# Preflight', '', 'Open the [preflight checklist](references/preflight.md) and return its one sentence verbatim.', '',
  ].join('\n'));
  const reference = join(dir, 'references', 'preflight.md');
  await writeFile(reference, finalText + '\n');
  const git = (...args) => invoke('git', args);
  await git('init', '-q');
  await git('add', 'skills');
  await git('-c', 'user.name=Standalone fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Standalone Skill');
  const commit = (await git('rev-parse', 'HEAD')).trim();
  await writeFile(reference, 'This text exists only in the working copy.\n');

  const output = await invoke(process.execPath, [
    maestro, 'skills', 'run', skill, 'Give me the deployment preflight checklist.', '--json',
  ], env).catch(error => {
    throw new Error(error.stdout?.trim() || error.stderr?.trim() || error.message);
  });
  const run = JSON.parse(output);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.output.trim(), finalText);
  assert.equal(run.skill.commit, commit);
  assert.deepEqual(run.loaded.map(read => read.path), ['SKILL.md', 'references/preflight.md']);
  assert.equal(run.closeout.status, 'dispatched');
  const receipt = run.closeout.receipt;
  assert.match(receipt, /^skill-[a-f0-9]{64}$/);
  assert.equal(await readFile(reference, 'utf8'), 'This text exists only in the working copy.\n');

  const closeout = async (...args) => JSON.parse(await invoke(process.execPath, [
    memory, '--root', root, 'closeout', ...args, '--project', project,
  ], env));
  const waitForHarvest = async id => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { return await closeout('show', id); }
      catch (error) {
        if (Date.now() >= deadline || !/Completion has not been harvested/.test(error.stderr)) throw error;
        await delay(100);
      }
    }
  };
  const harvest = await waitForHarvest(receipt);
  assert.equal(harvest.candidates.length, 1);
  assert.deepEqual(await closeout('resume', receipt), { ...harvest, replayed: true });
  assert.equal(calls, 1);
  const argumentsForRun = [maestro, 'skills', 'run', skill, 'Run preflight.', '--json'];
  await assert.rejects(invoke(process.execPath, argumentsForRun, { ...env, MAESTRO_SESSION_ID: 'session-owned' }),
    error => error.code === 1 && /Use the current Session Run/.test(error.stderr));
  let failed;
  await assert.rejects(invoke(process.execPath, argumentsForRun, { ...env, MAESTRO_CODEX_EXECUTABLE: process.execPath }),
    error => {
      assert.equal(error.code, 1);
      failed = JSON.parse(error.stdout);
      return failed.status === 'failed';
    });
  assert.deepEqual((await waitForHarvest(failed.closeout.receipt)).candidates, []);
  assert.equal(calls, 2);
  const review = JSON.parse(await invoke(process.execPath, [
    memory, '--root', root, 'evolve', 'review', failed.execution, '--project', project,
  ], env));
  assert.equal(review.receipt, failed.closeout.receipt);
  assert.deepEqual(review.skill, { id: skill, version: `git:${failed.skill.commit}:${failed.skill.tree}`, status: 'failed' });
  assert.equal(review.signals[0].kind, 'error');
  assert.deepEqual(review.signals[0].sources, [`receipt:${project}:${failed.closeout.receipt}#outcome`]);
  assert.equal(calls, 3);
  console.log('Codex standalone Skill loaded its committed documents. The host recorded success and failure and exposed the failure for retrospective review.');
} finally {
  if (endpoint.listening) await new Promise(resolve => endpoint.close(resolve));
  assert.match(await realpath(root), /[\\/]evolve-codex-standalone-[a-zA-Z0-9]+$/);
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
