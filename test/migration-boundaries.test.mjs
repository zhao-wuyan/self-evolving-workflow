import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../dist/workflow-cli.js', import.meta.url));

function fixture(t) {
  const temp = realpathSync(tmpdir());
  const root = mkdtempSync(join(temp, 'evolve-prune-boundary-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(project);
  mkdirSync(home);
  t.after(() => {
    const target = resolve(root);
    assert.equal(dirname(target), temp);
    assert.ok(basename(target).startsWith('evolve-prune-boundary-'));
    rmSync(target, { recursive: true, force: true });
  });
  const run = (...args) => spawnSync(process.execPath, [cli, 'skill', 'install', 'ew-knowledge',
    '--root', project, ...args], {
    cwd: project, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex') },
  });
  const manifest = (skillsDir, records) => {
    mkdirSync(join(project, '.evolve'), { recursive: true });
    writeFileSync(join(project, '.evolve', 'install-manifest.json'), JSON.stringify({
      schema_version: 'evolve-install-manifest/1.0',
      targets: { [resolve(skillsDir)]: { skills: records } },
    }));
  };
  return { root, project, run, manifest };
}

test('prune rejects manifest traversal before deleting any candidate, including with force', async t => {
  const cases = ['../keep-me', '..\\keep-me', '', '.', '..', 'C:\\keep-me', 'zz/../../keep-me', 'absolute'];
  for (const candidate of cases) {
    await t.test(JSON.stringify(candidate), st => {
      const { project, run, manifest } = fixture(st);
      const skills = join(project, 'skills');
      const keep = join(project, 'keep-me');
      mkdirSync(join(skills, 'aaa-retired'), { recursive: true });
      mkdirSync(keep);
      writeFileSync(join(keep, 'valuable.txt'), 'keep this evidence');
      const name = candidate === 'absolute' ? resolve(keep) : candidate;
      manifest(skills, {
        'aaa-retired': { version: '0', sha256: 'old' },
        [name]: { version: '0', sha256: 'old' },
      });
      const result = run('--prune', '--force', '--yes');
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr + result.stdout, /Invalid Skill name|Prune target must be inside/);
      assert.equal(readFileSync(join(keep, 'valuable.txt'), 'utf8'), 'keep this evidence');
      assert.ok(existsSync(join(skills, 'aaa-retired')));
    });
  }
});

test('prune refuses host parent junctions before touching the redirected installation', t => {
  const { root, project, run, manifest } = fixture(t);
  const outside = join(root, 'outside');
  const retired = join(outside, 'skills', 'team-swarm');
  mkdirSync(retired, { recursive: true });
  writeFileSync(join(retired, 'valuable.txt'), 'outside installation');
  symlinkSync(outside, join(project, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
  manifest(join(project, '.codex', 'skills'), {});
  const result = run('--host', 'codex', '--prune', '--force', '--yes');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr + result.stdout, /regular installation directories/);
  assert.equal(readFileSync(join(retired, 'valuable.txt'), 'utf8'), 'outside installation');
  assert.equal(existsSync(join(outside, 'skills', 'ew-knowledge')), false);
});

test('prune removes retired tracked packages and keeps shipped, custom and linked directories', t => {
  const { root, project, run, manifest } = fixture(t);
  const installed = run();
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const skills = join(project, 'skills');
  for (const name of ['old-skill', 'team-swarm', 'personal-skill']) {
    mkdirSync(join(skills, name));
    writeFileSync(join(skills, name, 'SKILL.md'), '# ' + name);
  }
  const external = join(root, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'valuable.txt'), 'linked evidence');
  symlinkSync(external, join(skills, 'linked-skill'), process.platform === 'win32' ? 'junction' : 'dir');
  manifest(skills, Object.fromEntries(['ew-knowledge', 'old-skill', 'team-swarm', 'linked-skill']
    .map(name => [name, { version: '0', sha256: 'old' }])));
  const result = run('--prune', '--yes');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).pruned, ['old-skill', 'team-swarm']);
  assert.equal(existsSync(join(skills, 'old-skill')), false);
  assert.equal(existsSync(join(skills, 'team-swarm')), false);
  assert.ok(existsSync(join(skills, 'personal-skill', 'SKILL.md')));
  assert.ok(existsSync(join(skills, 'ew-knowledge', 'SKILL.md')));
  assert.ok(lstatSync(join(skills, 'linked-skill')).isSymbolicLink());
  assert.equal(readFileSync(join(external, 'valuable.txt'), 'utf8'), 'linked evidence');
});
