import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { InputError, requireText } from './common.js';
import { draftSkillAddition, learningDocument, learningIndex } from './skill-addition.js';
import { validateKnowledgeReads, type KnowledgeReadsReceipt } from './knowledge-reads.js';
import type { EvolutionTarget } from './openviking/types.js';
import { frozenKnowledgeHash } from './openviking/frozen.js';

interface Scenario {
  id: string;
  input: unknown;
  baseline: boolean;
  knowledgeReads?: { searchedSources?: string[]; loadedIds?: string[]; boundConstraints?: string[] };
}

export interface ReplayReceipt {
  mode?: 'addition' | 'package';
  base: string;
  candidate: string;
  entry: string;
  package_path?: string;
  files: string[];
  sources: string[];
  runnerSha256: string;
  scenarios: Array<{
    id: string;
    inputSha256: string;
    baseline: Observation;
    candidate: Observation;
  }>;
}

interface Observation {
  passed: boolean;
  loaded: Array<{ path: string; sha256: string }>;
  knowledgeReads?: KnowledgeReadsReceipt;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type GitOptions = { input?: string; env?: NodeJS.ProcessEnv };

function git(root: string, args: string[], options: GitOptions = {}) {
  return execFileSync('git', args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

function gitText(root: string, args: string[], options?: GitOptions) {
  return git(root, args, options).toString('utf8').trimEnd();
}

function repoPath(root: string, path: string): string {
  const name = relative(root, resolve(root, path)).replaceAll('\\', '/');
  if (!name || name.startsWith('../') || name === '..' || /[:\u0000-\u001f]/.test(name)) {
    throw new InputError(`Skill path is outside the project: ${path}`);
  }
  return name;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Expected a JSON object');
  return value as Record<string, unknown>;
}

function loadDraft(root: string, data: unknown) {
  const draft = record(data);
  const baseline = record(draft.baseline);
  if (draft.priority !== 'high' && draft.priority !== 'normal' && draft.priority !== 'low') {
    throw new InputError('Invalid Skill draft priority');
  }
  if (!Array.isArray(draft.sources)) throw new InputError('Skill draft is missing its evidence sources');
  const entry = realpathSync(resolve(root, requireText(baseline.path, 'Skill entry')));
  const entryPath = repoPath(root, entry);
  if (!entryPath.endsWith('/SKILL.md')) throw new InputError('Expected a project Skill package entry');
  const regenerated = draftSkillAddition({
    entry, priority: draft.priority, instruction: requireText(draft.instruction, 'Skill instruction'),
    sources: draft.sources.map(source => requireText(source, 'evidence reference')),
    when: draft.when === undefined ? undefined : requireText(draft.when, 'learning trigger'),
  });
  const sameChanges = JSON.stringify(regenerated.changes) === JSON.stringify(draft.changes);
  // 旧草稿可能只包含参考文档，回放时补齐入口与索引。
  const legacyLowChanges = regenerated.priority === 'low' && JSON.stringify(draft.changes) === JSON.stringify(
    regenerated.changes.filter(change => change.path === resolve(dirname(entry), learningDocument(regenerated.id))),
  );
  if (regenerated.id !== draft.id || regenerated.baseline.sha256 !== baseline.sha256 || (!sameChanges && !legacyLowChanges)) {
    throw new InputError('Skill draft or its baseline changed');
  }
  return { draft: regenerated, entryPath };
}

function packagePathForSkill(skillId: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(skillId)) throw new InputError('Invalid Skill ID for package design');
  return `skills/${skillId}`;
}

function markdownLinks(content: string): string[] {
  const links: string[] = [];
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, '').split(/\s+/, 1)[0];
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    links.push(target.split('#', 1)[0]);
  }
  return links.filter(Boolean);
}

function loadPackageDraft(root: string, data: unknown) {
  const draft = record(data);
  if (draft.mode !== 'package') throw new InputError('Expected a multi-file Skill package draft');
  const skillId = requireText(draft.skill_id, 'Skill package ID');
  const packagePath = packagePathForSkill(skillId);
  const entryPath = `${packagePath}/SKILL.md`;
  if (draft.package_path !== packagePath || draft.entry !== entryPath) {
    throw new InputError('Skill package target does not match its Skill ID');
  }
  if (!Array.isArray(draft.changes) || !draft.changes.length) {
    throw new InputError('Skill package draft requires at least one file');
  }
  const changes = draft.changes.map((value, index) => {
    const change = record(value);
    const path = repoPath(root, requireText(change.path, `Skill package file ${index}`));
    if (!path.startsWith(`${packagePath}/`)) throw new InputError(`Skill package file is outside the package: ${path}`);
    const content = change.content;
    if (typeof content !== 'string') throw new InputError(`Skill package file content is invalid: ${path}`);
    return { path, content };
  });
  if (new Set(changes.map(change => change.path)).size !== changes.length) {
    throw new InputError('Skill package draft contains duplicate files');
  }
  const entry = changes.find(change => change.path === entryPath);
  if (!entry) throw new InputError(`Skill package draft must include ${entryPath}`);
  const changed = new Map(changes.map(change => [change.path, change.content]));
  for (const link of markdownLinks(entry.content)) {
    const path = repoPath(root, resolve(root, dirname(entryPath), link));
    if (!path.startsWith(`${packagePath}/`)) throw new InputError(`Skill Markdown link leaves the package: ${link}`);
    if (!changed.has(path) && !existsSync(resolve(root, path))) {
      throw new InputError(`Skill Markdown link has no package document: ${link}`);
    }
  }
  return { draft, skillId, packagePath, entryPath, changes };
}

function loadScenarios(data: unknown): Scenario[] {
  if (!Array.isArray(data) || data.length < 2) throw new InputError('Provide a failure replay and a passing regression scenario');
  const ids = new Set<string>();
  const scenarios = data.map(value => {
    const scenario = record(value);
    const id = requireText(scenario.id, 'scenario ID');
    if (ids.has(id) || typeof scenario.baseline !== 'boolean' || !('input' in scenario)) {
      throw new InputError(`Invalid or duplicate replay scenario: ${id}`);
    }
    ids.add(id);
    let knowledgeReads: Scenario['knowledgeReads'];
    if (scenario.knowledge_reads !== undefined) {
      const expected = record(scenario.knowledge_reads);
      const sources = expected.searched_sources;
      const ids = expected.loaded_ids;
      const constraints = expected.bound_constraints;
      if ((sources !== undefined && (!Array.isArray(sources) || sources.some(item => typeof item !== 'string'))) ||
          (ids !== undefined && (!Array.isArray(ids) || ids.some(item => typeof item !== 'string'))) ||
          (constraints !== undefined && (!Array.isArray(constraints) || constraints.some(item => typeof item !== 'string')))) {
        throw new InputError(`Invalid knowledge read expectations: ${id}`);
      }
      knowledgeReads = {
        ...(sources === undefined ? {} : { searchedSources: [...new Set(sources as string[])] }),
        ...(ids === undefined ? {} : { loadedIds: [...new Set(ids as string[])] }),
        ...(constraints === undefined ? {} : { boundConstraints: [...new Set(constraints as string[])] }),
      };
    }
    return { id, input: scenario.input, baseline: scenario.baseline, knowledgeReads };
  });
  if (!scenarios.some(item => item.baseline) || !scenarios.some(item => !item.baseline)) {
    throw new InputError('Replay requires both a baseline failure and a baseline pass');
  }
  return scenarios;
}

function runScenario(
  worktree: string,
  commit: string,
  runner: string,
  entry: string,
  scenario: Scenario,
): Observation {
  const output = execFileSync(process.execPath, [runner], {
    cwd: worktree,
    windowsHide: true,
    input: JSON.stringify({ id: scenario.id, input: scenario.input, entry, commit }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  const proof = record(JSON.parse(output));
  if (typeof proof.passed !== 'boolean' || !Array.isArray(proof.loaded)) {
    throw new InputError(`Replay runner omitted its result or loaded files: ${scenario.id}`);
  }
  const packageRoot = dirname(entry).replaceAll('\\', '/') + '/';
  const loaded = proof.loaded.map(value => {
    const item = record(value);
    const path = repoPath(worktree, requireText(item.path, 'loaded file'));
    if (!path.startsWith(packageRoot)) throw new InputError(`Replay loaded a file outside the selected Skill: ${path}`);
    const expected = sha256(git(worktree, ['show', `${commit}:${path}`]));
    if (expected !== item.sha256) throw new InputError(`Replay loaded different Skill bytes: ${path}`);
    return { path, sha256: expected };
  });
  if (!loaded.some(item => item.path === entry)) throw new InputError(`Replay did not load the selected Skill: ${entry}`);
  const knowledgeReads = proof.knowledge_reads === undefined ? undefined : validateKnowledgeReads(proof.knowledge_reads);
  return { passed: proof.passed, loaded, ...(knowledgeReads ? { knowledgeReads } : {}) };
}

function runPackageScenario(
  worktree: string,
  commit: string,
  runner: string,
  entry: string,
  packagePath: string,
  scenario: Scenario,
  requireEntry: boolean,
): Observation {
  const output = execFileSync(process.execPath, [runner], {
    cwd: worktree,
    windowsHide: true,
    input: JSON.stringify({ id: scenario.id, input: scenario.input, entry, package_path: packagePath, commit, mode: 'package' }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  const proof = record(JSON.parse(output));
  if (typeof proof.passed !== 'boolean' || !Array.isArray(proof.loaded)) {
    throw new InputError(`Replay runner omitted its result or loaded files: ${scenario.id}`);
  }
  const loaded = proof.loaded.map(value => {
    const item = record(value);
    const path = repoPath(worktree, requireText(item.path, 'loaded file'));
    if (!path.startsWith(`${packagePath}/`)) throw new InputError(`Replay loaded a file outside the selected Skill: ${path}`);
    const expected = sha256(git(worktree, ['show', `${commit}:${path}`]));
    if (expected !== item.sha256) throw new InputError(`Replay loaded different Skill bytes: ${path}`);
    return { path, sha256: expected };
  });
  if (requireEntry && !loaded.some(item => item.path === entry)) {
    throw new InputError(`Replay did not load the selected Skill: ${entry}`);
  }
  const knowledgeReads = proof.knowledge_reads === undefined ? undefined : validateKnowledgeReads(proof.knowledge_reads);
  return { passed: proof.passed, loaded, ...(knowledgeReads ? { knowledgeReads } : {}) };
}

function assertKnowledgeReads(observation: Observation, expected: Scenario['knowledgeReads'], scenario: string): void {
  if (!expected) return;
  const receipt = observation.knowledgeReads;
  if (!receipt) throw new InputError(`Replay omitted knowledge reads: ${scenario}`);
  if (expected.searchedSources?.some(source => !receipt.searches.some(search => search.source === source))) {
    throw new InputError(`Replay omitted expected knowledge search: ${scenario}`);
  }
  if (expected.loadedIds?.some(id => !receipt.reads.some(read => read.id === id))) {
    throw new InputError(`Replay omitted expected knowledge read: ${scenario}`);
  }
  if (expected.boundConstraints?.some(id => !receipt.constraints_bound.some(constraint => constraint.knowledge_id === id))) {
    throw new InputError(`Replay omitted expected bound constraint: ${scenario}`);
  }
  for (const read of receipt.reads) {
    if (!read.from_search_id || read.from_search_id === 'priors') continue;
    const search = receipt.searches.find(item => item.search_id === read.from_search_id);
    if (!search || !search.returned_ids.includes(read.id)) {
      throw new InputError(`Replay knowledge read is not backed by its search result: ${scenario}`);
    }
  }
}

function repoRoot(root: string) {
  return realpathSync(gitText(root, ['rev-parse', '--show-toplevel']));
}

function receiptPath(root: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new InputError('Expected an exact Skill replay receipt ID');
  return join(gitText(root, ['rev-parse', '--absolute-git-dir']), 'evolve-replay', id + '.json');
}

export function replaySkillAddition(root: string, data: unknown, options: { runner: string; scenarios: unknown }) {
  root = repoRoot(root);
  const { draft, entryPath } = loadDraft(root, data);
  const runner = realpathSync(options.runner);
  const runnerSha256 = sha256(readFileSync(runner));
  const scenarios = loadScenarios(options.scenarios);
  const base = gitText(root, ['rev-parse', 'HEAD']);
  const normalizeText = (value: string) => value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const baseline = git(root, ['show', `${base}:${entryPath}`]).toString('utf8');
  if (normalizeText(baseline) !== normalizeText(readFileSync(draft.baseline.path, 'utf8'))) {
    throw new InputError('Commit the Skill baseline before replay');
  }
  const packagePath = dirname(entryPath).replaceAll('\\', '/');
  if (gitText(root, ['status', '--porcelain', '--untracked-files=all', '--', packagePath])) {
    throw new InputError('Commit the Skill package before replay');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'evolve-replay-'));
  const index = join(scratch, 'index');
  const gitIndex = { env: { ...process.env, GIT_INDEX_FILE: index } };
  const oldTree = join(scratch, 'baseline');
  const newTree = join(scratch, 'candidate');
  let oldAdded = false;
  let newAdded = false;
  let failure: unknown;
  try {
    git(root, ['read-tree', base], gitIndex);
    const files = draft.changes.map(change => {
      const path = repoPath(root, change.path);
      const blob = gitText(root, ['hash-object', '-w', '--stdin'], { input: change.content.replace(/\r\n/g, '\n') });
      git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], gitIndex);
      return path;
    });
    const tree = gitText(root, ['write-tree'], gitIndex);
    const candidate = gitText(root, ['commit-tree', tree, '-p', base, '-m', 'chore: 生成 Skill 回放候选']);
    if (!gitText(root, ['diff', '--name-only', base, candidate])) throw new InputError('Skill draft has no changes');
    git(root, ['worktree', 'add', '--detach', oldTree, base]);
    oldAdded = true;
    git(root, ['worktree', 'add', '--detach', newTree, candidate]);
    newAdded = true;
    const expectedReads = draft.priority === 'high' ? [entryPath] : [`${packagePath}/${learningDocument(draft.id)}`];
    if (draft.priority === 'low') expectedReads.push(`${packagePath}/${learningIndex}`);
    const observations = scenarios.map(scenario => {
      const baseline = runScenario(oldTree, base, runner, entryPath, scenario);
      const proposed = runScenario(newTree, candidate, runner, entryPath, scenario);
      if (baseline.passed !== scenario.baseline || !proposed.passed ||
          (!scenario.baseline && !expectedReads.every(path => proposed.loaded.some(item => item.path === path)))) {
        throw new InputError(`Skill replay failed: ${scenario.id}`);
      }
      assertKnowledgeReads(proposed, scenario.knowledgeReads, scenario.id);
      return { id: scenario.id, inputSha256: sha256(JSON.stringify(scenario.input)), baseline, candidate: proposed };
    });
    if (sha256(readFileSync(runner)) !== runnerSha256) throw new InputError('Replay runner changed during validation');
    const receipt: ReplayReceipt = { base, candidate, entry: entryPath, files, sources: draft.sources, runnerSha256, scenarios: observations };
    const content = JSON.stringify(receipt);
    const id = sha256(content);
    const path = receiptPath(root, id);
    mkdirSync(dirname(path), { recursive: true });
    git(root, ['update-ref', 'refs/evolve/replays/' + id, candidate]);
    if (!existsSync(path)) writeFileSync(path, content, { flag: 'wx' });
    else if (readFileSync(path, 'utf8') !== content) throw new InputError('Skill replay receipt differs');
    return { id, ...receipt };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanup = [
      ...(newAdded ? [() => git(root, ['worktree', 'remove', '--force', newTree])] : []),
      ...(oldAdded ? [() => git(root, ['worktree', 'remove', '--force', oldTree])] : []),
      () => rmSync(index, { force: true }),
      () => rmdirSync(scratch),
    ];
    const errors: string[] = [];
    for (const remove of cleanup) {
      try { remove(); } catch (error) { errors.push(String(error)); }
    }
    if (errors.length) {
      throw new Error([...(failure ? [String(failure)] : []), ...errors].join('\n'), { cause: failure });
    }
  }
}

export function replaySkillPackage(root: string, data: unknown, options: { runner: string; scenarios: unknown }) {
  root = repoRoot(root);
  const { draft, packagePath, entryPath, changes } = loadPackageDraft(root, data);
  const runner = realpathSync(options.runner);
  const runnerSha256 = sha256(readFileSync(runner));
  const scenarios = loadScenarios(options.scenarios);
  const base = gitText(root, ['rev-parse', 'HEAD']);
  if (gitText(root, ['status', '--porcelain', '--untracked-files=all', '--', packagePath])) {
    throw new InputError('Commit the Skill package before replay');
  }
  let entryExists = true;
  try { git(root, ['cat-file', '-e', `${base}:${entryPath}`]); } catch { entryExists = false; }
  const scratch = mkdtempSync(join(tmpdir(), 'evolve-replay-'));
  const index = join(scratch, 'index');
  const gitIndex = { env: { ...process.env, GIT_INDEX_FILE: index } };
  const oldTree = join(scratch, 'baseline');
  const newTree = join(scratch, 'candidate');
  let oldAdded = false;
  let newAdded = false;
  let failure: unknown;
  try {
    git(root, ['read-tree', base], gitIndex);
    for (const change of changes) {
      const blob = gitText(root, ['hash-object', '-w', '--stdin'], { input: change.content.replace(/\r\n/g, '\n') });
      git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${change.path}`], gitIndex);
    }
    const tree = gitText(root, ['write-tree'], gitIndex);
    const candidate = gitText(root, ['commit-tree', tree, '-p', base, '-m', 'chore: 生成 Skill 包回放候选']);
    if (!gitText(root, ['diff', '--name-only', base, candidate])) throw new InputError('Skill package draft has no changes');
    git(root, ['worktree', 'add', '--detach', oldTree, base]);
    oldAdded = true;
    git(root, ['worktree', 'add', '--detach', newTree, candidate]);
    newAdded = true;
    const observations = scenarios.map(scenario => {
      const baseline = runPackageScenario(oldTree, base, runner, entryPath, packagePath, scenario, entryExists);
      const proposed = runPackageScenario(newTree, candidate, runner, entryPath, packagePath, scenario, true);
      if (baseline.passed !== scenario.baseline || !proposed.passed) throw new InputError(`Skill package replay failed: ${scenario.id}`);
      assertKnowledgeReads(proposed, scenario.knowledgeReads, scenario.id);
      return { id: scenario.id, inputSha256: sha256(JSON.stringify(scenario.input)), baseline, candidate: proposed };
    });
    if (sha256(readFileSync(runner)) !== runnerSha256) throw new InputError('Replay runner changed during validation');
    const receipt: ReplayReceipt = {
      mode: 'package', base, candidate, entry: entryPath, package_path: packagePath,
      files: changes.map(change => change.path), sources: Array.isArray(draft.sources) ? draft.sources.map(source => requireText(source, 'evidence reference')) : [],
      runnerSha256, scenarios: observations,
    };
    const content = JSON.stringify(receipt);
    const id = sha256(content);
    const path = receiptPath(root, id);
    mkdirSync(dirname(path), { recursive: true });
    git(root, ['update-ref', 'refs/evolve/replays/' + id, candidate]);
    if (!existsSync(path)) writeFileSync(path, content, { flag: 'wx' });
    else if (readFileSync(path, 'utf8') !== content) throw new InputError('Skill replay receipt differs');
    return { id, ...receipt };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanup = [
      ...(newAdded ? [() => git(root, ['worktree', 'remove', '--force', newTree])] : []),
      ...(oldAdded ? [() => git(root, ['worktree', 'remove', '--force', oldTree])] : []),
      () => rmSync(index, { force: true }),
      () => rmdirSync(scratch),
    ];
    const errors: string[] = [];
    for (const remove of cleanup) {
      try { remove(); } catch (error) { errors.push(String(error)); }
    }
    if (errors.length) throw new Error([...(failure ? [String(failure)] : []), ...errors].join('\n'), { cause: failure });
  }
}

export function readSkillReplayReceipt(root: string, id: string): ReplayReceipt & { id: string } {
  root = repoRoot(root);
  const content = readFileSync(receiptPath(root, id), 'utf8');
  if (sha256(content) !== id) throw new InputError('Skill replay receipt changed');
  const receipt = JSON.parse(content) as ReplayReceipt;
  if (gitText(root, ['rev-parse', '--verify', 'refs/evolve/replays/' + id]) !== receipt.candidate) {
    throw new InputError('Skill candidate no longer matches its replay receipt');
  }
  const changedFiles = gitText(root, ['diff', '--name-only', receipt.base, receipt.candidate]).split(/\r?\n/).filter(Boolean);
  if (!changedFiles.length || changedFiles.some(path => !receipt.files.includes(path)) ||
      gitText(root, ['rev-list', '--parents', '-n', '1', receipt.candidate]) !== `${receipt.candidate} ${receipt.base}`) {
    throw new InputError('Skill candidate has unexpected changes or parent');
  }
  return { id, ...receipt };
}

export function changeSkillVersion(root: string, id: string, rollback = false) {
  root = repoRoot(root);
  const receipt = readSkillReplayReceipt(root, id);
  const head = gitText(root, ['rev-parse', 'HEAD']);
  if (!rollback && head === receipt.candidate) return { id, commit: head, replayed: true };
  if (rollback && gitText(root, ['rev-list', '--parents', '-n', '1', head]) === `${head} ${receipt.candidate}` &&
      gitText(root, ['rev-parse', `${head}^{tree}`]) === gitText(root, ['rev-parse', `${receipt.base}^{tree}`])) {
    return { id, commit: head, replayed: true };
  }
  if (head !== (rollback ? receipt.candidate : receipt.base)) throw new InputError('Project version changed since Skill replay');
  const packagePath = receipt.package_path ?? dirname(receipt.entry).replaceAll('\\', '/');
  if (gitText(root, ['status', '--porcelain', '--untracked-files=all', '--', packagePath])) {
    throw new InputError('Skill package has local changes');
  }
  if (gitText(root, ['diff', '--cached', '--name-only'])) throw new InputError('The Git index contains staged changes');
  if (rollback) git(root, ['revert', '--no-edit', receipt.candidate]);
  else git(root, ['merge', '--ff-only', receipt.candidate]);
  return { id, commit: gitText(root, ['rev-parse', 'HEAD']), replayed: false };
}

export function verifySkillCommit(root: string, commit: string, targets: readonly EvolutionTarget[], knowledgeSnapshot: string) {
  root = repoRoot(root);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new InputError('Invalid candidate commit');
  const knowledge_sha256 = frozenKnowledgeHash(knowledgeSnapshot);
  const expected = readFileSync(join(knowledgeSnapshot, 'sha256'), 'utf8');
  if (knowledge_sha256 !== expected) throw new InputError('OPENVIKING_FROZEN_KNOWLEDGE_CHANGED');
  const scratch = mkdtempSync(join(tmpdir(), 'evolve-verify-commit-'));
  const worktree = join(scratch, 'candidate');
  const previousSnapshot = process.env.EVOLVE_KNOWLEDGE_SNAPSHOT;
  const previousDb = process.env.AGENT_MEMORY_DB;
  let added = false;
  try {
    process.env.EVOLVE_KNOWLEDGE_SNAPSHOT = knowledgeSnapshot;
    process.env.AGENT_MEMORY_DB = join(knowledgeSnapshot, 'memory.db');
    git(root, ['worktree', 'add', '--detach', worktree, commit]); added = true;
    const results = targets.map(target => {
      const runner = realpathSync(join(root, target.runner));
      const scenarioPath = join(root, target.scenarios);
      const runner_sha256 = sha256(readFileSync(runner));
      const scenarioBytes = readFileSync(scenarioPath);
      const scenarios = loadScenarios(JSON.parse(scenarioBytes.toString('utf8')));
      const observations = scenarios.map(scenario => {
        const observed = runPackageScenario(worktree, commit, runner, target.entry, dirname(target.entry).replaceAll('\\', '/'), scenario, true);
        if (!observed.passed) throw new InputError('Merged Skill validation failed: ' + scenario.id);
        assertKnowledgeReads(observed, scenario.knowledgeReads, scenario.id);
        return { id: scenario.id, input_sha256: sha256(JSON.stringify(scenario.input)), ...observed };
      });
      if (sha256(readFileSync(runner)) !== runner_sha256 || !readFileSync(scenarioPath).equals(scenarioBytes)) throw new InputError('Validation inputs changed');
      return { entry: target.entry, runner_sha256, scenarios_sha256: sha256(scenarioBytes), observations };
    });
    if (frozenKnowledgeHash(knowledgeSnapshot) !== knowledge_sha256) throw new InputError('OPENVIKING_FROZEN_KNOWLEDGE_CHANGED');
    const proof = { commit, knowledge_sha256, targets: results };
    const content = JSON.stringify(proof);
    const id = sha256(content);
    const path = join(gitText(root, ['rev-parse', '--absolute-git-dir']), 'evolve-validations', id + '.json');
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) { if (readFileSync(path, 'utf8') !== content) throw new InputError('Validation receipt changed'); }
    else writeFileSync(path, content, { flag: 'wx' });
    git(root, ['update-ref', 'refs/evolve/validations/' + id, commit]);
    return { id, ...proof };
  } finally {
    if (previousSnapshot === undefined) delete process.env.EVOLVE_KNOWLEDGE_SNAPSHOT; else process.env.EVOLVE_KNOWLEDGE_SNAPSHOT = previousSnapshot;
    if (previousDb === undefined) delete process.env.AGENT_MEMORY_DB; else process.env.AGENT_MEMORY_DB = previousDb;
    if (added) git(root, ['worktree', 'remove', '--force', worktree]);
    rmSync(scratch, { recursive: true, force: true });
  }
}
