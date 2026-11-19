import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from '../dist/common.js';
import { test } from 'node:test';
import { cli, fixture } from './evolve-workflow-support.mjs';
import { evolveSessionReceipt, readEvolveSessions, workflowDbPath } from '../dist/workflow-runtime.js';
import { parseReceipt } from '../dist/closeout.js';

function readBound(f, session, run) {
  f.evolve('run', 'read', 'skill', run.run_id, '--session', session);
  for (const path of run.skill_ref.required_links.filter(path => path !== run.skill_ref.entry)) {
    f.evolve('run', 'read', 'skill', run.run_id, path, '--from', run.skill_ref.entry, '--session', session);
  }
}

test('Evolve pins each attempt, fences retries and publishes bytes with the request receipt atomically', () => {
  const f = fixture('evolve-runtime-');
  try {
    const session = 'pin-and-publish';
    const opened = f.open(session, 'ew-analyze,ew-plan');
    const attempt = f.next(session, opened.orchestration_revision, '--request-id', 'first');
    assert.deepEqual(f.next(session, opened.orchestration_revision, '--request-id', 'first'), attempt);
    assert.throws(() => f.next(session, 1, '--request-id', 'first'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
    assert.throws(() => f.next(session, 0), /REVISION_CONFLICT/);
    assert.throws(() => f.evolve('run', 'read', 'skill', attempt.run_id, 'references/workflow.md',
      '--from', 'SKILL.md', '--session', session), /Read the source document first/);

    const guide = 'skills/ew-orchestrate/steps/ew-analyze/references/workflow.md';
    f.write(guide, '# Changed after the first dispatch\n');
    f.git('add', guide);
    f.git('commit', '-qm', 'Update the analysis procedure');
    readBound(f, session, attempt);
    const fixed = f.evolve('run', 'read', 'skill', attempt.run_id, 'references/workflow.md', '--from', 'SKILL.md', '--session', session);
    assert.notEqual(fixed.markdown, '# Changed after the first dispatch\n');
    assert.deepEqual(
      f.evolve('run', 'read', 'skill', '--run', attempt.run_id, 'references/workflow.md', '--from', 'SKILL.md', '--session', session),
      fixed,
    );
    const failure = f.evolve('run', 'update', attempt.run_id, 'failed', ...f.fence(session),
      '--expected-run-revision', String(attempt.revision), '--reason', 'Reproducer found a failure');
    const run = f.next(session, failure.orchestration_revision);
    assert.equal(run.retry_of_run_id, attempt.run_id);
    assert.notEqual(run.skill_ref.commit, attempt.skill_ref.commit);
    readBound(f, session, run);
    f.saveArtifact(run, 'findings.json', { verified: 'original calculation reproduced' });
    const gates = run.gates.exit.flatMap(gate => ['--gate', gate]);
    assert.throws(() => f.finish(session, run, 'Missing exit gates'), /Required exit gate/);
    const db = new DatabaseSync(workflowDbPath(f.root));
    try {
      db.exec("CREATE TRIGGER break_receipt BEFORE INSERT ON requests WHEN NEW.id = 'forced-failure' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
      const revision = f.status(session).revision;
      assert.throws(() => f.finish(session, run, 'Trigger rollback', [...gates, '--request-id', 'forced-failure'], revision), /fixture write failure/);
      assert.equal(db.prepare('SELECT count(*) AS n FROM artifacts').get().n, 0);
      assert.equal(f.status(session).revision, revision);
      assert.deepEqual(f.status(session).aliases, {});
      db.exec('DROP TRIGGER break_receipt');

      const sealed = f.finish(session, run, 'Seal verified findings', [...gates, '--request-id', 'verified'], revision);
      assert.deepEqual(f.finish(session, run, 'Seal verified findings', [...gates, '--request-id', 'verified'], revision), sealed);
      assert.equal(db.prepare('SELECT count(*) AS n FROM artifacts').get().n, 1);
      writeFileSync(join(run.run_dir, 'outputs', 'findings.json'), '{"modified":true}');
      const plan = f.next(session);
      const bound = f.evolve('run', 'read', 'artifact', plan.run_id, 'current-analysis', '--session', session);
      assert.equal(JSON.parse(bound.content).verified, 'original calculation reproduced');
      assert.deepEqual(
        f.evolve('run', 'read', 'artifact', '--run', plan.run_id, 'current-analysis', '--session', session),
        bound,
      );
      readBound(f, session, plan);
      f.saveArtifact(plan, 'plan.json', { description: 'Fix the reproduced defect' });
      f.finish(session, plan, 'Verified and approved the plan', plan.gates.exit.flatMap(gate => ['--gate', gate]));
      assert.equal(f.sealSession(session).status, 'completed');
      const [native] = readEvolveSessions(f.root, session);
      const receipt = parseReceipt(evolveSessionReceipt(native));
      assert.ok(receipt.messages.some(message => message.content.includes(attempt.run_id)));
    } finally {
      db.close();
    }
    assert.equal(existsSync(f.sentinel), false);
  } finally {
    f.cleanup();
  }
});

test('Public CLI removes obsolete entry points and exposes the unified command families', () => {
  const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8', windowsHide: true });
  for (const command of ['mcp', 'serve', 'memory', 'wiki', 'closeout', 'context', 'skills', 'delegate', 'team', 'install', 'workflows', 'knowledge', 'skill-design']) {
    assert.throws(() => execFileSync(process.execPath, [cli, command], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }), error => error.status !== 0 && /Unknown command/.test(error.stderr));
    assert.doesNotMatch(help, new RegExp('evolve ' + command + '(?: |\\n)'));
  }
  for (const command of ['search', 'kb', 'code', 'session', 'run', 'agent', 'skill']) assert.match(help, new RegExp('(?:evolve |  )' + command + ' '));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.bin, { evolve: 'dist/workflow-cli.js' });
  assert.equal(existsSync(new URL('../dist/cli.js', import.meta.url)), false);
});

test('All shipped step and mode contracts resolve in the installed Git packages', () => {
  const f = fixture('evolve-runtime-contracts-', ['ew-impeccable']);
  try {
    const names = f.evolve('skill').map(item => item.command);
    assert.equal(names.length, 24);
    assert.equal(names.filter(name => name.startsWith('ew-')).length, 24);
    for (const name of names) {
      const binding = f.evolve('skill', 'validate', name);
      assert.match(binding.commit, /^[0-9a-f]{40}$/);
      assert.equal(binding.entry, 'SKILL.md');
      if (name.startsWith('ew-odyssey-')) {
        assert.equal(binding.skill_id, 'ew-odyssey');
        assert.ok(binding.required_links.includes('references/prepare/' + name.slice(3) + '.md'));
        assert.ok(binding.produces.some(slot => slot.path === 'outputs/session.json' && slot.required));
      } else {
        assert.equal(binding.skill_id, name);
      }
    }
    const session = 'readonly-audit';
    f.open(session, '');
    assert.throws(() => f.evolve('session', 'step', 'add', ...f.fence(session), '--step-id', 'audit',
      '--command', 'ew-odyssey-security', '--arg=--fix'), /read-only audit/);
    assert.equal(existsSync(f.sentinel), false);
  } finally {
    f.cleanup();
  }
});

test('Installed Impeccable binds its playbooks and detects UI issues without Maestro or parser dependencies', () => {
  const f = fixture('evolve-impeccable-', ['ew-impeccable']);
  try {
    const session = 'impeccable-audit';
    f.write('.gitignore', '.evolve/\nbin/\nskills/ew-impeccable/scripts/\n');
    f.write('index.html', '<!doctype html><html lang="en"><head><title>Billing</title></head><body>' +
      '<main><h1 style="background: linear-gradient(red, blue); background-clip: text; color: transparent">Billing</h1></main>' +
      '</body></html>');
    assert.ok(f.evolve('skill', 'workflows').some(item => item.id === 'ew-impeccable'));
    assert.match(f.run(process.execPath, [cli, 'skill', 'workflows', 'show', 'ew-impeccable']), /^name: ew-impeccable$/m);
    const opened = f.open(session, 'maestro-impeccable', 'Audit the billing page');
    const run = f.next(session, opened.orchestration_revision);
    assert.equal(run.task.command, 'ew-impeccable');
    assert.equal(run.skill_ref.skill_id, 'ew-impeccable');
    readBound(f, session, run);
    const audit = f.evolve('run', 'read', 'skill', run.run_id, 'reference/audit.md', '--from', 'SKILL.md', '--session', session);
    assert.match(audit.markdown, /accessibility/i);

    const script = (...args) => f.run(process.execPath, [join(f.root, 'skills', 'ew-impeccable', 'scripts', 'impeccable.mjs'), ...args]);
    assert.equal(script('--version').trim(), '4.9.2');
    const initialContext = script('context', '--target', 'index.html');
    assert.match(initialContext, /RESOLVED_CONTEXT|NO_PRODUCT_MD/);
    assert.doesNotMatch(initialContext, /UPDATE_AVAILABLE/);
    assert.throws(() => script('detect', '--json', 'index.html'), error => {
      assert.equal(error.status, 2);
      assert.doesNotMatch(error.stderr, /DEGRADED/);
      assert.ok(JSON.parse(error.stdout).some(finding => finding.antipattern === 'gradient-text'));
      return true;
    });
    f.write('.codex/config.toml', '');
    script('hooks', 'on');
    const hooks = readFileSync(join(f.root, '.codex', 'hooks.json'), 'utf8');
    assert.match(hooks, /ew-impeccable\/scripts\/impeccable(?:\\?["'])?\s+hook/);
    assert.match(hooks, /"Stop"/);
    assert.doesNotMatch(script('context', '--target', 'index.html'), /MANUAL_DETECTOR_REQUIRED/);
    assert.deepEqual(JSON.parse(script('live-status')).activeSessions, []);
    assert.equal(existsSync(f.sentinel), false);
  } finally {
    f.cleanup();
  }
});

test('Run recovery still reads the original revision after an EW package rename', () => {
  const f = fixture('evolve-runtime-renames-');
  try {
    const current = f.git('rev-parse', 'HEAD');
    f.git('mv', 'skills/ew-orchestrate', 'skills/maestro');
    f.git('mv', 'skills/maestro/steps/ew-analyze', 'skills/maestro/steps/analyze');
    const legacyEntry = 'skills/maestro/steps/analyze/SKILL.md';
    f.write(legacyEntry, readFileSync(join(f.root, legacyEntry), 'utf8').replace('name: ew-analyze', 'name: analyze'));
    f.git('mv', 'skills/ew-swarm', 'skills/team-swarm');
    const legacySwarmEntry = 'skills/team-swarm/SKILL.md';
    f.write(legacySwarmEntry, readFileSync(join(f.root, legacySwarmEntry), 'utf8').replace('name: ew-swarm', 'name: team-swarm'));
    f.git('add', legacyEntry, legacySwarmEntry);
    f.git('commit', '-qm', 'Record a legacy Skill revision');

    const session = 'resume-old-name';
    f.open(session, 'analyze');
    const oldRun = f.next(session);
    assert.equal(oldRun.task.command, 'ew-analyze');
    assert.equal(oldRun.skill_ref.skill_id, 'analyze');
    const swarmSession = 'resume-team-swarm';
    f.open(swarmSession, 'team-swarm');
    const oldSwarmRun = f.next(swarmSession);
    assert.equal(oldSwarmRun.task.command, 'ew-swarm');
    assert.equal(oldSwarmRun.skill_ref.skill_id, 'team-swarm');
    f.git('checkout', '--detach', current);
    const original = f.evolve('run', 'read', 'skill', oldRun.run_id, '--session', session);
    assert.match(original.markdown, /^name: analyze$/m);
    const originalSwarm = f.evolve('run', 'read', 'skill', oldSwarmRun.run_id, '--session', swarmSession);
    assert.match(originalSwarm.markdown, /^name: team-swarm$/m);
    assert.ok(existsSync(f.evolve('run', 'task', 'controller', '--session', swarmSession, '--run', oldSwarmRun.run_id).script));
    const currentBinding = f.evolve('skill', 'validate', 'analyze');
    assert.equal(currentBinding.skill_id, 'ew-analyze');
    assert.notEqual(currentBinding.commit, oldRun.skill_ref.commit);
    assert.equal(f.evolve('skill', 'validate', 'team-swarm').skill_id, 'ew-swarm');
  } finally {
    f.cleanup();
  }
});

test('CLI knowledge receipts pin read bodies, preserve scope and seal reuse evidence atomically', () => {
  const f = fixture('evolve-wiki-priors-');
  try {
    const session = 'wiki-handoff';
    const selected = 'entries/handoff-selected';
    const unopened = 'entries/handoff-unopened';
    const constraint = 'entries/handoff-rule';
    for (const [entry, mode, body] of [
      [selected, 'reference', 'Record the selected handoff method.'],
      [unopened, 'reference', 'An unopened handoff example.'],
      [constraint, 'constraint', 'Keep the handoff source traceable.'],
    ]) {
      f.write('wiki-draft.json', JSON.stringify({ operation: 'create', entry, title: entry, mode, body }));
      f.agent('kb', 'apply', f.agent('kb', 'propose', 'wiki-draft.json', '--evidence', 'fixture:handoff').id);
    }
    const opened = f.open(session, 'ew-analyze,ew-plan');
    const analyze = f.next(session, opened.orchestration_revision);
    const tracePath = join(analyze.run_dir, 'knowledge-reads.json');
    const context = f.agent('search', 'handoff selected', '--from', 'kb', '--mode', 'context',
      '--session', session, '--reads', tracePath);
    assert.ok(context.references.some(hit => hit.id === unopened));
    assert.ok(context.constraints.some(hit => hit.id === constraint));
    const search = context.knowledge_reads.searches.find(item => item.source === 'wiki' && item.returned_ids.includes(selected));
    assert.ok(search);
    const initial = f.agent('kb', 'get', selected, '--resolved', '--reads', tracePath, '--from-search', search.search_id);
    assert.equal(initial.content.trim(), 'Record the selected handoff method.');
    assert.deepEqual(f.agent('kb', 'get', selected, '--resolved', '--reads', tracePath, '--from-search', search.search_id), initial);

    readBound(f, session, analyze);
    f.saveArtifact(analyze, 'findings.json', { finding: initial.content });
    assert.throws(() => f.finish(session, analyze, 'Fail without gates', [], analyze.orchestration_revision), /Required exit gate/);
    assert.deepEqual(f.status(session).aliases, {});
    const gates = analyze.gates.exit.flatMap(gate => ['--gate', gate]);
    const selectedPath = 'wiki/' + selected + '.md';
    const selectedSource = readFileSync(join(f.root, selectedPath), 'utf8');
    f.write(selectedPath, selectedSource.replace('selected handoff method', 'changed handoff method'));
    assert.throws(() => f.finish(session, analyze, 'Reject changed knowledge', gates, analyze.orchestration_revision), /changed|hash|evidence|scope/i);
    assert.deepEqual(f.status(session).aliases, {});
    f.write(selectedPath, selectedSource);
    const unopenedPath = 'wiki/' + unopened + '.md';
    f.write(unopenedPath, readFileSync(join(f.root, unopenedPath), 'utf8').replace('  - project', '  - task:review'));
    assert.equal(f.agent('kb', 'get', unopened, '--resolved'), null);

    const sealed = f.finish(session, analyze, 'Publish verified CLI knowledge', gates, analyze.orchestration_revision);
    assert.equal(sealed.knowledge_reads.reads.length, 1);
    assert.equal(sealed.knowledge_reads.reads[0].from_search_id, search.search_id);
    const plan = f.next(session, sealed.orchestration_revision);
    assert.throws(() => f.evolve('run', 'read', 'artifact', plan.run_id, 'session-priors', '--scope', JSON.stringify({ task: 'review' }), '--session', session), /outside session-priors/);
    const priors = f.evolve('run', 'read', 'artifact', plan.run_id, 'session-priors', '--session', session);
    const snapshot = JSON.parse(priors.content);
    assert.deepEqual(snapshot.lookup_scopes, [{}]);
    assert.deepEqual(snapshot.wiki.map(item => item.id), [constraint, selected]);
    assert.equal(snapshot.wiki[1].content, initial.content);
    assert.equal(snapshot.wiki[1].content_sha256, sealed.knowledge_reads.reads[0].content_sha256);
    f.write(selectedPath, selectedSource.replace('selected handoff method', 'later handoff method'));
    assert.equal(f.evolve('run', 'read', 'artifact', plan.run_id, 'session-priors', '--session', session).content, priors.content);

    readBound(f, session, plan);
    f.saveArtifact(plan, 'plan.json', { verified: true });
    const planTracePath = join(plan.run_dir, 'knowledge-reads.json');
    const trace = { schema_version: 'knowledge-reads/1.0', reads: [], searches: [], constraints_bound: [] };
    const reuse = [{ artifact_id: priors.id, producer_run_id: analyze.run_id, content_sha256: priors.sha256 }];
    const planGates = plan.gates.exit.flatMap(gate => ['--gate', gate]);
    writeFileSync(planTracePath, JSON.stringify({ ...trace, priors_reuse: reuse }));
    assert.throws(() => f.finish(session, plan, 'Reject caller-authored priors', planGates, plan.orchestration_revision), /bound artifact reads/);
    writeFileSync(planTracePath, JSON.stringify(trace));
    const completed = f.finish(session, plan, 'Record verified prior reuse', planGates, plan.orchestration_revision);
    assert.deepEqual(completed.knowledge_reads, { ...trace, priors_reuse: reuse });
    assert.equal(f.sealSession(session).status, 'completed');
  } finally {
    f.cleanup();
  }
});

test('Evolve agent exec resolves JS stubs and Windows shims, binds CLI Run context, and rejects invalid flags', () => {
  const f = fixture('evolve-delegate-');
  try {
    const stub = join(f.root, 'fake-delegate.mjs');
    writeFileSync(stub, [
      "import { readFileSync } from 'node:fs';",
      "const stdin = process.argv.includes('-') ? readFileSync(0, 'utf8') : '';",
      "console.log(JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() }));",
    ].join('\n'));
    f.write('prompt.txt', 'Inspect auth boundary');
    const opened = f.open('delegate-check', 'ew-analyze');
    const run = f.next('delegate-check', opened.orchestration_revision);

    const execWithEnv = (args, extraEnv = {}) => JSON.parse(execFileSync(process.execPath, [cli, ...args], {
      cwd: f.root, env: { ...f.env, ...extraEnv }, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim());

    const codexResult = execWithEnv([
      'agent', 'exec', '--prompt-file', 'prompt.txt', '--to', 'codex', '--mode', 'analysis',
      '--session', 'delegate-check', '--run', run.run_id,
    ], { CODEX_REPLAY_EXECUTABLE: stub });
    assert.equal(codexResult.executor, 'codex');
    const codexPayload = JSON.parse(codexResult.output);
    assert.match(codexPayload.stdin, /^Inspect auth boundary\n/);
    assert.match(codexPayload.stdin, /Evolve Run context/);
    assert.ok(codexPayload.stdin.includes(run.run_id));
    assert.match(codexPayload.stdin, /evolve run get/);
    assert.ok(codexPayload.argv.includes('read-only'));
    assert.ok(codexPayload.argv.every(arg => !arg.startsWith('mcp_servers.evolve_run.')));

    if (process.platform === 'win32') {
      const shim = join(f.root, 'codex.cmd');
      writeFileSync(shim, '@echo off\r\n"%~dp0\\node.exe" "%~dp0\\fake-delegate.mjs" %*\r\n');
      const cmdResult = execWithEnv([
        'agent', 'exec', 'Shim prompt', '--to', 'codex', '--session', 'delegate-check', '--run', run.run_id,
      ], { CODEX_REPLAY_EXECUTABLE: shim });
      const cmdPayload = JSON.parse(cmdResult.output);
      assert.match(cmdPayload.stdin, /^Shim prompt\n/);
      assert.ok(cmdPayload.stdin.includes(run.run_id));
      assert.ok(cmdPayload.argv.every(arg => !arg.startsWith('mcp_servers.evolve_run.')));
    }

    const agyResult = execWithEnv([
      'agent', 'exec', 'Second opinion prompt', '--to', 'agy', '--mode', 'write', '--model', 'fast-model',
    ], { AGY_EXECUTABLE: stub });
    assert.equal(agyResult.executor, 'agy');
    const agyPayload = JSON.parse(agyResult.output);
    assert.ok(agyPayload.argv.includes('accept-edits'));
    assert.ok(agyPayload.argv.includes('--model'));
    assert.ok(agyPayload.argv.includes('fast-model'));
    assert.ok(agyPayload.argv.includes('--print=Second opinion prompt'));

    const boundAgy = execWithEnv([
      'agent', 'exec', 'Bound agy CLI context', '--to', 'agy', '--session', 'delegate-check', '--run', run.run_id,
    ], { AGY_EXECUTABLE: stub });
    assert.ok(JSON.parse(boundAgy.output).argv.some(arg => arg.includes('Evolve Run context')));
    assert.throws(() => execWithEnv(['agent', 'exec', 'Bad flag', '--resume', 'abc']), /Unknown option '--resume'/);
  } finally {
    f.cleanup();
  }
});

test('Short workflow aliases and long-chain continuity safeguards operate end-to-end', () => {
  const f = fixture('evolve-continuity-', ['ew-knowledge', 'ew-impeccable', 'ew-skill-design']);
  try {
    assert.match(f.run(process.execPath, [cli, 'skill', 'workflows', 'show', 'orchestrate']), /Evolve chain catalog/);
    assert.match(f.run(process.execPath, [cli, 'skill', 'workflows', 'show', 'knowledge']), /^name: ew-knowledge$/m);
    assert.equal(f.evolve('skill', 'validate', 'odyssey').skill_id, 'ew-odyssey');
    assert.equal(f.evolve('skill', 'validate', 'impeccable').skill_id, 'ew-impeccable');
    assert.equal(f.evolve('skill', 'validate', 'skill-design').skill_id, 'ew-skill-design');
    assert.equal(f.evolve('skill', 'validate', 'swarm').skill_id, 'ew-swarm');
    assert.equal(f.evolve('skill', 'validate', 'team-swarm').skill_id, 'ew-swarm');

    f.write('wiki-rule.json', JSON.stringify({
      operation: 'create', entry: 'entries/continuity-rule', title: 'Continuity Rule', mode: 'constraint',
      body: 'Preserve goal contracts across retries.',
    }));
    f.agent('kb', 'apply', f.agent('kb', 'propose', 'wiki-rule.json', '--evidence', 'fixture:continuity').id);

    const session = 'long-chain';
    const opened = f.evolve(
      'session', 'create', 'Implement resilient gate', '--id', session, '--actor', 'test',
      '--definition-of-done', 'Verified implementation', '--auto', '--goal-mode',
      '--boundary-contract', JSON.stringify({ in_scope: ['src/auth.ts'], out_of_scope: ['docs/'] }),
      '--goals', JSON.stringify([{ id: 'G1', goal: 'Fix auth gate', done_when: 'ew-verify passes' }]),
    );
    assert.equal(opened.continuation.authority, 'automatic');
    const amended = f.evolve(
      'session', 'update', 'Implement and verify resilient gate', ...f.fence(session, opened.orchestration_revision),
      '--evidence', 'user-confirmed', '--reason', 'Clarified verification scope',
    );
    assert.equal(amended.amendment_id, 'CHG-001');

    let rev = amended.orchestration_revision;
    const insertedSteps = [
      { id: 'anl-1', cmd: 'ew-analyze', args: ['--session', '{session}'] },
      { id: 'pln-1', cmd: 'ew-plan', args: ['--session', '{session}'] },
      { id: 'exe-1', cmd: 'ew-execute', args: [], retryMax: 2 },
      { id: 'ver-1', cmd: 'ew-verify', args: [] },
    ];
    for (const s of insertedSteps) {
      const res = f.evolve('session', 'step', 'add', ...f.fence(session, rev),
        '--step-id', s.id, '--command', s.cmd, ...s.args.map(a => `--arg=${a}`),
        ...(s.retryMax ? ['--retry-max', String(s.retryMax)] : []));
      rev = res.orchestration_revision;
    }
    rev = f.evolve('session', 'step', 'add', ...f.fence(session, rev),
      '--step-id', 'gate-1', '--decision-only', '--decision-ref', 'post-goal-audit').orchestration_revision;

    // Step 1: ew-analyze with CLI knowledge-reads.json emitting outputs/priors.json & argument placeholder expansion.
    const anl = f.next(session, rev);
    assert.deepEqual(anl.task.args, ['--session', session]);
    assert.equal(anl.boundary_contract.in_scope[0], 'src/auth.ts');
    assert.equal(anl.goals[0].id, 'G1');
    assert.equal(anl.amendments[0].id, 'CHG-001');
    readBound(f, session, anl);
    f.saveArtifact(anl, 'findings.json', { findings: ['ok'] });
    f.agent('search', 'continuity', '--mode', 'context', '--from', 'kb', '--reads', join(anl.run_dir, 'knowledge-reads.json'));
    const sealedAnl = f.finish(session, anl, 'Analyzed', anl.gates.exit.flatMap(g => ['--gate', g]), anl.orchestration_revision);
    assert.ok(sealedAnl.artifact_publication.aliases['session-priors']);

    // Step 2: ew-plan consumes current-analysis even if sealed with done_with_concerns.
    const pln = f.next(session, sealedAnl.orchestration_revision);
    readBound(f, session, pln);
    f.saveArtifact(pln, 'plan.json', { tasks: ['T1'] });
    const sealedPln = f.finish(session, pln, 'Planned', pln.gates.exit.flatMap(g => ['--gate', g]), pln.orchestration_revision);

    // Step 3: ew-execute fails once (retry 1), succeeds with done_with_concerns + evidence attachment.
    const exeAttempt1 = f.next(session, sealedPln.orchestration_revision);
    const failedExe = f.evolve('run', 'update', exeAttempt1.run_id, 'failed', ...f.fence(session, exeAttempt1.orchestration_revision),
      '--expected-run-revision', String(exeAttempt1.revision), '--reason', 'Flaky attempt');
    const exeAttempt2 = f.next(session, failedExe.orchestration_revision);
    const failedExe2 = f.evolve('run', 'update', exeAttempt2.run_id, 'failed', ...f.fence(session, exeAttempt2.orchestration_revision),
      '--expected-run-revision', String(exeAttempt2.revision), '--reason', 'Second failure hits retry_max');
    assert.throws(() => f.next(session, failedExe2.orchestration_revision), /Retry limit exceeded for step: exe-1/);

    // Insert a fresh bounded step exe-2 and complete it with done_with_concerns + sibling evidence artifact.
    const insExe2 = f.evolve('session', 'step', 'add', ...f.fence(session, failedExe2.orchestration_revision),
      '--step-id', 'exe-2', '--command', 'ew-execute', '--after-step', 'exe-1');
    const skipped = f.evolve('session', 'step', 'delete', ...f.fence(session, insExe2.orchestration_revision),
      '--step-id', 'exe-1', '--evidence', 'Superseded by exe-2');
    const exe2 = f.next(session, skipped.orchestration_revision);
    readBound(f, session, exe2);
    f.saveArtifact(exe2, 'execution.json', { status: 'partial' });
    f.saveArtifact(exe2, 'change-manifest.json', { files: ['src/auth.ts'] });
    const sealedExe = f.finish(session, exe2, 'Executed with gaps', ['--verdict', 'done_with_concerns',
      ...exe2.gates.exit.flatMap(g => ['--gate', g])], exe2.orchestration_revision);

    // Step 4: ew-verify accepts negative evidence + automatically receives sibling change-manifest.json.
    const ver = f.next(session, sealedExe.orchestration_revision);
    assert.ok(Object.values(ver.upstream).some(item => item.path === 'outputs/change-manifest.json'));
    readBound(f, session, ver);
    f.saveArtifact(ver, 'verification.json', { status: 'passed' });
    const sealedVer = f.finish(session, ver, 'Verified implementation', ver.gates.exit.flatMap(g => ['--gate', g]), ver.orchestration_revision);
    assert.equal(sealedVer.continuation.action, 'decide');
    assert.equal(sealedVer.continuation.decision_ref, 'post-goal-audit');

    // Step 5: decision-only gate rejects low-confidence auto proceed without evidence, reopens target step on fix, then seals.
    assert.throws(() => f.evolve('run', 'decide', 'post-goal-audit', '--verdict', 'proceed', '--confidence', '45',
      '--summary', 'Low confidence', ...f.fence(session, sealedVer.orchestration_revision)), /Confidence below 60/);
    const fixDec = f.evolve('run', 'decide', 'post-goal-audit', '--verdict', 'fix', '--target-step', 'ver-1',
      '--summary', 'Re-verify after adjustment', ...f.fence(session, sealedVer.orchestration_revision));
    assert.equal(fixDec.continuation.action, 'next');
    const ver2 = f.next(session, fixDec.orchestration_revision);
    readBound(f, session, ver2);
    f.saveArtifact(ver2, 'verification.json', { status: 'passed' });
    const sealedVer2 = f.finish(session, ver2, 'Re-verified cleanly', ver2.gates.exit.flatMap(g => ['--gate', g]), ver2.orchestration_revision);
    const procDec = f.evolve('run', 'decide', 'post-goal-audit', '--verdict', 'proceed', '--confidence', '92',
      '--summary', 'All goals satisfied', ...f.fence(session, sealedVer2.orchestration_revision));
    assert.equal(procDec.continuation.action, 'complete');
    const filteredOpen = f.evolve('session', 'list', '--status', 'open', '--query', 'resilient');
    assert.equal(filteredOpen.length, 1);
    const doneSession = f.evolve('session', 'complete', ...f.fence(session, procDec.orchestration_revision));
    assert.equal(doneSession.status, 'completed');
    assert.match(doneSession.closeout_command, /kb harvest session/);
    assert.equal(doneSession.evolve_reminder, true);
    assert.ok(doneSession.evolve_signals.includes('run_retry'));
    assert.ok(doneSession.evolve_signals.includes('non_clean_run'));
    assert.ok(doneSession.evolve_signals.includes('done_with_concerns'));
    assert.ok(doneSession.recommended_actions.some(item => item.includes('session review')));
  } finally {
    f.cleanup();
  }
});

test('Project install wraps skills in host folders (.agents, .codex, .claude) and binds runs cleanly', () => {
  const mkRepo = prefix => {
    const f = fixture(prefix);
    f.git('rm', '-rfq', 'skills');
    f.git('commit', '-qm', 'Remove root skills directory');
    return f;
  };

  const fDefault = mkRepo('evolve-install-agy-');
  try {
    const installed = fDefault.evolve('skill', 'install', '--scope', 'project', '--host', 'agy', '--skill', 'ew-orchestrate', '--yes');
    assert.equal(installed.host, 'agy');
    assert.equal(installed.skills_dir, join(fDefault.root, '.agents', 'skills'));
    assert.equal(installed.agents_dir, join(fDefault.root, '.agents', 'agents'));
    assert.ok(existsSync(join(fDefault.root, '.agents', 'skills', 'ew-orchestrate', 'SKILL.md')));
    assert.ok(existsSync(join(fDefault.root, '.agents', 'agents', 'workflow-planner.md')));
    assert.ok(existsSync(join(fDefault.root, '.agents', 'agents', 'impeccable-motion-reviewer.md')));
    assert.match(readFileSync(join(fDefault.root, 'AGENTS.md'), 'utf8'), /\.agents\/skills\//);
    fDefault.git('add', '.agents', 'AGENTS.md');
    fDefault.git('commit', '-qm', 'Commit .agents skills');
    const binding = fDefault.evolve('skill', 'validate', 'ew-analyze');
    assert.equal(binding.package_path, '.agents/skills/ew-orchestrate/steps/ew-analyze');
    const opened = fDefault.open('agents-bind', 'ew-analyze');
    const run = fDefault.next('agents-bind', opened.orchestration_revision);
    assert.equal(run.skill_ref.package_path, '.agents/skills/ew-orchestrate/steps/ew-analyze');
    readBound(fDefault, 'agents-bind', run);
  } finally {
    fDefault.cleanup();
  }

  const fHosts = mkRepo('evolve-install-hosts-');
  try {
    const claude = fHosts.evolve('skill', 'install', '--scope', 'project', '--host', 'claude', '--skill', 'ew-knowledge', '--yes');
    assert.equal(claude.host, 'claude');
    assert.ok(existsSync(join(fHosts.root, '.claude', 'skills', 'ew-knowledge', 'SKILL.md')));
    assert.ok(existsSync(join(fHosts.root, '.claude', 'agents', 'workflow-executor.md')));
    assert.match(readFileSync(join(fHosts.root, 'CLAUDE.md'), 'utf8'), /\.claude\/skills\//);

    const skillsOnly = fHosts.evolve('skill', 'install', '--host', 'codex', 'ew-orchestrate');
    assert.equal(skillsOnly.host, 'codex');
    assert.ok(existsSync(join(fHosts.root, '.codex', 'skills', 'ew-orchestrate', 'SKILL.md')));
    const codexPlanner = readFileSync(join(fHosts.root, '.codex', 'agents', 'workflow-planner.toml'), 'utf8');
    assert.match(codexPlanner, /^name = "workflow_planner"$/m);
    assert.match(codexPlanner, /^sandbox_mode = "workspace-write"$/m);
    assert.match(codexPlanner, /^developer_instructions = """$/m);
    assert.match(readFileSync(join(fHosts.root, '.codex', 'agents', 'cli-explore-agent.toml'), 'utf8'), /^sandbox_mode = "read-only"$/m);
    assert.equal(existsSync(join(fHosts.root, 'AGENTS.md')), false);

    const allHosts = fHosts.evolve('skill', 'install', '--scope', 'project', '--host', 'all', '--skill', 'ew-odyssey', '--yes');
    assert.deepEqual(allHosts.hosts, ['codex', 'claude', 'agy', 'omp']);
    for (const dir of ['.codex', '.claude', '.agents']) {
      assert.ok(existsSync(join(fHosts.root, dir, 'skills', 'ew-orchestrate', 'SKILL.md')));
      assert.ok(existsSync(join(fHosts.root, dir, 'skills', 'ew-odyssey', 'SKILL.md')));
    }
    assert.ok(existsSync(join(fHosts.root, '.omp', 'skills', 'ew-orchestrate', 'SKILL.md')));
    assert.ok(existsSync(join(fHosts.root, '.omp', 'skills', 'ew-odyssey', 'SKILL.md')));
    assert.ok(existsSync(join(fHosts.root, '.omp', 'agent', 'agents', 'workflow-executor.md')));
    assert.ok(existsSync(join(fHosts.root, '.codex', 'agents', 'team-worker.toml')));
    assert.ok(existsSync(join(fHosts.root, '.claude', 'agents', 'team-worker.md')));
    assert.ok(existsSync(join(fHosts.root, '.agents', 'agents', 'team-worker.md')));

    writeFileSync(join(fHosts.root, '.codex', 'agents', 'workflow-planner.toml'), 'stale = true\n', 'utf8');
    const outdatedStatus = fHosts.evolve('skill', 'status', '--scope', 'project', '--host', 'codex');
    assert.equal(outdatedStatus.targets[0].agents.find(item => item.name === 'workflow-planner').status, 'outdated');
    const upgradedCodex = fHosts.evolve('skill', 'install', '--scope', 'project', '--host', 'codex', '--upgrade', '--yes');
    assert.ok(upgradedCodex.agents.upgraded.includes('workflow-planner'));
    const freshStatus = fHosts.evolve('skill', 'status', '--scope', 'project', '--host', 'codex');
    assert.equal(freshStatus.targets[0].agents.find(item => item.name === 'workflow-planner').status, 'up_to_date');

    assert.equal(readFileSync(join(fHosts.root, 'AGENTS.md'), 'utf8').match(/^# Self-Evolving Workflow$/gm)?.length, 1);
    assert.match(readFileSync(join(fHosts.root, 'AGENTS.md'), 'utf8'), /Closeout & Self-Evolution/);

    fHosts.git('add', '.codex', '.claude', '.agents', 'AGENTS.md', 'CLAUDE.md');
    fHosts.git('commit', '-qm', 'Commit multi-host skills');
    assert.equal(fHosts.evolve('skill', 'validate', 'ew-odyssey-debug').package_path, '.agents/skills/ew-odyssey');
  } finally {
    fHosts.cleanup();
  }
});

test('OMP project install writes native .omp/skills, keeps Agents in .omp/agent and binds native runs', () => {
  const f = fixture('evolve-install-omp-native-');
  try {
    f.git('rm', '-rfq', 'skills');
    f.git('commit', '-qm', 'Remove root skills directory for native OMP install');
    const installed = f.evolve('skill', 'install', '--scope', 'project', '--host', 'omp', '--skill', 'ew-orchestrate', '--yes');
    assert.equal(installed.host, 'omp');
    assert.equal(installed.root, join(f.root, '.omp'));
    assert.equal(installed.skills_dir, join(f.root, '.omp', 'skills'));
    assert.equal(installed.agents_dir, join(f.root, '.omp', 'agent', 'agents'));
    assert.ok(existsSync(join(f.root, '.omp', 'skills', 'ew-orchestrate', 'SKILL.md')));
    assert.ok(existsSync(join(f.root, '.omp', 'agent', 'agents', 'workflow-planner.md')));
    assert.equal(existsSync(join(f.root, 'skills', 'ew-orchestrate', 'SKILL.md')), false);
    assert.match(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), /\.omp\/skills\//);

    const status = f.evolve('skill', 'status', '--scope', 'project', '--host', 'omp');
    const target = status.targets[0];
    assert.equal(target.root, join(f.root, '.omp'));
    assert.equal(target.skills_dir, join(f.root, '.omp', 'skills'));
    assert.equal(target.agents_dir, join(f.root, '.omp', 'agent', 'agents'));
    assert.equal(target.manifest_recorded, true);
    assert.equal(target.skills.find(item => item.name === 'ew-orchestrate').status, 'up_to_date');

    f.git('add', '.omp', 'AGENTS.md');
    f.git('commit', '-qm', 'Commit native OMP Skills');
    const binding = f.evolve('skill', 'validate', 'ew-analyze');
    assert.equal(binding.package_path, '.omp/skills/ew-orchestrate/steps/ew-analyze');
    const opened = f.open('omp-native-bind', 'ew-analyze');
    const run = f.next('omp-native-bind', opened.orchestration_revision);
    assert.equal(run.skill_ref.package_path, '.omp/skills/ew-orchestrate/steps/ew-analyze');
    readBound(f, 'omp-native-bind', run);

    const rootInstall = f.evolve('skill', 'install', '--scope', 'project', '--skill', 'ew-orchestrate', '--yes');
    assert.equal(rootInstall.skills_dir, join(f.root, 'skills'));
    f.git('add', 'skills');
    f.git('commit', '-qm', 'Commit legacy root Skills beside native OMP Skills');
    assert.equal(f.evolve('skill', 'validate', 'ew-analyze').package_path, '.omp/skills/ew-orchestrate/steps/ew-analyze');
  } finally {
    f.cleanup();
  }
});

test('Skill search_profile binds to Run packets and prioritizes matching episodic context', () => {
  const f = fixture('evolve-search-profile-');
  try {
    f.agent('kb', 'add', 'Pipeline failed on port lock', '--id', 'mem-generic', '--type', 'work_fact');
    f.agent('kb', 'add', 'Pipeline failed because WAL lock lingered', '--id', 'mem-error', '--type', 'error');
    const opened = f.open('profile-s1', 'ew-debug');
    const run = f.next('profile-s1', opened.orchestration_revision);
    assert.equal(run.knowledge_profile.task, 'debug');
    assert.deepEqual(run.knowledge_profile.memory_types, ['error', 'correction', 'verified_fix']);
    assert.deepEqual(run.skill_ref.search_profile.memory, ['error', 'correction', 'verified_fix']);

    const tracePath = join(run.run_dir, 'knowledge-reads.json');
    const ctx = f.agent('search', 'Pipeline failed', '--from', 'kb', '--mode', 'context', '--session', 'profile-s1', '--reads', tracePath);
    assert.deepEqual(ctx.episodic.map(item => item.id), ['mem-error', 'mem-generic']);
    assert.equal(ctx.context_scope.session_id, 'profile-s1');
    const memorySearch = ctx.knowledge_reads.searches.find(item => item.source === 'memory');
    assert.deepEqual(memorySearch.returned_ids, ['mem-error', 'mem-generic']);
    const exact = f.agent('kb', 'get', 'mem-error', '--reads', tracePath, '--from-search', memorySearch.search_id);
    assert.equal(exact.kind, 'episodic');
    assert.ok(exact.knowledge_reads.reads.some(item => item.kind === 'memory' && item.id === 'mem-error'));
  } finally {
    f.cleanup();
  }
});
