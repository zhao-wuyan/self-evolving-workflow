import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';

function parseCliArgs(argv) {
  let configPath = process.env.EVOLVE_REPLAY_CONFIG;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') {
      configPath = argv[++i];
      continue;
    }
    rest.push(argv[i]);
  }
  if (!configPath) throw new Error('Supply --config <path> or EVOLVE_REPLAY_CONFIG');
  const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  return { config, rest };
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function loadSkillFiles(root, commit, entry) {
  const packageRoot = posix.dirname(entry);
  const files = new Map();
  for (const record of git(root, 'ls-tree', '-r', '-z', commit, '--', packageRoot).toString('utf8').split('\0')) {
    const match = /^100(?:644|755) blob ([a-f0-9]+)\t(.+)$/s.exec(record);
    if (match && /\.md$/i.test(match[2])) files.set(match[2], match[1]);
  }
  return files;
}

function readLoadedState(statePath) {
  if (!existsSync(statePath)) return [];
  const parsed = JSON.parse(readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
  return Array.isArray(parsed) ? parsed : [];
}

function callMemory(config, ...args) {
  const output = execFileSync(
    process.execPath,
    [config.memoryCli, '--root', config.root, '--db', config.db, '--scope', 'project', '--reads', config.tracePath, ...args],
    { cwd: config.root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(output);
}

function readSkill(config, args) {
  const files = loadSkillFiles(config.root, config.commit, config.entry);
  const loaded = readLoadedState(config.statePath);
  let from;
  let destination;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from') {
      from = args[++i];
      continue;
    }
    if (args[i] === '--destination') {
      destination = args[++i];
      continue;
    }
    positional.push(args[i]);
  }
  if (destination === undefined && positional.length > 0) destination = positional[0];

  let path = config.entry;
  if (from !== undefined || destination !== undefined) {
    if (!from || !loaded.some(item => item.path === from) || typeof destination !== 'string') {
      throw new Error('Supply the destination and a previously read source path');
    }
    const sourceBlob = files.get(from);
    if (!sourceBlob) throw new Error(`Skill document is unavailable in the bound package: ${from}`);
    const sourceMarkdown = git(config.root, 'cat-file', 'blob', sourceBlob).toString('utf8');
    const links = [...sourceMarkdown.matchAll(/\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)/g)]
      .map(match => match[1].replace(/^<|>$/g, ''));
    const target = destination.split('#', 1)[0];
    if (!target || /[\\:]/.test(target) || posix.isAbsolute(target) || !links.includes(destination)) {
      throw new Error('Select a declared relative Markdown link from the source');
    }
    path = posix.join(posix.dirname(from), target);
  }

  const blob = files.get(path);
  if (!blob) throw new Error(`Skill document is unavailable in the bound package: ${path}`);
  const bytes = git(config.root, 'cat-file', 'blob', blob);
  const markdown = bytes.toString('utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const nextLoaded = [...loaded.filter(item => item.path !== path), { path, sha256 }];
  writeFileSync(config.statePath, JSON.stringify(nextLoaded));
  return { path, markdown };
}

function getMemory(config, id) {
  if (!id || !id.trim()) throw new Error('Supply a memory ID');
  const trace = existsSync(config.tracePath)
    ? JSON.parse(readFileSync(config.tracePath, 'utf8').replace(/^\uFEFF/, ''))
    : { searches: [] };
  const search = (trace.searches ?? []).findLast(item => Array.isArray(item.returned_ids) && item.returned_ids.includes(id));
  if (!search) throw new Error('Select a memory ID returned by a search in this replay');
  return callMemory(config, 'kb', 'get', id, '--from-search', search.search_id);
}

const { config, rest } = parseCliArgs(process.argv.slice(2));
const [action, ...args] = rest;
let result;
switch (action) {
  case 'skill-read':
    result = readSkill(config, args);
    break;
  case 'memory-search': {
    const query = args.join(' ').trim();
    if (!query) throw new Error('Supply a search query');
    result = callMemory(config, 'kb', 'search', query, '--kind', 'episodic');
    break;
  }
  case 'memory-get':
    result = getMemory(config, args[0]);
    break;
  default:
    throw new Error(`Unsupported replay CLI command: ${action ?? ''}`);
}

process.stdout.write(JSON.stringify(result) + '\n');
