import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { InputError, requireText } from '../common.js';
import { isRepositoryId } from '../wiki-entry.js';
import { isProjectSkillEntry, workflowPath, workflowRecord } from '../workflow-skills.js';
import type { EvolutionPolicy, OpenVikingProject } from './types.js';

export function connectionConfig(): { url: string; api_key: string } {
  const override = process.env.EVOLVE_OPENVIKING_CONFIG;
  if (override && !isAbsolute(override)) throw new InputError('OPENVIKING_CONFIG_PATH must be absolute');
  const path = override ?? join(homedir(), '.openviking', 'ovcli.conf');
  let input: Record<string, unknown>;
  try { input = workflowRecord(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')), 'OpenViking connection'); }
  catch { throw new InputError('OPENVIKING_CONFIG_INVALID: configure ~/.openviking/ovcli.conf or EVOLVE_OPENVIKING_CONFIG'); }
  let url: URL;
  try { url = new URL(requireText(input.url, 'OpenViking URL')); }
  catch { throw new InputError('OPENVIKING_CONFIG_INVALID: invalid HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new InputError('OPENVIKING_CONFIG_INVALID: use an HTTP(S) URL without credentials, query or fragment');
  }
  if (typeof input.api_key !== 'string' || !input.api_key.trim()) throw new InputError('OPENVIKING_CONFIG_INVALID: missing API key');
  return { url: url.href.replace(/\/$/, ''), api_key: input.api_key };
}

export function projectFile(root: string) { return join(root, '.evolve', 'openviking.json'); }
export function privateProjectUri(user: string, project: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(user) || !isRepositoryId(project)) throw new InputError('OPENVIKING_IDENTITY_INVALID');
  return `viking://user/${user}/resources/evolve/projects/${project}`;
}
export function validateProject(value: unknown): OpenVikingProject {
  const item = workflowRecord(value, 'OpenViking project');
  if (item.schema_version !== 'evolve-openviking-project/1.0' || !isRepositoryId(item.project_id)) {
    throw new InputError('OPENVIKING_PROJECT_INVALID');
  }
  const account_id = requireText(item.account_id, 'OpenViking account');
  const user_id = requireText(item.user_id, 'OpenViking user');
  if (item.root_uri !== privateProjectUri(user_id, item.project_id)) throw new InputError('OPENVIKING_PROJECT_ROOT_INVALID');
  if (item.enabled !== undefined && typeof item.enabled !== 'boolean' ||
      item.failure_policy !== undefined && item.failure_policy !== 'local' && item.failure_policy !== 'fail') {
    throw new InputError('OPENVIKING_BACKEND_CONFIG_INVALID');
  }
  return { schema_version: item.schema_version, project_id: item.project_id, account_id, user_id,
    root_uri: item.root_uri,
    ...(item.evolution_policy === undefined ? {} : { evolution_policy: workflowPath(requireText(item.evolution_policy, 'evolution policy')) }),
    enabled: item.enabled !== false, failure_policy: item.failure_policy === 'fail' ? 'fail' : 'local' };
}
export function readProject(root: string): OpenVikingProject | undefined {
  const path = projectFile(root);
  if (!existsSync(path)) return;
  if (!lstatSync(path).isFile()) throw new InputError('OPENVIKING_PROJECT_INVALID');
  return validateProject(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')));
}
export function readPolicy(root: string, path: string): EvolutionPolicy {
  const file = join(root, workflowPath(path));
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new InputError('OPENVIKING_POLICY_MISSING: ' + path);
  return validateEvolutionPolicy(root, JSON.parse(readFileSync(file, 'utf8')));
}
export function validateEvolutionPolicy(root: string, input: unknown): EvolutionPolicy {
  const value = workflowRecord(input, 'evolution policy');
  if (value.schema_version !== 'evolve-openviking-policy/1.0' || !Array.isArray(value.targets)) {
    throw new InputError('OPENVIKING_POLICY_INVALID');
  }
  const targets = value.targets.map(input => {
    const item = workflowRecord(input, 'evolution target');
    const entry = workflowPath(requireText(item.entry, 'target entry'));
    if (!isProjectSkillEntry(entry)) {
      throw new InputError('OPENVIKING_POLICY_ENTRY_INVALID');
    }
    const runner = workflowPath(requireText(item.runner, 'business runner'));
    const scenarios = workflowPath(requireText(item.scenarios, 'scenarios'));
    if (!lstatSync(join(root, runner)).isFile()) throw new InputError('OPENVIKING_POLICY_RUNNER_INVALID');
    const cases: unknown = JSON.parse(readFileSync(join(root, scenarios), 'utf8'));
    if (!Array.isArray(cases) ||
        cases.some(item => !item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.baseline !== 'boolean' || !('input' in item)) ||
        !cases.some(item => item.baseline === true) || !cases.some(item => item.baseline === false) ||
        new Set(cases.map(item => item.id)).size !== cases.length) throw new InputError('OPENVIKING_POLICY_SCENARIOS_INVALID');
    return { entry, runner, scenarios };
  });
  if (new Set(targets.map(item => item.entry)).size !== targets.length) throw new InputError('OPENVIKING_POLICY_DUPLICATE_TARGET');
  return { schema_version: value.schema_version, targets };
}

export function replaceJson(path: string, previous: Buffer | undefined, content: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(content, null, 2) + '\n', { flag: 'wx' });
    const current = existsSync(path) ? readFileSync(path) : undefined;
    if (Boolean(current) !== Boolean(previous) || (current && previous && !current.equals(previous))) {
      throw new InputError('OPENVIKING_LOCAL_CHANGED');
    }
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
