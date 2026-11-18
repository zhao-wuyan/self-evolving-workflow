import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillInstructions = new URL('../skills/workflow-evolve/SKILL.md', import.meta.url);
const replayRunner = fileURLToPath(new URL('../skills/workflow-evolve/scripts/codex-replay.mjs', import.meta.url));
const mcp = fileURLToPath(new URL('./codex-evolve-mcp.mjs', import.meta.url));
const codex = process.env.CODEX_REPLAY_EXECUTABLE || (process.platform === 'win32' ? 'codex.exe' : 'codex');

async function planWithCodex(prompt, serverArgs, env) {
  const args = ['-a', 'never', 'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--json', '--sandbox', 'read-only', '-c', 'model_reasoning_effort="low"',
    '-c', `mcp_servers.retrospective.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.retrospective.args=${JSON.stringify([mcp, ...serverArgs])}`,
    '-c', 'mcp_servers.retrospective.required=true',
    '-c', 'mcp_servers.retrospective.default_tools_approval_mode="writes"', '-'];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(codex, args, { cwd: tmpdir(), env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const deadline = setTimeout(() => {
      child.kill();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`Codex retrospective timed out\n${stderr.slice(-1500)}\n${stdout.slice(-4000)}`));
    }, 160_000);
    function finish(error) {
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(stdout);
    }
    child.on('error', finish);
    child.stdin.on('error', finish);
    child.on('close', code => finish(code === 0 ? null :
      new Error(`Codex retrospective exited with ${code}\n${stderr.slice(-1500)}\n${stdout.slice(-4000)}`)));
    child.on('exit', code => {
      // Windows descendants may retain the output pipes after the CLI completes.
      if (code !== 0 || !stdout.includes('"type":"turn.completed"')) return;
      child.stdout.destroy();
      child.stderr.destroy();
      finish();
    });
    child.stdin.end(prompt);
  });
  const events = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const answer = events.findLast(event => event.type === 'item.completed' && event.item?.type === 'agent_message')?.item.text;
  assert.ok(answer && events.some(event => event.type === 'turn.completed'), 'Codex did not finish the retrospective');
  assert.ok(!events.some(event => event.item?.type === 'command_execution'), 'Retrospective used shell instead of the tools');
  const calls = events.filter(event => event.type === 'item.completed' &&
    event.item?.type === 'mcp_tool_call' && event.item.server === 'retrospective').map(event => event.item);
  const toolOutput = call => {
    assert.equal(call.status, 'completed', JSON.stringify(call));
    assert.ok(call.result && !call.result.isError, JSON.stringify(call));
    return JSON.parse(call.result.content[0].text);
  };
  return { answer: JSON.parse(answer.trim().replace(/^```(?:json)?\s*([\s\S]+?)\s*```$/i, '$1')), calls, toolOutput };
}

export async function verifyEvolveHost({
  root, maestro, memory, env, origin, git, agent, invoke, skill, skillEntry, baselineSkill,
  session, run, correctionAnchor, transientSession,
}) {
  const prompt = [
    await readFile(skillInstructions, 'utf8'),
    'Review both supplied Session IDs and draft an evidence-backed change where warranted. Use only the retrospective MCP tools.',
    'Use review_session for session review, read_original_skill for the bound revision, and draft_addition for evolve draft.',
    'When drafting, select the affected Run, compare the failure, verified retry, and original Skill, and cite the user correction and verification evidence.',
    'The staging request should produce the exact corrected command described by the evidence so a replay can validate it.',
    'Stop after deciding each Session and generating any warranted draft. The caller handles replay and has authorized no application in this turn.',
    'Return JSON only, with each Session ID as a key and values shaped as {decision:"draft", id:"<tool draft ID>"} or {decision:"no-change"}.',
    JSON.stringify({ sessions: [session, transientSession] }),
  ].join('\n');
  const { answer, calls, toolOutput } = await planWithCodex(prompt,
    [maestro, memory, root, session, transientSession, `${origin}/v1`], env);
  const selection = (tool, id) => calls.filter(call => call.tool === tool && call.arguments.session === id);
  const reviews = selection('review_session', session);
  assert.ok(reviews.length);
  const review = toolOutput(reviews.at(-1));
  assert.equal(review.runs.find(item => item.id === run.run_id).skillRef.commit, run.skill_ref.commit);
  const transientReviews = selection('review_session', transientSession);
  assert.ok(transientReviews.length, 'Codex must review the transient Session before deciding');
  assert.deepEqual(toolOutput(transientReviews.at(-1)).signals, []);
  assert.deepEqual(answer[transientSession], { decision: 'no-change' });
  assert.equal(selection('draft_addition', transientSession).length, 0);

  const originals = selection('read_original_skill', session);
  const originalCall = originals.findLast(call => call.arguments.run === run.run_id && !call.result?.isError);
  assert.ok(originalCall, 'Codex must open the failed Run’s original Skill');
  const original = toolOutput(originalCall);
  assert.deepEqual(original.ref, review.runs.find(item => item.id === run.run_id).skillRef);
  assert.equal(original.markdown, baselineSkill);
  const draftCalls = selection('draft_addition', session);
  const drafts = draftCalls.filter(call => call.status === 'completed' && call.result && !call.result.isError);
  assert.equal(drafts.length, 1, JSON.stringify(draftCalls.map(call => [call.arguments, call.result?.content?.[0]?.text])));
  const draft = toolOutput(drafts[0]);
  assert.deepEqual(answer[session], { decision: 'draft', id: draft.id });
  assert.equal(drafts[0].arguments.run, run.run_id);
  assert.equal(draft.priority, 'normal');
  assert.match(draft.when, /staging/i);
  assert.match(draft.instruction, /migrate staging --dry-run/);
  assert.ok(draft.sources.includes(correctionAnchor));
  const verification = review.signals.find(signal => signal.kind === 'verified_fix');
  assert.ok(verification.sources.some(source => draft.sources.includes(source)));
  assert.equal(draft.baseline.sha256, original.sha256.replace(/^sha256:/, ''));
  assert.equal(await readFile(skillEntry, 'utf8'), baselineSkill);
  console.log('Codex reviewed both Sessions, inspected the bound Skill and generated the evidence-linked conditional draft.');

  const draftPath = join(root, 'evolve-fixture-draft.json');
  const casesPath = join(root, 'evolve-fixture-cases.json');
  const staging = { task: 'Prepare a staging database migration preflight.', expected: 'migrate staging --dry-run' };
  await writeFile(draftPath, JSON.stringify(draft));
  await writeFile(casesPath, JSON.stringify([
    { id: 'staging-error', input: staging, baseline: false },
    { id: 'status-regression', input: {
      task: 'Return the migration tracker status command.', expected: 'migrate status',
    }, baseline: true },
  ]));
  const receipt = await agent('skill', 'replay', draftPath, '--runner', replayRunner, '--scenarios', casesPath);
  assert.deepEqual(receipt.sources, draft.sources);
  assert.deepEqual(receipt.scenarios.map(item => [item.baseline.passed, item.candidate.passed]), [[false, true], [true, true]]);
  const entry = `skills/${skill}/SKILL.md`;
  const document = `skills/${skill}/references/learnings/${draft.id}.md`;
  assert.deepEqual(receipt.scenarios[0].candidate.loaded.map(read => read.path), [entry, document]);
  assert.deepEqual(receipt.scenarios[1].candidate.loaded.map(read => read.path), [entry]);
  for (const read of receipt.scenarios[0].candidate.loaded) {
    assert.equal(read.sha256, createHash('sha256').update(await git('show', `${receipt.candidate}:${read.path}`)).digest('hex'));
  }
  assert.equal((await agent('skill', 'apply', receipt.id)).commit, receipt.candidate);
  const replay = async commit => JSON.parse(await invoke(process.execPath, [replayRunner], env,
    JSON.stringify({ id: 'evolve-published', input: staging, entry, commit })));
  const applied = await replay(receipt.candidate);
  assert.equal(applied.passed, true);
  assert.deepEqual(applied.loaded, receipt.scenarios[0].candidate.loaded);
  const rollback = await agent('skill', 'rollback', receipt.id);
  const reverted = await replay(rollback.commit);
  assert.equal(reverted.passed, false);
  assert.deepEqual(reverted.loaded, receipt.scenarios[0].baseline.loaded);
  assert.equal(await readFile(skillEntry, 'utf8'), baselineSkill);
  console.log('Codex replayed the reviewed draft, loaded its conditional document after apply, and reproduced the baseline after rollback.');
}
