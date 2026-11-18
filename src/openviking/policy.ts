import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { InputError } from '../common.js';
import { workflowHead, workflowPath } from '../workflow-skills.js';
import { sha256, stableJson } from './assets.js';
import { readPolicy, readProject, validateEvolutionPolicy } from './config.js';
import { applyAssetCommit, assertCleanIndex, createAssetCommit, gitText } from './git.js';
import { fileRecord } from './knowledge.js';
import type { EvolutionTarget } from './types.js';

const profilePath = '.evolve/openviking.json';
export const defaultEvolutionPolicyPath = '.evolve/evolution.json';

export function requireCommittedPolicyFiles(root: string, paths: string[]) {
  for (const candidate of new Set(paths)) {
    const path = workflowPath(candidate);
    if (!lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile()) {
      throw new InputError('OPENVIKING_POLICY_FILE_REQUIRED: ' + path);
    }
    try {
      if (gitText(root, ['cat-file', '-t', `HEAD:${path}`]) !== 'blob') throw new InputError('Not a Git blob');
    } catch (cause) {
      throw new InputError('OPENVIKING_POLICY_NOT_COMMITTED: ' + path, { cause });
    }
    if (gitText(root, ['status', '--porcelain', '--', `:(literal)${path}`])) {
      throw new InputError('OPENVIKING_POLICY_NOT_COMMITTED: ' + path);
    }
  }
}

export function manageEvolutionPolicy(root: string, target?: EvolutionTarget, apply?: string) {
  const project = readProject(root);
  if (!project) throw new InputError('OPENVIKING_PROJECT_REQUIRED: run openviking init first');
  const path = project.evolution_policy ?? defaultEvolutionPolicyPath;
  if (!target) {
    const targets = project.evolution_policy ? readPolicy(root, path).targets : [];
    return { mode: targets.length ? 'evolution' : 'sync', path: project.evolution_policy, targets };
  }
  const exists = lstatSync(join(root, path), { throwIfNoEntry: false });
  const current = project.evolution_policy || exists ? readPolicy(root, path) : undefined;

  const base = workflowHead(root);
  const entry = workflowPath(target.entry);
  const previous = current?.targets.find(item => item.entry === entry);
  const policy = validateEvolutionPolicy(root, {
    schema_version: 'evolve-openviking-policy/1.0',
    targets: [...(current?.targets.filter(item => item.entry !== entry) ?? []), target].sort((a, b) => a.entry.localeCompare(b.entry, 'en')),
  });
  const files = [profilePath, ...policy.targets.flatMap(item => [item.entry, item.runner, item.scenarios])];
  if (current) files.push(path);
  else if (gitText(root, ['status', '--porcelain', '--', `:(literal)${path}`])) {
    throw new InputError('OPENVIKING_POLICY_NOT_COMMITTED: ' + path);
  }
  requireCommittedPolicyFiles(root, files);
  const next = policy.targets.find(item => item.entry === entry)!;
  const preview = { path, base, previous: previous ?? null, target: next, files: project.evolution_policy ? [path] : [path, profilePath] };
  const preview_id = sha256(stableJson({ root, ...preview, policy }));
  if (apply !== undefined && apply !== preview_id) throw new InputError('OPENVIKING_POLICY_PREVIEW_STALE: preview the update again');
  if (project.evolution_policy && previous?.runner === next.runner && previous.scenarios === next.scenarios) {
    return { ...preview, preview_id, status: 'unchanged' };
  }
  if (apply === undefined) return { ...preview, preview_id, status: 'preview' };

  assertCleanIndex(root);
  const bytes = new Map([[path, Buffer.from(JSON.stringify(policy, null, 2) + '\n')]]);
  if (!project.evolution_policy) bytes.set(profilePath, Buffer.from(JSON.stringify({ ...project, evolution_policy: path }, null, 2) + '\n'));
  const commit = createAssetCommit(root, base, [...bytes].map(([file, data]) => fileRecord(file, data)), bytes, [], 'chore: 更新 OpenViking 演进策略');
  applyAssetCommit(root, base, commit);
  return { ...preview, preview_id, status: 'applied', commit };
}
