import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  AGENT_MEMORY_PROMPT_VERSION,
  MemoryStore,
  buildCloseoutHarvestPrompt,
  buildSessionSignalPrompt,
  buildWikiMergePrompt,
  buildWikiRelationPrompt,
} from 'self-evolving-workflow';
import { harvestCompletion } from '../dist/closeout.js';
import { Wiki } from '../dist/wiki.js';
import { applyWikiChange, proposeWikiChange } from '../dist/wiki-change.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));

test('Agent Memory operation prompts share one evidence and output contract', () => {
  const prompts = [
    buildSessionSignalPrompt(),
    buildCloseoutHarvestPrompt(),
    buildWikiRelationPrompt(),
    buildWikiMergePrompt('wiki-merge', 'Merge the supplied pages.'),
    buildWikiMergePrompt('wiki-append', 'Return only the missing fragment.'),
  ];
  assert.ok(prompts.every(prompt => prompt.version === AGENT_MEMORY_PROMPT_VERSION));
  assert.ok(prompts.every(prompt => prompt.system.includes(`Agent Memory system contract (${AGENT_MEMORY_PROMPT_VERSION})`)));
  assert.ok(prompts.every(prompt => prompt.system.includes('untrusted evidence')));
  assert.ok(prompts.every(prompt => prompt.system.includes('empty result is valid')));
  assert.equal(new Set(prompts.map(prompt => prompt.label)).size, prompts.length);
  assert.match(buildSessionSignalPrompt().system, /Allowed types are correction, error, retry, aborted, verified_fix and workflow_issue/);
  assert.match(buildCloseoutHarvestPrompt().system, /type":"work_method/);
  assert.match(buildWikiRelationPrompt().system, /conflict\|overlap/);
});

test('Memory extraction uses the versioned Agent Memory contract by default', async () => {
  const store = new MemoryStore(':memory:');
  let request;
  try {
    await store.extract([{
      id: 'message-1', role: 'user', timestamp: '2026-11-14T00:00:00Z', content: 'Remember that dry-run is required.',
    }], {
      session: 'session-1',
      llm: {
        async chat(params) {
          request = params;
          return '[{"memories":[]}]';
        },
      },
    });
  } finally {
    store.close();
  }
  assert.ok(request);
  assert.equal(request.label, 'memory-extract');
  assert.match(request.system, new RegExp(`Agent Memory system contract \\(${AGENT_MEMORY_PROMPT_VERSION}\\)`));
  assert.match(request.system, /Return and only return|Return only|JSON/);
});

test('extraction tolerates reasoning tags, prose brackets, wrapper objects, and retries malformed output once', async () => {
  const store = new MemoryStore(':memory:');
  const prompts = [];
  try {
    const messages = [
      { id: 'agy:s1:1', role: 'user', timestamp: '2026-11-17T00:00:00Z', content: 'Use dry-run before deploy.' },
    ];
    let calls = 0;
    const records = await store.extract(messages, {
      session: 's1',
      llm: {
        async chat(params) {
          prompts.push(params.prompt);
          calls++;
          if (calls === 1) return 'I cannot output JSON yet.';
          return [
            'reasoning without open tag</think>',
            'Step [1] cites [agy:s1:1] and [unclosed bracket.',
            '```json',
            JSON.stringify({ memories: [{ type: 'work_method', content: 'Always run dry-run before deploy.', source_message_ids: ['agy:s1:1'] }] }),
            '```',
            'Trailing note [done].',
          ].join('\n');
        },
      },
    });
    assert.equal(calls, 2);
    assert.match(prompts[1], /\[Format correction\]/);
    assert.equal(records.length, 1);
    assert.equal(records[0].content, 'Always run dry-run before deploy.');
    assert.deepEqual(records[0].sourceMessageIds, ['agy:s1:1']);
  } finally {
    store.close();
  }
});

test('closeout harvest avoids L1 scene prompt pollution and tolerates flat memory arrays and fenced comparisons', async t => {
  const root = await mkdtemp(join(tmpdir(), 'evolve-harvest-robust-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = new Wiki(root);
  const existing = proposeWikiChange(wiki, {
    operation: 'create',
    entry: 'entries/deploy-check',
    title: 'Deploy check',
    mode: 'reference',
    body: 'Always run preflight before deploy.',
  }, ['seed:1']);
  applyWikiChange(wiki, existing.id);

  const seen = [];
  let compareCalls = 0;
  const harvested = await harvestCompletion(wiki, 'proj', {
    schema_version: 'skill-completion/1.0',
    id: 'comp-robust-1',
    execution_id: 'exec-1',
    status: 'succeeded',
    recorded_at: '2026-11-17T00:00:00Z',
    messages: [{ id: 'm1', role: 'user', timestamp: '2026-11-17T00:00:00Z', content: 'Run preflight --strict before deploy.' }],
  }, () => ({
    async chat({ label, prompt }) {
      seen.push({ label, prompt });
      if (label === 'closeout-harvest') {
        assert.doesNotMatch(prompt, /【上一个情境】|scene_name/);
        return '<think>Check [m1]</think>\n[{"type":"work_method","content":"Run preflight --strict before deploy.","source_message_ids":["m1"]}]';
      }
      compareCalls++;
      if (compareCalls === 1) return 'The entry overlaps.';
      return 'Overlap note [1]:\n```json\n{"relations":[{"id":"entries/deploy-check","relation":"overlap"}]}\n```\n[end]';
    },
  }));

  assert.equal(compareCalls, 2);
  assert.equal(harvested.candidates.length, 1);
  assert.equal(harvested.candidates[0].related_entries?.[0]?.id, 'entries/deploy-check');
  assert.equal(harvested.candidates[0].related_entries?.[0]?.relation, 'overlap');
});

test('CLI model client reports truncated or reasoning-only empty content clearly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'evolve-llm-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const messagesFile = join(root, 'messages.json');
  await writeFile(messagesFile, JSON.stringify([
    { id: 'm1', role: 'user', timestamp: 0, content: 'Remember dry-run.' },
  ]));

  let mode = 'length';
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'length') {
      res.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: null, reasoning_content: 'thinking...' } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const env = {
    ...process.env,
    AGENT_MEMORY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    AGENT_MEMORY_LLM_MODEL: 'deepseek-r1:14b',
  };
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, '--root', root, 'kb', 'extract', messagesFile, '--session', 's1'], { env }),
    err => /finish_reason=length/.test(err.stderr),
  );
  mode = 'reasoning';
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, '--root', root, 'kb', 'extract', messagesFile, '--session', 's1'], { env }),
    err => /only reasoning output/.test(err.stderr),
  );
});
