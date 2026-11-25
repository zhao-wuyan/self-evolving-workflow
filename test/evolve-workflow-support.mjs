import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));
export const memory = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));

const canonicalTmp = realpathSync.native(tmpdir());
const templateCache = new Map();
let exitHookRegistered = false;

function registerTemplateCleanup() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', () => {
    for (const dir of templateCache.values()) {
      rmSync(dir, { recursive: true, force: true });
    }
    templateCache.clear();
  });
}

function makeFixtureApi(root) {
  const sentinel = join(root, 'maestro-invoked');
  const bin = join(root, 'bin');
  const home = join(root, '.fixture-home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  const trap = join(bin, process.platform === 'win32' ? 'maestro.cmd' : 'maestro');
  writeFileSync(trap, process.platform === 'win32'
    ? '@echo called>"' + sentinel + '"\r\n@exit /b 91\r\n'
    : '#!/bin/sh\nprintf called > "' + sentinel + '"\nexit 91\n', { mode: 0o755 });
  const env = { ...process.env, PATH: bin + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
    HOME: home, USERPROFILE: home,
    IMPECCABLE_HOME: process.env.IMPECCABLE_HOME || join(homedir(), '.impeccable'),
    MAESTRO_REPLAY_CLI: trap, MAESTRO_HOME: join(root, 'empty-maestro-home') };
  const run = (command, args, input) => execFileSync(command, args, {
    cwd: root, env, input, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const git = (...args) => run('git', args);
  const evolve = (...args) => JSON.parse(run(process.execPath, [cli, ...args]));
  const agent = (...args) => JSON.parse(run(process.execPath, [memory, ...args]));
  const write = (path, body) => {
    const filename = join(root, path);
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, body);
  };
  const open = (session, chain, objective = session) => evolve('session', 'create', objective, '--id', session, '--actor', 'test',
    ...(chain ? ['--chain', chain] : []));
  const status = session => evolve('session', 'get', '--session', session);
  const fence = (session, revision = status(session).revision, actor = 'test') =>
    ['--session', session, '--actor', actor, '--expected-orchestration-revision', String(revision)];
  const next = (session, revision, ...args) => evolve('run', 'create', ...fence(session, revision), ...args);
  const finish = (session, run, summary, additional = [], revision) => evolve('run', 'complete', run.run_id,
    ...fence(session, revision), '--expected-run-revision', String(run.revision), '--summary', summary, ...additional);
  const sealSession = session => evolve('session', 'complete', ...fence(session));
  const saveArtifact = (run, path, body) => {
    const slot = run.skill_ref.produces.find(item => item.path === 'outputs/' + path);
    assert.ok(slot, path);
    const { kind, schema, role, alias } = slot;
    const filename = join(run.run_dir, 'outputs', path);
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, JSON.stringify({ ...body, _meta: { kind, schema, role, alias } }) + '\n');
  };
  return { root, env, sentinel, run, git, evolve, agent, write, open, status, fence, next, finish, sealSession, saveArtifact,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function cachedTemplate(key, build) {
  let template = templateCache.get(key);
  if (!template) {
    registerTemplateCleanup();
    template = mkdtempSync(join(canonicalTmp, 'evolve-template-'));
    try {
      build(makeFixtureApi(template));
      rmSync(join(template, 'bin'), { recursive: true, force: true });
      rmSync(join(template, '.fixture-home'), { recursive: true, force: true });
    } catch (error) {
      rmSync(template, { recursive: true, force: true });
      throw error;
    }
    templateCache.set(key, template);
  }
  return template;
}

export function cloneTemplateFixture(prefix, template) {
  const root = mkdtempSync(join(canonicalTmp, prefix));
  try {
    cpSync(template, root, { recursive: true });
    return makeFixtureApi(root);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function fixture(prefix, extraSkills = []) {
  const names = ['ew-orchestrate', 'ew-odyssey', 'ew-swarm', ...extraSkills];
  const template = cachedTemplate('fixture:' + JSON.stringify(names), f => {
    assert.deepEqual(f.evolve('skill', 'install', ...names).installed, names);
    assert.deepEqual(f.evolve('skill', 'install', ...names).installed, []);
    f.git('init', '-q');
    f.git('config', 'core.autocrlf', 'false');
    f.git('config', 'user.name', 'Evolve fixture');
    f.git('config', 'user.email', 'evolve@example.invalid');
    f.write('.gitignore', '.evolve/\nbin/\n');
    f.git('add', '.');
    f.git('commit', '-qm', 'Commit shipped Evolve Skills');
  });
  return cloneTemplateFixture(prefix, template);
}
