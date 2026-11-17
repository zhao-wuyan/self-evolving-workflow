import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { InputError } from './common.js';
import { workflowName } from './workflow-names.js';

const bundle = fileURLToPath(new URL('../', import.meta.url));
const source = join(bundle, 'skills');
const hosts = {
  codex: { path: ['.codex'], instructions: ['.codex', 'AGENTS.md'] },
  claude: { path: ['.claude'], instructions: ['.claude', 'CLAUDE.md'] },
  agy: { path: ['.gemini', 'config'], instructions: ['.gemini', 'AGENTS.md'] },
  omp: { path: ['.omp', 'agent'], instructions: ['.omp', 'agent', 'AGENTS.md'] },
} as const;
const workflowTitle = 'Self-Evolving Workflow';

type InstallScope = 'project' | 'user';
type InstallHost = keyof typeof hosts;

interface InstallOptions {
  scope?: InstallScope;
  host?: InstallHost;
  skill?: string[];
  yes?: boolean;
}

interface WorkflowDocument {
  id: string;
  path: string;
}

export function workflowDocuments(): WorkflowDocument[] {
  const documents: WorkflowDocument[] = JSON.parse(readFileSync(join(bundle, 'workflows', 'index.json'), 'utf8'));
  const skills = shippedSkills();
  return documents.filter(item => skills.includes(item.path.split('/')[1]));
}

export function workflowDocument(id: string) {
  const name = id === 'odyssey' || id === 'skill-design' ? 'ew-' + id : workflowName(id);
  const document = workflowDocuments().find(item => item.id === name);
  if (!document) throw new InputError('Unknown workflow: ' + id);
  return readFileSync(join(bundle, document.path), 'utf8');
}

function shippedSkills() {
  return readdirSync(source, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort();
}

function selectSkills(shipped: string[], requested: string[]) {
  const selected = requested.length ? [...new Set(requested.map(workflowName))] : shipped;
  if (selected.some(name => !shipped.includes(name))) throw new InputError('Choose a shipped Skill package');
  if (selected.includes('ew-odyssey') && !selected.includes('ew-orchestrate')) {
    return ['ew-orchestrate', ...selected];
  }
  return selected;
}

export function installSkills(root: string, requested: string[]) {
  const skills = selectSkills(shippedSkills(), requested);
  const target = join(root, 'skills');
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new InputError('Use a regular skills directory');
  mkdirSync(target, { recursive: true });
  const pending = skills.filter(name => {
    const path = join(target, name);
    if (!lstatSync(path, { throwIfNoEntry: false })) return true;
    if (!existsSync(join(path, 'SKILL.md'))) throw new InputError('Existing directory has no SKILL.md: ' + path);
    return false;
  });
  const installed: string[] = [];
  for (const name of pending) {
    const path = join(target, name);
    const stage = mkdtempSync(join(target, '.evolve-install-'));
    try {
      cpSync(join(source, name), join(stage, name), { recursive: true, force: false, errorOnExist: true });
      renameSync(join(stage, name), path);
      installed.push(name);
    } finally {
      if (dirname(stage) === target) rmSync(stage, { recursive: true, force: true });
    }
  }
  return { skills, installed };
}

function provisionInstructions(path: string) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && !info.isFile()) throw new InputError('Use a regular instruction file: ' + path);
  const current = info ? readFileSync(path, 'utf8') : '';
  if (/^# (?:Evolve Workflow|Self-Evolving Workflow)\s*$/m.test(current)) return;
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const guide = [
    '# ' + workflowTitle,
    '',
    'Use Evolve for Session and Run control. Run `evolve context "<task keywords>" --include-memory` before inspecting project files.',
    'Follow the project instructions for knowledge scope. Open controlling entries by ID and record Run knowledge reads.',
    'Read the relevant package in `skills/` for a project installation and commit those packages so Evolve can bind Runs to a Git revision.',
    'Use `evolve workflows` to list the bundled workflow documents and `evolve workflows show <id>` to read one.',
    'Use `evolve knowledge import` to preview legacy Spec and Knowhow in the source project. Add `--apply` to import them.',
    '',
  ].join(newline);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, current ? current + newline + newline + guide : guide, 'utf8');
}

function scopeAndHost(root: string, scope: InstallScope, host?: InstallHost) {
  if (host && scope === 'project') throw new InputError('--host applies to user installations');
  if (scope === 'project') return { target: root, instructions: join(root, 'AGENTS.md') };
  const config = hosts[host ?? 'codex'];
  return {
    target: join(homedir(), ...config.path),
    instructions: join(homedir(), ...config.instructions),
  };
}

export async function installWorkflow(root: string, options: InstallOptions) {
  const shipped = shippedSkills();
  let scope = options.scope ?? (options.host ? 'user' : 'project');
  let host = options.host;
  let requested = options.skill ?? [];
  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new InputError('Use an interactive terminal or pass --yes');
    }
    const ui = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(workflowTitle + ' installer\n\n');
      if (!options.scope && !host) {
        const answer = (await ui.question('Install to [1] project or [2] user profile [1]? ')).trim();
        if (answer && answer !== '1' && answer !== '2') throw new InputError('Choose project (1) or user (2)');
        scope = answer === '2' ? 'user' : 'project';
      }
      if (scope === 'user' && !host) {
        const answer = (await ui.question('Host [1] Codex, [2] Claude, [3] Agy or [4] OMP [1]? ')).trim();
        if (answer && answer !== '1' && answer !== '2' && answer !== '3' && answer !== '4') throw new InputError('Choose Codex (1), Claude (2), Agy (3) or OMP (4)');
        host = answer === '2' ? 'claude' : answer === '3' ? 'agy' : answer === '4' ? 'omp' : 'codex';
      }
      const { target } = scopeAndHost(root, scope, host);
      if (!requested.length) {
        process.stdout.write(shipped.map((name, index) =>
          `  ${index + 1}. ${name}${existsSync(join(target, 'skills', name)) ? ' (present)' : ''}`).join('\n') + '\n');
        const answer = (await ui.question('Skill numbers, comma separated [all]? ')).trim();
        if (answer && answer.toLowerCase() !== 'all') {
          const positions = answer.split(',').map(value => value.trim());
          if (positions.some(value => !/^\d+$/.test(value) || !shipped[Number(value) - 1])) {
            throw new InputError('Choose Skill numbers from the list');
          }
          requested = positions.map(value => shipped[Number(value) - 1]);
        }
      }
      const selected = selectSkills(shipped, requested);
      const answer = (await ui.question(`Install ${selected.join(', ')} in ${target}? [y/N] `)).trim();
      if (!/^y(?:es)?$/i.test(answer)) return { status: 'cancelled' };
    } finally {
      ui.close();
    }
  }
  const { target, instructions } = scopeAndHost(root, scope, host);
  const skills = installSkills(target, requested);
  provisionInstructions(instructions);
  return {
    status: 'installed', scope, ...(scope === 'user' ? { host: host ?? 'codex' } : {}), root: target, instructions,
    ...skills, kept: skills.skills.filter(name => !skills.installed.includes(name)),
    workflows: workflowDocuments().filter(item => skills.skills.includes(item.path.split('/')[1])),
  };
}
