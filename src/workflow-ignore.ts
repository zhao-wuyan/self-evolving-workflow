import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ignore from 'ignore';
import { InputError } from './common.js';
import { gitText } from './openviking/git.js';

const directories = ['.evolve/', '.agent-memory/', '.codegraph/'];
const projectConfiguration = ['.evolve/openviking.json', '.evolve/evolution.json'];
const evolveRuntimeExamples = [
  '.evolve/workflow.db',
  '.evolve/install-manifest.json',
  '.evolve/runs/example/report.md',
  '.evolve/ovcli.conf',
];

export type IgnoreAction = 'check' | 'apply';

export interface EvolveIgnoreResult {
  schema_version: 'evolve-ignore/1.0';
  action: IgnoreAction;
  root: string;
  gitignore_path: string;
  status: 'up_to_date' | 'missing' | 'applied';
  missing: string[];
  applied: string[];
  tracked: string[];
}

export const ignoreHelp = [
  'Usage: evolve ignore [check|apply] [--root <project>]',
  '',
  '  check   Inspect missing Evolve runtime rules in repo root .gitignore without writing',
  '  apply   Append missing Evolve runtime rules to repo root .gitignore (default)',
].join('\n');

export function manageEvolveIgnore(cwd: string, action: IgnoreAction = 'apply'): EvolveIgnoreResult {
  const root = gitText(cwd, ['rev-parse', '--show-toplevel']);
  const path = join(root, '.gitignore');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new InputError('仓库根 .gitignore 不是普通文件，未修改。');
  const current = stat ? readFileSync(path, 'utf8') : '';
  const matcher = ignore({ ignorecase: false }).add(current);
  const missing = directories.slice(1).filter(dir => !matcher.ignores(dir)).map(dir => `/${dir}`);
  if (!matcher.test('.evolve/').unignored || projectConfiguration.some(file => !matcher.test(file).unignored) ||
      evolveRuntimeExamples.some(file => !matcher.ignores(file))) {
    missing.unshift('!/.evolve/', '/.evolve/*', ...projectConfiguration.map(file => `!/${file}`));
  }
  const indexed = gitText(root, ['ls-files', '-z', '--', ...directories]).split('\0');
  const tracked = directories.filter(dir => indexed.some(file => file.startsWith(dir) && !projectConfiguration.includes(file)));
  const applied = missing.length && action === 'apply' ? [...missing] : [];
  if (applied.length) {
    const eol = current.match(/\r?\n/)?.[0] ?? '\n';
    const separator = current ? (current.endsWith('\n') ? eol : eol + eol) : '';
    appendFileSync(path, `${separator}# Evolve 本地运行产物${eol}${applied.join(eol)}${eol}`);
  }
  return {
    schema_version: 'evolve-ignore/1.0',
    action,
    root,
    gitignore_path: path,
    status: !missing.length ? 'up_to_date' : applied.length ? 'applied' : 'missing',
    missing,
    applied,
    tracked,
  };
}
