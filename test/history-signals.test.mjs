import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createSkillDesignTask,
  decideSkillRoute,
  initWiki,
} from 'self-evolving-workflow';
import { DatabaseSync } from '../dist/common.js';
import { resolveSkillEntry } from '../dist/skill-design.js';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));

async function makeFixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'evolve-history-signals-'));
  const root = join(base, 'repo');
  const home = join(base, 'home');
  const codexHome = join(home, 'codex');
  const claudeHome = join(home, 'claude');
  const agyHome = join(home, '.gemini', 'antigravity');
  await Promise.all([
    mkdir(join(root, 'skills', 'ew-orchestrate', 'steps', 'ew-execute'), { recursive: true }),
    mkdir(join(codexHome, 'sessions', '2026', '11', '24'), { recursive: true }),
    mkdir(join(claudeHome, 'projects', 'repo'), { recursive: true }),
    mkdir(agyHome, { recursive: true }),
  ]);
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENT_MEMORY_LLM_')) delete env[key];
  }

  async function runCli(args, extraEnv = {}) {
    const { stdout } = await execFileAsync(process.execPath, [cli, '--root', root, ...args], {
      cwd: root,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
    });
    return stdout;
  }

  async function runJson(args, extraEnv = {}) {
    return JSON.parse(await runCli(args, extraEnv));
  }

  // 1. Codex transcript with user correction + tool call + tool error
  const codexPath = join(codexHome, 'sessions', '2026', '11', '24', 'rollout-codex-1.jsonl');
  const codexRows = [
    { timestamp: '2026-11-24T01:00:00Z', type: 'session_meta', payload: { id: 'codex-1', cwd: root, source: 'cli' } },
    {
      timestamp: '2026-11-24T01:00:01Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run ew-execute to build the module.' }] },
    },
    {
      timestamp: '2026-11-24T01:00:02Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: { cmd: 'npm run build -- ew-execute' } },
    },
    {
      timestamp: '2026-11-24T01:00:03Z',
      type: 'response_item',
      payload: { type: 'function_call_output', output: 'TypeError: missing contract_version; exit code 1' },
    },
    {
      timestamp: '2026-11-24T01:00:04Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '不对，应该先验证 Skill contract 再构建。' }] },
    },
  ];
  await writeFile(codexPath, codexRows.map(item => JSON.stringify(item)).join('\n') + '\n');

  // 2. Claude transcript with tool_use + tool_result error
  const claudePath = join(claudeHome, 'projects', 'repo', 'claude-1.jsonl');
  const claudeRows = [
    {
      type: 'user',
      uuid: 'u1',
      sessionId: 'claude-1',
      cwd: root,
      timestamp: '2026-11-24T02:00:00Z',
      message: { role: 'user', content: 'Check ew-plan workflow.' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      sessionId: 'claude-1',
      cwd: root,
      timestamp: '2026-11-24T02:00:01Z',
      message: {
        id: 'm1',
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node dist/workflow-cli.js skill validate ew-plan' } }],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      sessionId: 'claude-1',
      cwd: root,
      timestamp: '2026-11-24T02:00:02Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'ENOENT: references/prepare.md missing' }],
      },
    },
  ];
  await writeFile(claudePath, claudeRows.map(item => JSON.stringify(item)).join('\n') + '\n');

  // 3. Agy transcript + conversation_summaries.db with ERROR step
  const agyLogDir = join(agyHome, 'brain', 'agy-1', '.system_generated', 'logs');
  await mkdir(agyLogDir, { recursive: true });
  const summaryDb = new DatabaseSync(join(agyHome, 'conversation_summaries.db'));
  summaryDb.exec('CREATE TABLE conversation_summaries (conversation_id TEXT, workspace_uris TEXT, parent_conversation_id TEXT)');
  summaryDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run(
    'agy-1',
    JSON.stringify([`file:///${root.replace(/\\/g, '/')}`]),
    '',
  );
  summaryDb.close();
  const agyRows = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-24T03:00:00Z',
      content: '<USER_REQUEST>\nValidate workflow-evolve packaging\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'ERROR',
      created_at: '2026-11-24T03:00:05Z',
      content: 'exec_command rejected: blocked by policy',
    },
  ];
  await writeFile(join(agyLogDir, 'transcript_full.jsonl'), agyRows.map(item => JSON.stringify(item)).join('\n') + '\n');

  return { root, codexPath, runCli, runJson };
}

test('history collect incrementally indexes transcript, memory, wiki, and llm signals without rescanning unchanged offsets', async t => {
  const f = await makeFixture(t);

  // Add episodic memory and needs_review wiki entry
  await f.runJson([
    'kb', 'add', 'Fix ew-execute contract check before build.',
    '--kind', 'episodic', '--type', 'correction', '--session', 'codex-1', '--evidence', 'codex:codex-1:1',
  ]);
  initWiki(f.root);
  await mkdir(join(f.root, 'wiki', 'entries'), { recursive: true });
  await writeFile(join(f.root, 'wiki', 'entries', 'stale-rule.md'), [
    '---',
    'title: "Stale Check"',
    'mode: constraint',
    'status: needs_review',
    'scope: [project]',
    'sources: [conv:1]',
    '---',
    '',
    'Needs review for ew-execute.',
  ].join('\n'));

  // 1st collect (no LLM): scans all 3 transcripts + memory + wiki
  const first = await f.runJson(['history', 'collect']);
  assert.equal(first.sessions_checked, 3);
  assert.equal(first.sessions_incremental, 3);
  assert.equal(first.sessions_skipped, 0);
  assert.ok(first.by_source.transcript >= 4);
  assert.equal(first.by_source.memory, 1);
  assert.equal(first.by_source.wiki, 1);

  // 2nd collect immediately: all 3 sessions and unchanged memory/wiki must be skipped
  const second = await f.runJson(['history', 'collect']);
  assert.equal(second.sessions_checked, 3);
  assert.equal(second.sessions_incremental, 0);
  assert.equal(second.sessions_skipped, 3);
  assert.equal(second.new_signals, 0);

  // Append incremental line to codex-1 and run with mock --llm
  let llmCalls = 0;
  const server = createServer(async (req, res) => {
    llmCalls += 1;
    let body = '';
    for await (const chunk of req) body += chunk;
    const prompt = JSON.parse(body).messages.at(-1).content;
    const idMatch = prompt.match(/\[(codex:codex-1:\d+)]/);
    const reply = idMatch
      ? [{ memories: [{ type: 'verified_fix', content: 'Verified contract_version fix in ew-execute.', source_message_ids: [idMatch[1]] }] }]
      : [];
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  await appendFile(f.codexPath, JSON.stringify({
    timestamp: '2026-11-24T01:05:00Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '很好，现在修复了。' }] },
  }) + '\n');

  const third = await f.runJson(['history', 'collect', '--llm'], {
    AGENT_MEMORY_LLM_MODEL: 'fixture',
    AGENT_MEMORY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  });
  assert.equal(third.sessions_checked, 3);
  // Enabling the semantic consumer must backfill all of its unread history,
  // even when the deterministic consumer already reached EOF.
  assert.equal(third.sessions_incremental, 3);
  assert.equal(third.sessions_skipped, 0);
  assert.equal(third.by_source.llm, 1);
  assert.equal(llmCalls, 3);

  // List sessions with incremental state
  const listed = await f.runJson(['history', 'list', '--signals-only']);
  assert.equal(listed.length, 3);
  assert.ok(listed.every(item => item.has_new_bytes === false));

  // Search collected signals across sources
  const memHits = await f.runJson(['history', 'search', '--source', 'memory']);
  assert.equal(memHits.total, 1);
  assert.equal(memHits.results[0].source_kind, 'memory');

  const wikiHits = await f.runJson(['history', 'search', '--source', 'wiki']);
  assert.equal(wikiHits.total, 1);
  assert.equal(wikiHits.results[0].anchor, 'entries/stale-rule');

  const llmHits = await f.runJson(['history', 'search', '--source', 'llm']);
  assert.equal(llmHits.total, 1);
  assert.equal(llmHits.results[0].signal_type, 'verified_fix');

  // Search live + signals by tool role & skill
  const toolErrHits = await f.runJson(['history', 'search', '--role', 'error', '--host', 'claude']);
  assert.equal(toolErrHits.total, 1);
  assert.match(toolErrHits.results[0].snippet, /ENOENT/);

  const skillHits = await f.runJson(['history', 'search', '--skill', 'ew-execute', '--source', 'signals']);
  assert.ok(skillHits.total >= 2);

  // Show context around anchor with tool calls included
  const codexErr = await f.runJson(['history', 'search', 'TypeError', '--host', 'codex', '--role', 'error']);
  assert.equal(codexErr.total, 1);
  const shown = await f.runJson([
    'history', 'show', 'codex-1', '--host', 'codex',
    '--anchor', codexErr.results[0].anchor, '--context', '1',
  ]);
  assert.equal(shown.entries.length, 3);
  assert.equal(shown.entries[0].kind, 'tool_call');
  assert.equal(shown.entries[1].kind, 'error');
  assert.equal(shown.entries[2].role, 'user');

  const claudeShown = await f.runJson([
    'history', 'show', 'claude-1', '--host', 'claude',
    '--anchor', toolErrHits.results[0].anchor, '--context', '1',
  ]);
  assert.equal(claudeShown.entries.length, 2);
  assert.equal(claudeShown.entries[0].kind, 'tool_call');
  assert.equal(claudeShown.entries[1].kind, 'error');
});

test('step skill resolution, optional --skill in skill-design, and validateWorkflowSkill work on nested & new packages', async t => {
  const f = await makeFixture(t);
  await writeFile(join(f.root, 'skills', 'ew-orchestrate', 'steps', 'ew-execute', 'SKILL.md'), [
    '---',
    'name: ew-execute',
    'description: Execute planned step.',
    'session-mode: run',
    'contract:',
    '  contract_version: 2.1',
    '  produces: []',
    '---',
    '# Execute',
  ].join('\n'));
  assert.equal(resolveSkillEntry(f.root, 'ew-execute'), 'skills/ew-orchestrate/steps/ew-execute/SKILL.md');

  // Brand-new Skill creation without pre-assigned --skill
  const decision = decideSkillRoute({
    content: '需要新增一个包含3个步骤的发布检查 Skill，生成新产物。',
    sources: ['session:s1'],
    stepCount: 3,
    requiresNewArtifacts: true,
  });
  assert.equal(decision.route, 'skill-design');
  const task = createSkillDesignTask(f.root, {
    closeoutId: 'a'.repeat(64),
    candidateId: 'b'.repeat(64),
    content: 'New release check Skill',
    sources: ['session:s1'],
    decision,
  });
  assert.equal(task.task.target.skill_id, undefined);
});

test('session review --no-llm returns deterministic signals from native runs and episodic memory', async t => {
  const f = await makeFixture(t);
  await writeFile(join(f.root, 'skills', 'ew-orchestrate', 'steps', 'ew-execute', 'SKILL.md'), [
    '---',
    'name: ew-execute',
    'description: Execute planned step.',
    'session-mode: run',
    'contract:',
    '  contract_version: 2.1',
    '  produces: []',
    '---',
    '# Execute',
  ].join('\n'));
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init'], { cwd: f.root, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: f.root, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: f.root, windowsHide: true });
  execFileSync('git', ['add', '.'], { cwd: f.root, windowsHide: true });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: f.root, windowsHide: true });

  await f.runJson(['session', 'create', 'Test deterministic review', '--id', 's-det', '--chain', 'ew-execute']);
  const run1 = await f.runJson(['run', 'create', '--session', 's-det']);
  await f.runJson(['run', 'update', run1.run_id, 'failed', '--reason', 'Missing preflight check', '--session', 's-det']);
  await f.runJson([
    'kb', 'add', 'User corrected ew-execute preflight step.',
    '--kind', 'episodic', '--type', 'correction', '--session', 's-det', '--evidence', 'conv:1',
  ]);

  const reviewed = await f.runJson(['session', 'review', 's-det', '--no-llm']);
  assert.equal(reviewed.session, 's-det');
  assert.ok(reviewed.signals.some(item => item.kind === 'error' && item.summary.includes('Missing preflight check')));
  assert.ok(reviewed.signals.some(item => item.kind === 'correction' && item.summary.includes('ew-execute preflight')));

  // validateWorkflowSkill passes for committed step skill
  const validated = await f.runJson(['skill', 'validate', 'ew-execute']);
  assert.equal(validated.validated, true);
  assert.equal(validated.skill_id, 'ew-execute');

  // retrospective.json in real runDir (.evolve/runs/<session>/<run>/outputs/) is collected by both session review and history collect
  await mkdir(join(run1.run_dir, 'outputs'), { recursive: true });
  await writeFile(join(run1.run_dir, 'outputs', 'retrospective.json'), JSON.stringify({
    insights: [{
      id: 'INS-12345678',
      lens: 'process',
      summary: 'ew-execute missed preflight gate check',
      route: 'skill-evolve',
      evidence: [`evolve:s-det#${run1.run_id}`],
    }],
  }));
  const reviewedWithRetro = await f.runJson(['session', 'review', 's-det', '--no-llm']);
  assert.ok(reviewedWithRetro.signals.some(item => item.summary.includes('[retro:process:skill-evolve]')));

  // skill validate --all passes in a standalone project with only local skills
  const validateAll = await f.runJson(['skill', 'validate', '--all']);
  assert.equal(validateAll.total, 1);
  assert.equal(validateAll.passed, 1);
  assert.equal(validateAll.failed, 0);

  // Add a custom top-level skill and verify workflows show + skill sync
  await mkdir(join(f.root, 'skills', 'demo-audit'), { recursive: true });
  await writeFile(join(f.root, 'skills', 'demo-audit', 'SKILL.md'), [
    '---',
    'name: demo-audit',
    'description: Audit local demo config.',
    'session-mode: none',
    'version: 0.1.0',
    '---',
    '# Demo Audit',
  ].join('\n'));
  execFileSync('git', ['add', '.'], { cwd: f.root, windowsHide: true });
  execFileSync('git', ['commit', '-qm', 'add demo-audit'], { cwd: f.root, windowsHide: true });
  const docText = await f.runCli(['skill', 'workflows', 'show', 'demo-audit']);
  assert.match(docText, /^name: demo-audit$/m);

  const synced = await f.runJson(['skill', 'sync', '--scope', 'project', '--host', 'codex']);
  assert.equal(synced.status, 'synced');
  assert.ok(synced.skills.includes('demo-audit'));
  assert.match(await readFile(join(f.root, '.codex', 'skills', 'demo-audit', 'SKILL.md'), 'utf8'), /version: 0\.1\.0/);
});

test('noise filter skips assistant/tool_call ERROR_PATTERN and preserves multi-signal anchors & --role parity', async t => {
  const f = await makeFixture(t);
  // Add an assistant message mentioning SyntaxError and a tool_call editing TypeError (not actual errors!)
  await appendFile(f.codexPath, [
    JSON.stringify({
      timestamp: '2026-11-24T01:06:00Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'edit_file', arguments: { content: 'throw new TypeError("x")' } },
    }),
    JSON.stringify({
      timestamp: '2026-11-24T01:06:05Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Resolved SyntaxError in demo-audit.' }] },
    }),
  ].join('\n') + '\n');

  const collected = await f.runJson(['history', 'collect', '--host', 'codex']);
  assert.equal(collected.sessions_checked, 1);

  const codexErrors = await f.runJson(['history', 'search', '--host', 'codex', '--role', 'error', '--source', 'signals']);
  // Only the real function_call_output error (not edit_file tool_call or assistant summary!)
  assert.equal(codexErrors.total, 1);
  assert.match(codexErrors.results[0].snippet, /missing contract_version/);

  const allErrors = await f.runJson(['history', 'search', '--host', 'codex', '--role', 'error', '--source', 'all']);
  assert.equal(allErrors.total, 1);
});


