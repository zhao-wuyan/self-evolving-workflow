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
import { verifyEvolveHost } from './codex-evolve.mjs';

const maestro = process.env.MAESTRO_REPLAY_CLI;
assert.ok(maestro && isAbsolute(maestro), 'Set MAESTRO_REPLAY_CLI to the built Maestro JavaScript entry.');
const memory = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const execute = promisify(execFile);
const codexEvolve = process.argv.includes('--codex-evolve');
const root = await mkdtemp(join(tmpdir(), 'evolve-maestro-closeout-'));
const project = 'closeout-fixture';
const skill = 'migration-preflight';
const workflow = join(root, '.workflow');
const database = join(root, 'staging.json');
const migrate = join(root, 'migrate.mjs');
const original = '{"schema":1,"records":3}\n';
const correction = 'User correction: run migration preflight against staging with --dry-run before attempting to apply.';
const excludedQuote = 'Unselected evidence fragment from the same Session.';
const method = 'Before attempting to apply a staging migration, run preflight with --dry-run and confirm the validation succeeds.';
const harvests = new Map();
let networkAttempts = 0;
const model = createServer(async (request, response) => {
  try {
    if (request.url === '/transient') {
      response.writeHead(++networkAttempts === 1 ? 503 : 200).end('Fixture response');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const [{ content: system }, { content: prompt }] = JSON.parse(Buffer.concat(chunks).toString()).messages;
    assert.ok(!prompt.includes(excludedQuote));
    const items = [];
    if (system.startsWith('Extract reusable work methods')) {
      const kind = prompt.includes('Temporary network error') ? 'transient' : 'preflight';
      harvests.set(kind, (harvests.get(kind) ?? 0) + 1);
      if (kind === 'preflight') {
        assert.ok(prompt.includes(correction));
        assert.match(prompt, /migration preflight verified: schema 1, records 3/);
        const anchor = /\[(transcript:[^\]]+:correction:[a-f0-9]{16})\]/.exec(prompt)?.[1];
        const summary = /\[(run:[^\]]+:summary)\]/.exec(prompt)?.[1];
        assert.ok(anchor && summary);
        items.push({ memories: [{ type: 'work_method', content: method, source_message_ids: [anchor, summary] }] });
      }
    } else if (system.startsWith('Review the execution timeline')) {
      const anchor = /\[(transcript:[^\]]+:correction:[a-f0-9]{16})\]/.exec(prompt)?.[1];
      if (anchor) {
        assert.match(prompt, /became failed.*Dry-run flag required/);
        assert.match(prompt, /retries run-/);
        assert.match(prompt, /opened Skill documents: SKILL.md/);
        const failing = /\[(receipt:[^\]]+#run:[^\]]+)\][^\r\n]*became failed.*Dry-run flag required/.exec(prompt)?.[1];
        const verified = /\[(receipt:[^\]]+#run:[^\]]+)\][^\r\n]*migration preflight verified: schema 1, records 3/.exec(prompt)?.[1];
        assert.ok(failing && verified);
        items.push({ memories: [
          { type: 'correction', content: correction, source_message_ids: [anchor] },
          { type: 'error', content: 'The staging migration check failed before the required flag was passed.', source_message_ids: [failing] },
          { type: 'verified_fix', content: 'The staging database preflight verified its schema and record count after the flag was added.', source_message_ids: [verified] },
        ] });
      }
    } else {
      assert.match(system, /^Compare a proposed Wiki method/);
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(items) } }] }));
  } catch (error) {
    console.error(error);
    response.writeHead(500).end('Fixture assertion failed');
  }
});

async function invoke(command, args, env, input) {
  try {
    const child = execute(command, args, { cwd: root, env, windowsHide: true, encoding: 'utf8' });
    if (input !== undefined) child.child.stdin.end(input);
    return (await child).stdout;
  } catch (error) {
    throw new Error(error.stderr?.trim() || error.stdout?.trim() || error.message, { cause: error });
  }
}

const git = (...args) => invoke('git', args);
const cli = async (entry, args, env) => JSON.parse(await invoke(process.execPath, [entry, ...args], env));

try {
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const origin = `http://127.0.0.1:${model.address().port}`;
  const env = {
    ...process.env, MAESTRO_PROJECT_SKILLS: skill,
    MAESTRO_HOME: join(root, '.maestro-home'),
    MAESTRO_EVOLVE_CONSTRAINTS: '1', MAESTRO_EVOLVE_CLI: memory,
    MAESTRO_EVOLVE_PROJECT: project, MAESTRO_EVOLVE_WIKI_ROOT: root,
    AGENT_MEMORY_LLM_BASE_URL: `${origin}/v1`, AGENT_MEMORY_LLM_MODEL: 'fixture',
  };
  delete env.MAESTRO_ANALYZE_SKILL;
  delete env.AGENT_MEMORY_LLM_API_KEY;
  const flow = (...args) => cli(maestro, [...args, '--workflow-root', root, '--json'], env);
  const agent = (...args) => cli(memory, ['--root', root, ...args], env);
  const closeout = (...args) => agent('closeout', ...args, '--project', project);

  await mkdir(join(root, 'skills', skill), { recursive: true });
  const skillEntry = join(root, 'skills', skill, 'SKILL.md');
  const baselineSkill = [
    '---', `name: ${skill}`, 'description: Prepare a migration check or report migration tracker status.', 'wiki_categories: [arch]',
    'contract:', '  contract_version: 2.1', '  produces: []', '  consumes: []', '---',
    '# Migration preflight', '',
    'For a staging migration preflight request, return exactly `migrate staging` unless applicable Skill guidance specifies a different command.',
    'For a migration tracker status request, return exactly `migrate status`.', '',
  ].join('\n');
  await writeFile(skillEntry, baselineSkill);
  await writeFile(database, original);
  await writeFile(migrate, [
    "import { readFileSync } from 'node:fs';",
    "if (!process.argv.includes('--dry-run')) {",
    "  process.stderr.write('Dry-run flag required.');",
    '  process.exit(2);',
    '}',
    'const { schema, records } = JSON.parse(readFileSync(process.argv[2], "utf8"));',
    'if (schema !== 1 || !Number.isInteger(records)) process.exit(3);',
    'console.log(`migration preflight verified: schema ${schema}, records ${records}`);',
  ].join('\n'));
  await git('init', '-q');
  await git('config', 'user.name', 'Closeout fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  await git('add', '--', 'skills', 'migrate.mjs', 'staging.json');
  await git('commit', '-qm', 'Preflight fixture');
  await mkdir(join(workflow, 'specs'), { recursive: true });
  await mkdir(join(workflow, 'knowhow'));
  await writeFile(join(workflow, 'specs', 'architecture-constraints.md'),
    '<spec-entry sid="S-1" title="Use staging" keywords="migration">\nUse staging for migration checks.\n</spec-entry>\n');
  await writeFile(join(workflow, 'specs', 'coding-conventions.md'),
    '<spec-entry sid="S-2" title="Preserve coding style" keywords="migration, style">\nKeep the coding style of the file.\n</spec-entry>\n');
  await writeFile(join(workflow, 'knowhow', 'K-1.md'), '---\ntitle: Inventory\n---\n\nRead the staging inventory.\n');
  const migrated = await agent('wiki', 'migrate', root, '--project', project, '--apply');
  assert.equal(migrated.length, 3);
  assert.ok((await agent('wiki', 'migrate', root, '--project', project, '--apply')).every(item => item.existing));
  const constraintId = (await agent('wiki', 'get', `${project}:spec:S-1`)).id;
  const codingId = (await agent('wiki', 'get', `${project}:spec:S-2`)).id;
  for (const category of ['arch', 'coding']) {
    const previous = await cli(maestro, ['spec', 'load', '--category', category, '--json'], env);
    const next = await agent('wiki', 'constraints', '--skill', skill, '--category', category);
    assert.equal(previous.totalLoaded, 1);
    assert.equal(next.length, 1);
    assert.ok(previous.content.includes(next[0].body.trim()));
  }
  for (const keyword of ['MIGRATION', 'style', 'staging']) {
    const previous = await cli(maestro, ['spec', 'load', '--category', 'arch', '--keyword', keyword, '--json'], env);
    const next = await agent('wiki', 'constraints', '--skill', skill, '--category', 'arch', '--keyword', keyword);
    assert.equal(previous.totalLoaded, next.length, keyword);
    assert.ok(next.every(rule => previous.content.includes(rule.body.trim())));
  }
  const pathRule = 'entries/path-check';
  const pathDraft = join(root, 'path-rule.json');
  await writeFile(pathDraft, JSON.stringify({ operation: 'create', entry: pathRule, mode: 'constraint',
    title: 'Validate migration scripts', body: 'Validate argument handling for the migration script.',
    scope: ['path:*.mjs'], categories: ['arch'] }));
  const proposedPathRule = await agent('wiki', 'propose', pathDraft, '--evidence', 'fixture:path-rule');
  await agent('wiki', 'apply', proposedPathRule.id);

  const currentId = '97bb0bb3-1ef1-4ea5-8afd-2b7ed12cf0bc';
  const linkedId = 'cd7083c9-6e35-4509-99ad-79adb4ab6404';
  const referenceId = '40b31580-3d30-467c-a847-93fc48371ca3';
  const staleId = '74304ff3-7ae3-4269-a06b-f893605004c0';
  function identity(path, id, name) {
    return writeFile(join(path, '.workflow', 'repository.json'), JSON.stringify({
      schema_version: 'repository-identity/1.0', repo_id: id, repo_name: name, created_at: '2026-11-01T00:00:00Z',
    }));
  }
  await identity(root, currentId, 'consumer');
  const sources = join(root, 'linked');
  const producer = join(sources, 'producer');
  const consumerRule = 'Only preflight this migration against a sanitized staging replica.';
  const producerRule = 'Only the producer repository may use the upstream migration replica.';
  await mkdir(join(producer, '.workflow', 'specs'), { recursive: true });
  await identity(producer, linkedId, 'producer');
  await writeFile(join(producer, '.workflow', 'specs', 'architecture-constraints.md'), [
    `<spec-entry sid="S-1" title="Sanitized staging replica" keywords="replica" appliesToRepoIds="${currentId}">`, consumerRule, '</spec-entry>',
    `<spec-entry sid="S-2" title="Upstream migration replica" appliesToRepoIds="${linkedId}">`, producerRule, '</spec-entry>', '',
  ].join('\n'));
  for (const [name, id] of [['reference', referenceId], ['stale', staleId]]) {
    const source = join(sources, name);
    await mkdir(join(source, '.workflow'), { recursive: true });
    await mkdir(join(source, 'wiki', 'entries'), { recursive: true });
    await identity(source, id, name);
    await writeFile(join(source, 'wiki', 'entries', 'denied.md'), [
      '---', 'title: Excluded constraint', 'mode: constraint', 'status: active', 'scope: [project]',
      'categories: [arch]', 'sources: [fixture:denied]', '---', '', 'Never inject this rule.', '',
    ].join('\n'));
  }
  const links = [
    { name: 'producer', path: 'linked/producer', repo_id: linkedId, share: ['spec'] },
    { name: 'reference', path: 'linked/reference', repo_id: referenceId, share: ['knowhow'] },
    { name: 'stale', path: 'linked/stale', repo_id: 'bd80ed8c-6a01-4eeb-b46a-01f350719af0', share: ['spec', 'knowhow'] },
  ];
  const configureLinks = linked => writeFile(join(workflow, 'config.json'), JSON.stringify({ workspaces: { linked } }));
  await configureLinks(links);

  async function start(session) {
    const opened = await flow('session', 'open', 'Verify migration preflight', '--id', session, '--chain', skill, '--actor', 'fixture');
    const birth = await flow('run', 'next', '--session', session, '--actor', 'fixture',
      '--expected-orchestration-revision', String(opened.result.orchestration_revision));
    assert.equal(birth.ok, true, JSON.stringify(birth));
    return birth.result;
  }

  const unmigrated = await start('unmigrated-link');
  assert.equal(unmigrated.wiki_constraints, undefined);
  const unmigratedRules = await flow('run', 'wiki-constraints', unmigrated.run_id, '--session', 'unmigrated-link');
  assert.equal(unmigratedRules.result.source, 'legacy');
  assert.deepEqual(unmigratedRules.result.constraints, []);
  const previousLinked = await cli(maestro, ['spec', 'load', '--category', 'arch', '--json'], env);
  assert.ok(previousLinked.content.includes(consumerRule));
  assert.ok(!previousLinked.content.includes(producerRule));
  await agent('wiki', 'migrate', producer, '--wiki-root', producer, '--project', 'producer-fixture', '--apply');
  const shared = await agent('wiki', 'get', 'producer-fixture:spec:S-1', '--wiki-root', producer);

  async function readSkill(id, run) {
    const read = await flow('run', 'skill-read', run.run_id, '--session', id);
    assert.equal(read.result.recorded, true);
  }

  async function retry(id, run, reason, anchor) {
    const failed = await flow('run', 'transition', run.run_id, 'failed', '--session', id, '--actor', 'fixture',
      '--expected-orchestration-revision', String(run.continuation.revision_requirements.expected_orchestration_revision),
      '--expected-run-revision', String(run.revision), '--reason', reason, ...(anchor ? ['--evidence', anchor] : []));
    const birth = await flow('run', 'create', skill, '--session', id, '--actor', 'fixture',
      '--step', run.step_id, '--run', `retry-${id}`, '--retry-of-run', run.run_id,
      '--expected-orchestration-revision', String(failed.result.orchestration_revision));
    assert.equal(birth.result.retry_of_run_id, run.run_id);
    await readSkill(id, birth.result);
    return birth.result;
  }

  async function finish(id, run, summary) {
    const sealed = await flow('run', 'complete', run.run_id, '--session', id, '--actor', 'fixture',
      '--expected-run-revision', String(run.revision), '--summary', summary, '--advance',
      '--expected-orchestration-revision', String(run.continuation.revision_requirements.expected_orchestration_revision));
    const args = ['session', 'complete', '--session', id, '--actor', 'fixture',
      '--expected-orchestration-revision', String(sealed.result.orchestration_revision)];
    const complete = await flow(...args);
    const receipt = complete.replay.transition_id;
    assert.deepEqual(complete.result.evolve_closeout, { status: 'dispatched', receipt });
    // Observe the detached worker's durable result before redelivering the event.
    const deadline = Date.now() + 20_000;
    let harvest;
    while (harvest === undefined) {
      try {
        harvest = await closeout('show', receipt);
      } catch (error) {
        if (Date.now() >= deadline || !/Completion has not been harvested/.test(error.message)) throw error;
        await delay(100);
      }
    }
    const replay = await flow(...args);
    assert.equal(replay.replay.transition_id, receipt);
    assert.equal(replay.replay.status, 'replayed');
    assert.deepEqual(await closeout('session', id, '--receipt', receipt), { ...harvest, replayed: true });
    return { receipt, candidates: harvest.candidates, id: harvest.id };
  }

  const session = 'preflight';
  const first = await start(session);
  assert.deepEqual(first.wiki_categories, ['arch']);
  assert.deepEqual(first.wiki_constraints.map(item => item.id), [shared.id, constraintId]);
  assert.deepEqual(first.wiki_constraints[0].source_repository, { alias: 'producer', id: linkedId });
  assert.equal(first.wiki_constraints[0].body.trim(), consumerRule);
  const rules = async (run, ...options) => (await flow('run', 'wiki-constraints', run.run_id, '--session', session, ...options)).result;
  const initialRules = await rules(first, '--path', 'migrate.mjs');
  assert.equal(initialRules.source, 'wiki');
  assert.deepEqual(initialRules.constraints.map(rule => rule.id), [shared.id, constraintId, pathRule]);
  assert.deepEqual((await rules(first, '--category', 'coding', '--path', 'migrate.mjs')).constraints.map(rule => rule.id), [codingId]);
  assert.deepEqual((await rules(first, '--keyword', 'MIGRATION')).constraints.map(rule => rule.id).sort(), [constraintId, codingId].sort());
  assert.deepEqual((await rules(first, '--keyword', 'replica')).constraints.map(rule => rule.id), [shared.id]);
  assert.deepEqual((await rules(first, '--keyword', 'staging')).constraints, []);
  await writeFile(pathDraft, JSON.stringify({ operation: 'retire', entry: pathRule }));
  const retiredPathRule = await agent('wiki', 'propose', pathDraft, '--evidence', 'fixture:update');
  await agent('wiki', 'apply', retiredPathRule.id);
  await configureLinks(links.slice(1));
  assert.deepEqual(await rules(first, '--path', 'migrate.mjs'), initialRules);
  assert.deepEqual((await rules(first, '--keyword', 'replica')).constraints.map(rule => rule.id), [shared.id]);
  await readSkill(session, first);
  await assert.rejects(invoke(process.execPath, [migrate, database]), /Dry-run flag required/);
  const descriptor = join(root, 'correction.json');
  await writeFile(descriptor, JSON.stringify({
    host_kind: 'fixture', host_session_id: 'migration', entry_id: 'correction', quote: correction,
  }));
  const { result: { ref } } = await flow('session', 'evidence', descriptor, '--session', session);
  await writeFile(descriptor, JSON.stringify({
    host_kind: 'fixture', host_session_id: 'migration', entry_id: 'unselected', quote: excludedQuote,
  }));
  await flow('session', 'evidence', descriptor, '--session', session);
  const fixed = await retry(session, first, 'Dry-run flag required.', ref);
  assert.deepEqual((await rules(fixed, '--path', 'migrate.mjs')).constraints.map(rule => rule.id), [constraintId]);
  const verified = (await invoke(process.execPath, [migrate, database, '--dry-run'])).trim();
  assert.equal(verified, 'migration preflight verified: schema 1, records 3');
  assert.equal(await readFile(database, 'utf8'), original);
  const harvest = await finish(session, fixed, verified);
  assert.equal(harvest.candidates.length, 1);
  assert.ok(harvest.candidates[0].sources.includes(`receipt:${project}:${harvest.receipt}#${ref}`));
  assert.equal(harvests.get('preflight'), 1);
  const reviewed = await agent('session', 'review', session);
  const signal = reviewed.signals.find(item => item.kind === 'correction');
  assert.deepEqual(signal.runIds, [first.run_id]);
  assert.deepEqual(signal.sources, [ref]);
  assert.equal(reviewed.runs.find(item => item.id === first.run_id).skillRef.skill_id, skill);
  const published = await agent('closeout', 'publish', harvest.id, harvest.candidates[0].id, 'Staging migration preflight');
  const reference = await agent('wiki', 'get', published.id);
  assert.equal(reference.entry.mode, 'reference');
  assert.equal(reference.body.trim(), method);
  assert.deepEqual(reference.sources, harvest.candidates[0].sources);
  assert.equal((await agent('wiki', 'search', 'migration preflight')).results[0].id, published.id);

  const transient = await start('transient');
  assert.deepEqual(transient.wiki_constraints.map(item => item.id), [constraintId]);
  await readSkill('transient', transient);
  await assert.rejects(invoke(process.execPath, ['-e',
    "fetch(process.argv[1]).then(r => { if (!r.ok) { console.error('HTTP ' + r.status); process.exitCode = 1; } })",
    `${origin}/transient`]), /HTTP 503/);
  const resumed = await retry('transient', transient, 'Temporary network error HTTP 503.');
  assert.equal((await fetch(`${origin}/transient`)).status, 200);
  const empty = await finish('transient', resumed, 'Temporary network error HTTP 503 resolved on retry.');
  assert.deepEqual(empty.candidates, []);
  assert.equal(harvests.get('transient'), 1);
  assert.deepEqual((await agent('session', 'review', 'transient')).signals, []);
  if (codexEvolve) {
    await verifyEvolveHost({
      root, maestro, memory, env, origin, git, agent, invoke, skill, skillEntry, baselineSkill,
      session, run: first, correctionAnchor: ref, transientSession: 'transient',
    });
  } else {
    const draft = await agent('evolve', 'draft', skillEntry, 'Run the staging migration check with --dry-run.',
      '--priority', 'normal', '--when', 'checking a staging migration', '--evidence', signal.sources[0]);
    assert.equal(draft.changes.length, 2);
    assert.match(draft.changes[0].content, /references\/learnings\//);
  }
  const constraints = await agent('wiki', 'constraints', '--skill', skill, '--category', 'arch');
  assert.deepEqual(constraints.map(item => item.id), [constraintId]);

  await rm(join(root, '.evolve', 'index.db'));
  await agent('wiki', 'build');
  assert.deepEqual(await agent('wiki', 'constraints', '--skill', skill, '--category', 'arch'), constraints);
  assert.deepEqual(await agent('wiki', 'get', published.id), reference);
  assert.equal((await agent('wiki', 'get', `${project}:spec:S-1`)).id, constraintId);
  assert.equal((await closeout('show', harvest.receipt)).id, harvest.id);

  const referenceSource = join(sources, 'reference');
  await mkdir(join(referenceSource, '.workflow', 'knowhow'));
  await writeFile(join(referenceSource, '.workflow', 'knowhow', 'K-1.md'), [
    '---', 'title: Runbook for replica preflight', `appliesToRepoIds: [${currentId}]`, '---', '',
    'Inspect the replica preflight checklist. [[entries/preflight-private]] [[entries/preflight-path]]', '',
  ].join('\n'));
  await agent('wiki', 'migrate', referenceSource, '--wiki-root', referenceSource, '--project', 'reference-fixture', '--apply');
  const sharedRef = await agent('wiki', 'get', 'reference-fixture:knowhow:K-1', '--wiki-root', referenceSource);
  const addReference = (source, id, title, extra = '') => writeFile(join(source, 'wiki', 'entries', `${id}.md`), [
    '---', `title: ${title}`, 'mode: reference', 'status: active', 'sources: [fixture:preflight-reference]',
    extra || 'scope: [project]', '---', '', 'Replica preflight note.', '',
  ].join('\n'));
  await addReference(referenceSource, 'preflight-private', 'Private preflight', `scope: [project]\nrepositories: [${linkedId}]`);
  await addReference(referenceSource, 'preflight-path', 'Script preflight', 'scope: [path:*.mjs]');
  await addReference(producer, 'preflight-denied', 'Constraint repository preflight');
  await addReference(join(sources, 'stale'), 'preflight-mismatch', 'Stale identity preflight');
  await writeFile(join(referenceSource, 'wiki', 'unmanaged.md'), '# Unmanaged preflight\n\nReplica preflight note.\n');
  // 共享查询直接读取当前 Markdown。旧索引里的活跃条目退役后也不可见。
  const retiredFile = join(referenceSource, 'wiki', 'entries', 'preflight-retired.md');
  await addReference(referenceSource, 'preflight-retired', 'Retired preflight');
  await agent('wiki', 'build', '--wiki-root', referenceSource);
  await writeFile(retiredFile, (await readFile(retiredFile, 'utf8')).replace('status: active', 'status: deprecated'));
  const sourceIndex = join(referenceSource, '.evolve', 'index.db');
  const sourceIndexBytes = await readFile(sourceIndex);
  await configureLinks(links);
  const searchReferences = (...options) => flow('wiki', 'references', 'preflight', '--hop', '1', ...options);
  const sharedResults = await searchReferences();
  assert.deepEqual(sharedResults.groups.map(group => group.source_repository.alias), ['current', 'reference']);
  assert.ok(sharedResults.groups[0].results.some(item => item.id === published.id));
  const linkedResults = sharedResults.groups[1];
  assert.equal(linkedResults.source_repository.id, referenceId);
  assert.deepEqual(linkedResults.results.map(item => item.id), [sharedRef.id]);
  assert.deepEqual(linkedResults.results[0].related, []);
  assert.deepEqual(linkedResults.links, []);
  const pathResults = (await searchReferences('--repo', referenceId, '--path', '.\\migrate.mjs')).groups[0];
  assert.deepEqual(pathResults.results.map(item => item.id).sort(), [sharedRef.id, 'entries/preflight-path'].sort());
  assert.deepEqual(pathResults.links, [{ source: sharedRef.path, target: 'wiki/entries/preflight-path.md' }]);
  const openReference = (id, ...options) => flow('wiki', 'reference', id, '--repo', referenceId, ...options);
  assert.deepEqual((await openReference('reference-fixture:knowhow:K-1')).entry, sharedRef);
  assert.equal((await openReference('preflight-private')).entry, null);
  assert.equal((await openReference('preflight-retired')).entry, null);
  assert.equal((await openReference('preflight-path')).entry, null);
  assert.equal((await openReference('preflight-path', '--path', 'migrate.mjs')).entry.id, 'entries/preflight-path');
  assert.deepEqual(await readFile(sourceIndex), sourceIndexBytes);
  await assert.rejects(searchReferences('--repo', linkedId), /does not grant read capability for knowhow/);
  await configureLinks(links.filter(link => link.name !== 'reference'));
  assert.deepEqual((await searchReferences()).groups.map(group => group.source_repository.alias), ['current']);
  await assert.rejects(openReference(sharedRef.id), /Repository selector not found/);

  const global = env.MAESTRO_HOME;
  const collab = join(workflow, 'collab');
  const layerFixture = [
    { scope: 'global', body: 'Check the signed global baseline.', source: global, wiki: global, legacy: join(global, 'specs') },
    { scope: 'team', body: 'Check the shared staging window.', source: root, wiki: collab, legacy: join(collab, 'specs') },
    ...['alice', 'alice-2'].map(uid => ({ scope: 'personal', uid, body: `Check the ${uid} migration profile.`,
      source: root, wiki: join(collab, 'personal', uid), legacy: join(collab, 'specs', uid) })),
  ];
  await mkdir(join(collab, 'members'), { recursive: true });
  const membership = async (uid, domain) => writeFile(join(collab, 'members', `${uid}.json`), JSON.stringify({
    uid, name: uid, email: `alice@${domain}`, host: 'fixture', role: 'member', joinedAt: '2026-11-01T00:00:00Z',
  }));
  await membership('alice', 'example.invalid');
  await membership('alice-2', 'other.invalid');
  await git('config', 'user.name', 'Fixture Alice');
  await git('config', 'user.email', 'alice@example.invalid');
  for (const { scope, body, legacy } of layerFixture) {
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'architecture-constraints.md'), [
      '---', 'category: arch', '---', `<spec-entry sid="S-1" title="${scope} check">`, body, '</spec-entry>', '',
    ].join('\n'));
  }
  await configureLinks(links);
  const beforeLayers = await cli(maestro, ['spec', 'load', '--category', 'arch', '--json'], env);
  const ordered = [layerFixture[0].body, consumerRule, 'Use staging for migration checks.', layerFixture[1].body, layerFixture[2].body];
  assert.equal(beforeLayers.totalLoaded, ordered.length);
  const order = ordered.map(body => beforeLayers.content.indexOf(body));
  assert.ok(order.every(at => at >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(!beforeLayers.content.includes(layerFixture[3].body));
  assert.equal((await start('unmigrated-layers')).wiki_constraints, undefined);
  await assert.rejects(agent('wiki', 'migrate', root, '--scope', 'personal', '--uid', '../alice', '--project', project), /valid member UID/);
  const layerIds = new Set();
  for (const { scope, uid, source, wiki } of layerFixture) {
    const args = ['wiki', 'migrate', source, '--scope', scope, '--project', project, ...(uid ? ['--uid', uid] : [])];
    const [preview] = await agent(...args);
    assert.equal(preview.existing, false);
    assert.deepEqual(await agent(...args, '--apply'), [preview]);
    assert.ok((await agent(...args, '--apply')).every(item => item.existing));
    assert.ok(await readFile(join(wiki, 'wiki', 'entries', `${preview.id}.md`), 'utf8'));
    layerIds.add(preview.id);
  }
  assert.equal(layerIds.size, 4);
  const firstMember = await start('alice-rule-snapshot');
  assert.deepEqual(firstMember.wiki_constraints.map(rule => rule.body.trim()), ordered);
  assert.deepEqual(firstMember.wiki_constraints.map(rule => rule.source_layer), [
    { kind: 'global' }, undefined, undefined, { kind: 'team' }, { kind: 'personal', uid: 'alice' },
  ]);
  await git('config', 'user.email', 'alice@other.invalid');
  const secondMember = await start('second-member-rules');
  assert.deepEqual(secondMember.wiki_constraints.map(rule => rule.body.trim()), [...ordered.slice(0, -1), layerFixture[3].body]);
  const memberHistory = await flow('run', 'wiki-constraints', firstMember.run_id, '--session', 'alice-rule-snapshot');
  assert.deepEqual(memberHistory.result.constraints, firstMember.wiki_constraints);
  await git('config', 'user.email', 'visitor@example.invalid');
  const visitor = await start('visitor-rules');
  assert.deepEqual(visitor.wiki_constraints.map(rule => rule.body.trim()), ordered.slice(0, 3));
  console.log('Maestro preflight, evidence capture, Memory closeout, Wiki publication and index rebuild passed.');
  console.log('Wiki migration preserved global, linked, project, team and member rule order and isolation.');
  console.log('Wiki reference search and open respected Knowhow sharing, active scope, graph visibility and revocation.');
} finally {
  if (model.listening) await new Promise(resolve => model.close(resolve));
  assert.match(await realpath(root), /[\\/]evolve-maestro-closeout-[a-zA-Z0-9]+$/);
  await rm(root, { recursive: true, force: true });
}
