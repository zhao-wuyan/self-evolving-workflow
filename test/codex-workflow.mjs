import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { cli, fixture } from './evolve-workflow-support.mjs';

const requested = new Set(process.argv.slice(2));
const selections = ['chain', 'odyssey', 'swarm'].filter(name => !requested.size || requested.has(name));
assert.ok(selections.length && (!requested.size || requested.size === selections.length), 'Select chain, odyssey or swarm');
const file = 'limits.mjs';
const original = 'export const limit = 2;\n';
const revised = 'export const limit = 3;\n';
const memoryId = 'limits-acceptance';
const wikiId = 'entries/limits-acceptance';

async function codex(f, session, run, task, data, { extraLinks = [], knowledge = 'memory' } = {}) {
  const entry = run.skill_ref.entry;
  const links = [...run.skill_ref.required_links.filter(path => path !== entry)
    .map(path => ({ from: entry, destination: path })), ...extraLinks];
  const cliPrefix = `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} --root ${JSON.stringify(f.root)}`;
  const readsPath = join(run.run_dir, 'knowledge-reads.json');
  const args = ['-a', 'never', 'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--json', '--sandbox', 'workspace-write', '-c', 'model_reasoning_effort="low"', '-'];
  const prompt = [
    `Open the bound Skill via CLI: ${cliPrefix} run read skill ${run.run_id} --session ${session}`,
    `Read each of these links via CLI (${cliPrefix} run read skill ${run.run_id} <destination> --from <from> --session ${session}): ${JSON.stringify(links)}`,
    {
      memory: `Search memory via CLI (${cliPrefix} kb search "limits acceptance" --kind episodic --reads ${JSON.stringify(readsPath)}) and read the matching ID (${cliPrefix} kb get <id> --kind episodic --reads ${JSON.stringify(readsPath)} --from-search <search_id>).`,
      wiki: `Resolve context via CLI (${cliPrefix} search "limits acceptance" --mode context --session ${session} --reads ${JSON.stringify(readsPath)}) and read the returned reference ID (${cliPrefix} kb get <id> --kind reference --resolved --reads ${JSON.stringify(readsPath)} --from-search <search_id>). Record the numeric limit from the exact Wiki body.`,
      priors: `Read session-priors via CLI: ${cliPrefix} run read artifact ${run.run_id} session-priors --session ${session}. Use its frozen Wiki bodies as the project knowledge. The lookup scope is unchanged in this fixture, so reuse those bodies as-is without calling search or kb.`,
    }[knowledge],
    `When task text mentions reading an upstream artifact (e.g., current-analysis, current-plan, current-execution), run: ${cliPrefix} run read artifact ${run.run_id} <alias> --session ${session}`,
    'Return only a JSON object. Do not edit repository source files; the coordinator writes fixture artifacts and owns the lifecycle.',
    'Task: ' + task, 'Task data: ' + JSON.stringify(data),
  ].join('\n');
  const exe = process.env.CODEX_REPLAY_EXECUTABLE || (process.platform === 'win32' ? 'codex.exe' : 'codex');
  const child = spawn(exe, args, { cwd: f.root, env: f.env, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
  child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
  const complete = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || stdout)));
    child.on('exit', code => {
      if (code === 0 && stdout.includes('"type":"turn.completed"')) {
        child.stdout.destroy();
        child.stderr.destroy();
        resolve();
      }
    });
  });
  const deadline = setTimeout(() => child.kill(), 140_000);
  child.stdin.end(prompt);
  try { await complete; } finally { clearTimeout(deadline); }
  const events = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const answer = events.findLast(event => event.type === 'item.completed' && event.item?.type === 'agent_message')?.item.text;
  assert.ok(events.some(event => event.type === 'turn.completed') && answer, run.task.command);
  if (knowledge === 'priors') {
    const commands = events.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution')
      .map(event => String(event.item.command ?? ''));
    assert.ok(commands.every(cmd => !/\b(?:search|kb)\b/.test(cmd)), JSON.stringify(commands));
  }
  return JSON.parse(answer.trim().replace(/^\x60{3}(?:json)?\s*([\s\S]+?)\s*\x60{3}$/i, '$1'));
}

function seal(f, session, run, summary, revision, knowledge = 'memory') {
  const gates = run.gates.exit.flatMap(gate => ['--gate', gate]);
  const receipt = f.finish(session, run, summary, gates, revision);
  assert.equal(receipt.status, 'sealed');
  assert.deepEqual(receipt.skill_reads.missing, []);
  assert.equal(receipt.skill_reads.reference.commit, run.skill_ref.commit);
  if (knowledge === 'memory') assert.ok(receipt.knowledge_reads.reads.some(read => read.id === memoryId && read.from_search_id));
  return receipt;
}

async function chain(f) {
  const session = 'ew-chain';
  f.write('wiki-draft.json', JSON.stringify({ operation: 'create', entry: wikiId, title: 'Limits acceptance policy',
    mode: 'reference', body: 'Set the item limit in limits.mjs to 3 and preserve the existing export.' }));
  const draft = f.agent('kb', 'propose', 'wiki-draft.json', '--evidence', 'fixture:limits-policy');
  f.agent('kb', 'apply', draft.id);
  const opened = f.open(session, 'ew-analyze,ew-plan,ew-execute,ew-review', 'Update the fixture item limit from project acceptance evidence');
  const analyze = f.next(session, opened.orchestration_revision);
  const input = await codex(f, session, analyze,
    'Use the acceptance Wiki and source. Return { finding: string, file: string, desired: number }.',
    { file, source: original }, { knowledge: 'wiki' });
  assert.equal(input.file, file);
  assert.equal(input.desired, 3);
  f.saveArtifact(analyze, 'findings.json', input);
  const analysis = seal(f, session, analyze, 'Found the expected limit in the project Wiki', analyze.orchestration_revision, 'wiki');
  const origin = analysis.knowledge_reads;
  assert.equal(origin.searches.length, 1);
  assert.equal(origin.searches[0].query, 'limits acceptance');
  assert.deepEqual(origin.searches[0].filters, {});
  assert.equal(origin.reads.length, 1);
  assert.equal(origin.reads[0].id, wikiId);
  assert.equal(origin.reads[0].from_search_id, origin.searches[0].search_id);
  const priorsId = analysis.artifact_publication.aliases['session-priors'];
  assert.ok(priorsId);
  const reuse = [{ artifact_id: priorsId, producer_run_id: analyze.run_id,
    content_sha256: analysis.artifact_publication.artifacts[priorsId].sha256 }];

  const plan = f.next(session, analysis.orchestration_revision);
  const proposal = await codex(f, session, plan, 'Read current-analysis via CLI artifact-read. Return {file, change, verify} for one planned task.',
    {}, { knowledge: 'priors' });
  assert.equal(proposal.file, file);
  assert.match(proposal.change, /3/);
  assert.ok(proposal.verify);
  f.saveArtifact(plan, 'plan.json', proposal);
  const planned = seal(f, session, plan, 'Planned and checked one change', plan.orchestration_revision, 'priors');
  assert.ok(Object.values(planned.artifact_publication.artifacts)[0].derived_from.includes(analysis.artifact_publication.aliases['current-analysis']));

  const execute = f.next(session, planned.orchestration_revision);
  const change = await codex(f, session, execute, 'Read current-plan via CLI artifact-read. Return {file,text} with the exact resulting JavaScript, including a terminal newline.',
    { source: original }, { knowledge: 'priors' });
  assert.deepEqual(change, { file, text: revised });
  f.write(file, change.text);
  assert.equal(f.git('diff', '--name-only'), file);
  f.git('diff', '--check');
  f.run(process.execPath, ['--input-type=module', '-e', 'if ((await import("./limits.mjs")).limit !== 3) process.exit(1)']);
  f.saveArtifact(execute, 'execution.json', { file, verified: true });
  const executed = seal(f, session, execute, 'Executed the Node acceptance check and scoped diff check', execute.orchestration_revision, 'priors');

  const review = f.next(session, executed.orchestration_revision);
  const evaluated = await codex(f, session, review,
    'Read current-execution via CLI artifact-read. Review correctness, security, performance and architecture for this one-line diff. Return {dimensions: [string], findings: []} when acceptance passes.',
    { diff: f.git('diff', '--', file) }, { knowledge: 'priors' });
  assert.equal(evaluated.dimensions.length, 4);
  assert.deepEqual(evaluated.findings, []);
  f.saveArtifact(review, 'review.json', evaluated);
  const reviewed = seal(f, session, review, 'Reviewed the accepted change across four dimensions', review.orchestration_revision, 'priors');
  assert.equal(f.evolve('session', 'complete', ...f.fence(session, reviewed.orchestration_revision)).status, 'completed');
  const reopened = f.status(session);
  for (const receipt of [planned, executed, reviewed]) {
    assert.deepEqual(receipt.knowledge_reads.searches, []);
    assert.deepEqual(receipt.knowledge_reads.reads, []);
    assert.deepEqual(receipt.knowledge_reads.priors_reuse, reuse);
    assert.deepEqual(reopened.runs.find(run => run.id === receipt.run_id).knowledge_reads, receipt.knowledge_reads);
  }
  const artifact = f.evolve('run', 'artifact-read', review.run_id, 'session-priors', '--session', session);
  const priors = JSON.parse(artifact.content);
  const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
  assert.equal(sha(artifact.content), reuse[0].content_sha256);
  assert.equal(sha(priors.wiki[0].content), origin.reads[0].content_sha256);
  assert.equal(priors.source_run_id, analyze.run_id);
  console.log('EW orchestration: four real Codex Runs completed with one Wiki query, one exact read and three durable reuse receipts.');
}

async function odyssey(f) {
  const session = 'ew-odyssey-review';
  f.open(session, '');
  const step = f.evolve('session', 'step', 'add', ...f.fence(session), '--step-id', 'audit', '--command', 'ew-odyssey-review',
    '--arg=--skip-fix', '--arg=' + file, '--decision-ref', 'accept-audit');
  const run = f.next(session, step.orchestration_revision);
  const resumed = f.evolve('run', 'brief', run.run_id, '--session', session);
  assert.deepEqual(resumed.skill_ref, run.skill_ref);
  const review = await codex(f, session, resumed,
    'Perform an audit-only review. Return { current_state:"END", dimensions:[string], findings:[] } when the supplied change satisfies correctness, security, performance and architecture.',
    { diff: '-export const limit = 2;\n+export const limit = 3;\n', target: file },
    { extraLinks: [{ from: 'SKILL.md', destination: 'references/odyssey-review.md' },
      { from: 'references/odyssey-review.md', destination: 'odyssey-base.md' }] });
  assert.equal(review.current_state, 'END');
  assert.equal(review.dimensions.length, 4);
  assert.deepEqual(review.findings, []);
  f.saveArtifact(run, 'session.json', review);
  const published = seal(f, session, run, 'Odyssey review covered all four dimensions in read-only mode', run.orchestration_revision);
  assert.equal(published.continuation.action, 'decide');
  assert.throws(() => f.sealSession(session), /pending workflow steps and decisions/);
  const decision = f.evolve('run', 'decide', 'accept-audit', ...f.fence(session), '--verdict', 'proceed', '--summary', 'Accept audit');
  assert.equal(decision.continuation.action, 'complete');
  assert.equal(f.sealSession(session).status, 'completed');
  assert.equal(f.git('diff', '--name-only'), '');
  console.log('Odyssey: Codex read committed guidance, retrieved Memory and sealed a read-only audit with a coordinator decision.');
}

async function swarm(f) {
  const session = 'swarm-scoring';
  f.open(session, 'ew-swarm');
  const run = f.next(session);
  const base = ['--session', session, '--run', run.run_id];
  const assets = f.evolve('run', 'task', 'controller', ...base);
  const teamDir = join(run.run_dir, 'work', 'team');
  mkdirSync(teamDir, { recursive: true });
  const config = JSON.parse(readFileSync(assets.config_template, 'utf8'));
  Object.assign(config.swarm, { n_ants: 2, max_iterations: 1 });
  config.convergence.max_iterations = 1;
  config.scoring.mode = 'llm';
  config.task_space.nodes = ['a.mjs', 'b.mjs'];
  config.task_space.max_path_length = 2;
  writeFileSync(join(teamDir, 'swarm-config.json'), JSON.stringify(config));
  const aco = (...args) => JSON.parse(f.run(process.env.PYTHON || 'python', ['-B', assets.script,
    '--session', teamDir, '--run-dir', run.run_dir, ...args]));
  assert.equal(aco('init').status, 'ok');
  const selection = aco('select', '--iter', '1');
  assert.equal(selection.assignments.length, 2);
  assert.deepEqual(aco('select', '--iter', '1').assignments, selection.assignments);

  const writeResult = (path, result) => {
    const absolute = join(run.run_dir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, JSON.stringify(result));
  };
  const assign = (id, path) => f.evolve('run', 'task', 'add', ...base, ...f.fence(session),
    '--id', id, '--role', id, '--path', path);
  const report = (id, revision) => f.evolve('run', 'task', 'update', ...base, ...f.fence(session, revision, id),
    '--id', id, '--summary', 'Artifact checked against the assignment');
  const work = selection.assignments.map(assignment => {
    const id = assignment.ant_id;
    const path = 'outputs/' + id.toLowerCase() + '.json';
    assign(id, path);
    return { assignment, id, path };
  });
  const ants = await Promise.all(work.map(async item => {
    const answer = await codex(f, session, run,
      'Act as a Swarm ant. Identify the greater limit. Return { winner, evidence:[string], summary }. Cite a.mjs:1 and b.mjs:1.', {
        assignment: item.assignment, a: 'a.mjs:1 export const limit = 2;', b: 'b.mjs:1 export const limit = 3;',
      }, [{ from: 'SKILL.md', destination: 'roles/ant/role.md' }]);
    assert.equal(answer.winner, 'b.mjs');
    assert.ok(answer.evidence.some(anchor => anchor.includes('b.mjs:1')));
    const start = item.assignment.start_node;
    const end = start === 'a.mjs' ? 'b.mjs' : 'a.mjs';
    const artifact = {
      _meta: { kind: 'swarm-ant-result', schema: 'swarm-ant-result/1.0', role: 'evidence' },
      schema_version: '1.0', ant_id: item.id, iteration: 1, assignment: item.assignment, path: [start, end],
      path_decisions: [{ from: start, to: end, rationale: 'Compare both declarations' }], self_score: 0.8,
      self_confidence: 0.9, evidence: answer.evidence, candidate_solution: { summary: answer.summary, content: answer.winner },
    };
    writeResult(item.path, artifact);
    return artifact;
  }));

  const contention = f.status(session).revision;
  const reports = await Promise.allSettled(work.map(item => promisify(execFile)(process.execPath, [cli, 'run', 'task', 'update',
    ...base, ...f.fence(session, contention, item.id), '--id', item.id, '--summary', 'Verified candidate'], { cwd: f.root, env: f.env })));
  assert.equal(reports.filter(result => result.status === 'fulfilled').length, 1);
  const stale = reports.findIndex(result => result.status === 'rejected');
  assert.match(reports[stale].reason.stderr, /REVISION_CONFLICT/);
  report(work[stale].id);

  const scoresPath = 'work/team/scores/iter-1-scores.json';
  assign('SCORE-1', scoresPath);
  const scores = await codex(f, session, run,
    'Act as the independent Swarm scorer. Return { scores: { "<ant id>": { verified_score: number, rationale: string } } }. Each ant gets 0.8 for b.mjs with line evidence.',
    { ants }, [{ from: 'SKILL.md', destination: 'roles/scorer/role.md' }]);
  assert.deepEqual(Object.keys(scores.scores).sort(), ants.map(ant => ant.ant_id).sort());
  assert.ok(Object.values(scores.scores).every(score => score.verified_score === 0.8));
  writeResult(scoresPath, { ...scores, iteration: 1, scorer_type: 'llm', computed_at: new Date().toISOString() });
  report('SCORE-1');
  assert.equal(f.evolve('run', 'task', 'list', ...base).filter(item => item.result).length, 3);
  const updated = aco('update', '--iter', '1');
  assert.deepEqual(aco('update', '--iter', '1'), updated);
  assert.equal(aco('converged').converged, true);
  const result = aco('report');
  assert.equal(result.iterations_completed, 1);
  assert.ok(result.top_k.every(item => item.source === 'verified_llm'));
  writeResult('outputs/swarm-report.json', result);
  writeFileSync(join(run.run_dir, 'outputs', 'best-solution.md'),
    '---\nkind: swarm-best-solution\nschema: swarm-best-solution/1.0\nrole: primary\n---\n# Winner\n\nb.mjs:1 declares limit 3.\n');
  const sealed = seal(f, session, run, 'Scored both candidates with an independent Codex scorer and converged');
  assert.equal(Object.keys(sealed.artifact_publication.artifacts).length, 4);
  assert.equal(f.sealSession(session).status, 'completed');
  console.log('Swarm: two Codex ants and an independent scorer completed a Python ACO round with Agent Memory, CAS and replay.');
}

const result = await Promise.allSettled(selections.map(async name => {
  const f = fixture('evolve-native-codex-');
  try {
    f.write(file, original);
    f.git('add', file);
    f.git('commit', '-qm', 'Add acceptance fixture');
    f.agent('kb', 'add', 'Limits acceptance: the desired item limit is 3. Compare both source declarations when ranking.', '--id', memoryId);
    await { chain, odyssey, swarm }[name](f);
    assert.equal(existsSync(f.sentinel), false, 'The old executable was invoked');
  } finally {
    f.cleanup();
  }
}));
for (const item of result) if (item.status === 'rejected') {
  console.error(item.reason);
  process.exitCode = 1;
}
