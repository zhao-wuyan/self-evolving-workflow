import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { parentPort } from 'node:worker_threads';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = new Map();
const directories = new Set(['viking://user/fixture/resources']);
const state = { unavailable: false, queueError: false, dropPointer: false, corrupt: {}, missing: [], model: 'empty', calls: [] };
parentPort.on('message', ({ id, update, inspect }) => {
  if (update) {
    for (const [uri, body] of Object.entries(update.files ?? {})) files.set(uri, Buffer.from(body, 'base64'));
    const { files: _files, ...settings } = update;
    Object.assign(state, settings);
  }
  parentPort.postMessage({ id, value: inspect ? { ...state, files: Object.fromEntries([...files].map(([uri, bytes]) => [uri, bytes.toString('base64')])) } : true });
});
const fields = keys => Object.fromEntries(keys.map(key => [key, {}]));
const operation = { properties: fields(['uri', 'mode', 'content_base64', 'if_absent', 'expected_sha256']) };
const schema = { components: { schemas: {} }, paths: { '/api/v1/content/batch-write': { post: { requestBody: { content: { 'application/json': {
  schema: { properties: { ...fields(['root_uri', 'wait', 'skip_conflicts', 'defer_processing']), operations: { type: 'array', items: operation } } },
} } } } } } };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  const ok = result => send(200, { status: 'ok', result });
  const error = (status, code) => send(status, { status: 'error', error: { code, message: 'private-server-response-do-not-print', details: { task_id: 'fixture-task' } } });
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  state.calls.push({ path: url.pathname, input, uri: url.searchParams.get('uri'), headers: {
    account: request.headers['x-openviking-account'], user: request.headers['x-openviking-user'], authorization: request.headers.authorization,
  } });
  if (url.pathname === '/chat/completions') {
    if (state.model === 'error') return send(503, { error: 'model unavailable' });
    const source = input.messages[1].content.match(/evolve:[A-Za-z0-9_-]+#run-[A-Za-z0-9_-]+/)?.[0];
    if (input.messages[0].content.startsWith('Suggest data-only replay inputs')) {
      const content = JSON.stringify([{ source, input: { build: '00999', migrationApproved: false } }]);
      return send(200, { choices: [{ message: { content } }] });
    }
    const content = ['signal', 'generated'].includes(state.model) ? JSON.stringify([{ scene_name: 'workflow', memories: [
      { type: 'workflow_issue', content: 'Deployment must check the migration gate before applying.', source_message_ids: [source] },
    ] }]) : '[]';
    return send(200, { choices: [{ message: { content } }] });
  }
  if (request.headers['x-api-key'] !== 'fixture-key') return error(401, 'UNAUTHENTICATED');
  if (state.unavailable) return error(503, 'SERVICE_UNAVAILABLE');
  if (url.pathname === '/health') return send(200, { status: 'ok', version: 'v0.5.5', account_id: 'fixture-account', user_id: 'fixture' });
  if (url.pathname === '/openapi.json') return send(200, schema);
  const uri = url.searchParams.get('uri');
  if (url.pathname === '/api/v1/fs/stat') return directories.has(uri) ? ok({ isDir: true }) : files.has(uri) ? ok({ isDir: false }) : error(404, 'NOT_FOUND');
  if (url.pathname === '/api/v1/fs/mkdir') {
    if (directories.has(input.uri)) return error(409, 'ALREADY_EXISTS');
    directories.add(input.uri); return ok({ uri: input.uri });
  }
  if (url.pathname === '/api/v1/content/download') {
    if (!files.has(uri) || state.missing.includes(uri)) return error(404, 'NOT_FOUND');
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end(state.corrupt[uri] ? Buffer.from(state.corrupt[uri], 'base64') : files.get(uri)); return;
  }
  if (url.pathname === '/api/v1/content/batch-write') {
    if (!directories.has(input.root_uri)) return error(404, 'NOT_FOUND');
    const result = { root_uri: input.root_uri, created: [], updated: [], unchanged: [],
      semantic_status: input.defer_processing ? 'deferred' : 'complete', vector_status: input.defer_processing ? 'deferred' : 'complete', queue_status: null };
    for (const op of [...input.operations].sort((a, b) => a.uri.localeCompare(b.uri))) {
      const previous = files.get(op.uri);
      if (op.if_absent && previous || op.expected_sha256 && (!previous || hash(previous) !== op.expected_sha256)) return error(409, 'CONFLICT');
      files.set(op.uri, Buffer.from(op.content_base64, 'base64'));
      result[previous ? 'updated' : 'created'].push(op.uri);
    }
    if (state.dropPointer && input.operations.some(op => op.uri.endsWith('/current.json'))) {
      state.dropPointer = false; request.socket.destroy(); return;
    }
    if (!input.defer_processing && state.queueError) {
      result.queue_status = { Semantic: { error_count: 1 } }; result.semantic_status = 'failed';
    }
    return ok(result);
  }
  if (url.pathname === '/api/v1/search/find') {
    const leaves = [...files.keys()].filter(uri => uri.startsWith(input.target_uri + '/') && /\.md$/.test(uri));
    return ok({ resources: [
      { uri: input.target_uri + '/.abstract.md', score: 999, abstract: 'Incorrect value 123; never the original 00123' },
      { uri: input.target_uri, score: 998 },
      { uri: 'viking://user/fixture/resources/another-project/memory.md', score: 997 },
      ...leaves.slice(0, input.limit).map((uri, index) => ({ uri, score: 1 - index / 10000 })),
    ] });
  }
  return error(404, 'NOT_FOUND');
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ url: `http://127.0.0.1:${server.address().port}` }));
