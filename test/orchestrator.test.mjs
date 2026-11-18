import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AgentManager,
  ProviderRegistry,
  WorktreeManager,
} from 'self-evolving-workflow/orchestrator';

const workflowCli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));

function createGitRepo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Orchestrator Test');
  git('config', 'user.email', 'orchestrator@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.evolve/\n');
  writeFileSync(join(root, 'README.md'), '# Repo\n');
  git('add', '.');
  git('commit', '-qm', 'Initial commit');
  return {
    root,
    git,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('ProviderRegistry manages built-ins, custom CLI providers, and derived aliases', async () => {
  const registry = new ProviderRegistry();
  const ids = registry.list().map(item => item.id);
  assert.deepEqual(ids, ['codex', 'agy', 'claude']);

  const root = mkdtempSync(join(tmpdir(), 'orch-custom-'));
  try {
    const script = join(root, 'custom-agent.mjs');
    writeFileSync(script, [
      "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));",
    ].join('\n'));

    registry.registerCustomCli({
      id: 'opencode',
      displayName: 'OpenCode CLI',
      executable: script,
      buildTurn: ctx => ({
        args: ['run', '--mode', ctx.mode, ...(ctx.model ? ['--model', ctx.model] : []), ctx.prompt],
      }),
    });
    registry.registerAlias('codex-fast', 'codex', { model: 'gpt-5-mini', mode: 'analysis' });

    assert.equal(registry.has('opencode'), true);
    assert.equal(registry.has('codex-fast'), true);
    assert.equal(registry.list().find(item => item.id === 'codex-fast')?.derivedFrom, 'codex');

    const manager = new AgentManager({ registry, store: false });
    try {
      const delegated = await manager.delegate({
        provider: 'opencode',
        prompt: 'Check architecture',
        cwd: root,
        model: 'oc-1',
      });
      const payload = JSON.parse(delegated.output);
      assert.deepEqual(payload.argv, ['run', '--mode', 'analysis', '--model', 'oc-1', 'Check architecture']);
    } finally {
      await manager.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AgentManager supports Codex multi-turn resume, streaming events, and Claude CLI session lifecycle', async () => {
  const repo = createGitRepo('orch-sessions-');
  const prevCodex = process.env.CODEX_REPLAY_EXECUTABLE;
  const prevClaude = process.env.CLAUDE_EXECUTABLE;
  try {
    const fakeCodex = join(repo.root, 'fake-codex.mjs');
    writeFileSync(fakeCodex, [
      "import { readFileSync } from 'node:fs';",
      "const stdin = readFileSync(0, 'utf8');",
      "const isResume = process.argv.includes('resume');",
      "if (!isResume) {",
      "  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }));",
      "  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Checking files' } }));",
      "  console.log(JSON.stringify({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } }));",
      "  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', status: 'completed', aggregated_output: 'ok' } }));",
      "  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'turn-1:' + stdin } }));",
      "} else {",
      "  const idx = process.argv.indexOf('resume');",
      "  const threadId = process.argv[process.argv.length - 2];",
      "  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'resumed:' + threadId + ':' + stdin + ':' + (idx > 0) } }));",
      "}",
      "console.log(JSON.stringify({ type: 'turn.completed' }));",
    ].join('\n'));

    const fakeClaude = join(repo.root, 'fake-claude.mjs');
    writeFileSync(fakeClaude, [
      "const argv = process.argv.slice(2);",
      "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' }));",
      "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.ts' } }, { type: 'text', text: 'claude-ok' }] } }));",
      "console.log(JSON.stringify({ type: 'result', session_id: 'claude-sess-1', result: JSON.stringify({ argv }) }));",
    ].join('\n'));

    process.env.CODEX_REPLAY_EXECUTABLE = fakeCodex;
    process.env.CLAUDE_EXECUTABLE = fakeClaude;

    const events = [];
    const manager = new AgentManager({ root: repo.root });
    try {
      const codexSess = await manager.createSession({
        sessionId: 'codex-multi',
        provider: 'codex',
        cwd: repo.root,
        mode: 'analysis',
      });
      const unsub = manager.onEvent(event => events.push(event));
      const t1 = await manager.runTurn(codexSess.id, { prompt: 'first prompt' });
      assert.equal(t1.status, 'completed');
      assert.equal(t1.output, 'turn-1:first prompt');
      assert.equal(t1.externalSessionId, 'thread-123');
      assert.ok(events.some(e => e.type === 'reasoning_delta' && e.text === 'Checking files'));
      assert.ok(events.some(e => e.type === 'tool_call' && e.status === 'completed'));
      unsub();

      // Simulate process restart via a new AgentManager reading the persisted SQLite session
      await manager.close();
      const reloaded = new AgentManager({ root: repo.root });
      try {
        await reloaded.resumeSession('codex-multi');
        const t2 = await reloaded.runTurn('codex-multi', { prompt: 'second prompt' });
        assert.equal(t2.status, 'completed');
        assert.equal(t2.output, 'resumed:thread-123:second prompt:true');
        const saved = reloaded.getSession('codex-multi');
        assert.equal(saved?.turns.length, 2);
        assert.equal(saved?.externalSessionId, 'thread-123');

        const claudeSess = await reloaded.createSession({
          sessionId: 'claude-cli',
          provider: 'claude',
          cwd: repo.root,
          mode: 'write',
        });
        const claudeTurn = await reloaded.runTurn(claudeSess.id, { prompt: 'run cli check' });
        assert.equal(claudeTurn.status, 'completed');
        assert.equal(claudeTurn.externalSessionId, 'claude-sess-1');
        const parsedClaude = JSON.parse(claudeTurn.output);
        assert.ok(parsedClaude.argv.includes('acceptEdits'));
        assert.equal(parsedClaude.argv.includes('--mcp-config'), false);
      } finally {
        await reloaded.close();
      }
    } finally {
      await manager.close();
    }
  } finally {
    if (prevCodex === undefined) delete process.env.CODEX_REPLAY_EXECUTABLE;
    else process.env.CODEX_REPLAY_EXECUTABLE = prevCodex;
    if (prevClaude === undefined) delete process.env.CLAUDE_EXECUTABLE;
    else process.env.CLAUDE_EXECUTABLE = prevClaude;
    repo.cleanup();
  }
});

test('AgentManager interrupts active turns and isolates parallel agents in Git worktrees', async () => {
  const repo = createGitRepo('orch-parallel-');
  const prevCodex = process.env.CODEX_REPLAY_EXECUTABLE;
  const prevAgy = process.env.AGY_EXECUTABLE;
  try {
    const slowAgent = join(repo.root, 'slow-agent.mjs');
    writeFileSync(slowAgent, 'setTimeout(() => console.log("done"), 10000);\n');
    const parallelAgent = join(repo.root, 'parallel-agent.mjs');
    writeFileSync(parallelAgent, [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const prompt = readFileSync(0, 'utf8');",
      "writeFileSync(join(process.cwd(), prompt + '.txt'), process.cwd());",
      "console.log(JSON.stringify({ cwd: process.cwd(), prompt }));",
    ].join('\n'));

    process.env.AGY_EXECUTABLE = slowAgent;
    const manager = new AgentManager({ root: repo.root });
    try {
      const slow = await manager.createSession({
        sessionId: 'slow-one',
        provider: 'agy',
        cwd: repo.root,
        mode: 'analysis',
        persistent: false,
      });
      const turnPromise = manager.runTurn(slow.id, { prompt: 'wait' });
      setTimeout(() => { void manager.interrupt(slow.id, 'user_cancel'); }, 100);
      const interrupted = await turnPromise;
      assert.equal(interrupted.status, 'interrupted');

      process.env.CODEX_REPLAY_EXECUTABLE = parallelAgent;
      const results = await manager.runParallel([
        { id: 'worker-a', provider: 'codex', prompt: 'alpha', cwd: repo.root, mode: 'write' },
        { id: 'worker-b', provider: 'codex', prompt: 'beta', cwd: repo.root, mode: 'write' },
      ], { concurrency: 2, isolateWorktrees: true });

      assert.equal(results.length, 2);
      assert.ok(results.every(item => item.ok));
      const payloadA = JSON.parse(results[0].result.output);
      const payloadB = JSON.parse(results[1].result.output);
      assert.notEqual(payloadA.cwd, payloadB.cwd);
      assert.notEqual(payloadA.cwd, repo.root);
      assert.equal(existsSync(join(repo.root, 'alpha.txt')), false);
      assert.equal(existsSync(join(repo.root, 'beta.txt')), false);

      // Ephemeral worktrees are cleaned up automatically after runParallel
      const remainingWorktrees = new WorktreeManager().list(repo.root);
      assert.equal(remainingWorktrees.length, 1);
    } finally {
      await manager.close();
    }
  } finally {
    if (prevCodex === undefined) delete process.env.CODEX_REPLAY_EXECUTABLE;
    else process.env.CODEX_REPLAY_EXECUTABLE = prevCodex;
    if (prevAgy === undefined) delete process.env.AGY_EXECUTABLE;
    else process.env.AGY_EXECUTABLE = prevAgy;
    repo.cleanup();
  }
});

test('evolve agent CLI manages providers, persistent sessions, worktrees, and streaming delegate', () => {
  const repo = createGitRepo('orch-cli-');
  try {
    const stub = join(repo.root, 'cli-agent.mjs');
    writeFileSync(stub, [
      "import { readFileSync } from 'node:fs';",
      "const stdin = readFileSync(0, 'utf8');",
      "if (!process.argv.includes('resume')) {",
      "  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'cli-thread-1' }));",
      "  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'start:' + process.cwd() + ':' + stdin } }));",
      "} else {",
      "  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'follow:' + stdin } }));",
      "}",
      "console.log(JSON.stringify({ type: 'turn.completed' }));",
    ].join('\n'));

    const env = { ...process.env, CODEX_REPLAY_EXECUTABLE: stub };
    const runEvolve = (...args) => execFileSync(process.execPath, [workflowCli, '--root', repo.root, ...args], {
      cwd: repo.root, env, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const providers = JSON.parse(runEvolve('agent', 'providers'));
    assert.ok(providers.some(p => p.id === 'codex' && p.available === true));
    assert.ok(providers.some(p => p.id === 'claude'));

    const started = JSON.parse(runEvolve('agent', 'create', 'Hello worktree', '--id', 'cli-sess', '--to', 'codex', '--worktree', 'wt-cli'));
    assert.equal(started.session.id, 'cli-sess');
    assert.equal(started.session.externalSessionId, 'cli-thread-1');
    assert.match(started.turn.output, /^start:.*wt-cli:Hello worktree$/);

    const listed = JSON.parse(runEvolve('agent', 'list'));
    assert.equal(listed.length, 1);

    const sent = JSON.parse(runEvolve('agent', 'send', 'cli-sess', 'Next step'));
    assert.equal(sent.turn.output, 'follow:Next step');
    assert.equal(sent.session.turns.length, 2);

    const worktrees = JSON.parse(runEvolve('agent', 'worktree', 'list'));
    assert.equal(worktrees.length, 2);

    const closed = JSON.parse(runEvolve('agent', 'delete', 'cli-sess', '--remove-worktree'));
    assert.equal(closed.closed, true);
    assert.equal(closed.worktreeRemoved, true);
    assert.equal(JSON.parse(runEvolve('agent', 'worktree', 'list')).length, 1);

    const streamLines = runEvolve('agent', 'exec', 'Stream task', '--to', 'codex', '--stream')
      .split(/\r?\n/)
      .map(line => JSON.parse(line));
    assert.ok(streamLines.some(event => event.type === 'turn_started'));
    assert.ok(streamLines.some(event => event.type === 'turn_completed' && event.status === 'completed'));
  } finally {
    repo.cleanup();
  }
});
