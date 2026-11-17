import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { createInterface } from 'node:readline';

const [memoryCli, root, db, entry, commit, statePath, tracePath] = process.argv.slice(2);
const packageRoot = posix.dirname(entry);
const files = new Map();
const loaded = new Map();
for (const record of git('ls-tree', '-r', '-z', commit, '--', packageRoot).toString('utf8').split('\0')) {
  const match = /^100(?:644|755) blob ([a-f0-9]+)\t(.+)$/s.exec(record);
  if (match && /\.md$/i.test(match[2])) files.set(match[2], match[1]);
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

const toolDefinitions = [
  {
    name: 'read_skill',
    description: 'Read the bound Skill entry. Follow a declared Markdown link by supplying its destination and the path of the source document.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object', properties: { destination: { type: 'string' }, from: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    description: 'Search Agent Memory for guidance relevant to the current task.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
    },
  },
  {
    name: 'memory_get',
    description: 'Read one Agent Memory item returned by memory_search.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false,
    },
  },
];

function callMemory(...args) {
  const output = execFileSync(process.execPath, [memoryCli, '--root', root, '--db', db, '--reads', tracePath, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
  });
  return JSON.parse(output);
}

function readSkill({ from, destination }) {
  let path = entry;
  if (from !== undefined || destination !== undefined) {
    const source = loaded.get(from);
    if (!source || typeof destination !== 'string') {
      throw new Error('Supply the destination and a previously read source path');
    }
    const links = [...source.markdown.matchAll(/\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)/g)]
      .map(match => match[1].replace(/^<|>$/g, ''));
    const target = destination.split('#', 1)[0];
    if (!target || /[\\:]/.test(target) || posix.isAbsolute(target) || !links.includes(destination)) {
      throw new Error('Select a declared relative Markdown link from the source');
    }
    path = posix.join(posix.dirname(from), target);
  }
  const blob = files.get(path);
  if (!blob) throw new Error(`Skill document is unavailable in the bound package: ${path}`);
  const bytes = git('cat-file', 'blob', blob);
  const markdown = bytes.toString('utf8');
  loaded.set(path, { markdown, sha256: createHash('sha256').update(bytes).digest('hex') });
  writeFileSync(statePath, JSON.stringify([...loaded].map(([path, { sha256 }]) => ({ path, sha256 }))));
  return { path, markdown };
}

function getMemory(id) {
  const { searches } = JSON.parse(readFileSync(tracePath, 'utf8'));
  const search = searches.findLast(item => item.returned_ids.includes(id));
  if (!search) throw new Error('Select a memory ID returned by a search in this replay');
  return callMemory('memory', 'get', id, '--from-search', search.search_id);
}

async function handle(line) {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  try {
    let value;
    switch (request.method) {
      case 'initialize':
        value = { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'workflow-evolve-memory', version: '1.0.0' } };
        break;
      case 'ping': value = {}; break;
      case 'tools/list': value = { tools: toolDefinitions }; break;
      case 'tools/call': {
        const name = request.params?.name;
        const args = request.params?.arguments ?? {};
        if (name === 'read_skill') value = readSkill(args);
        else if (name === 'memory_search' && typeof args.query === 'string' && args.query.trim()) value = callMemory('memory', 'search', args.query);
        else if (name === 'memory_get' && typeof args.id === 'string' && args.id.trim()) value = getMemory(args.id);
        else throw new Error(`Unsupported memory tool call: ${name}`);
        break;
      }
      default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return;
    }
    const result = request.method === 'tools/call'
      ? { content: [{ type: 'text', text: JSON.stringify(value) }] }
      : value;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (request.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: { isError: true, content: [{ type: 'text', text: message }] } }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32000, message } }) + '\n');
    }
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) await handle(line.replace(/^\uFEFF/, ''));
