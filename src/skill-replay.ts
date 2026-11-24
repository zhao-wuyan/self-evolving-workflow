import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { InputError, requireText } from './common.js';
import {
  draftSkillAddition, draftSkillRetirement, learningDocument, learningIndex,
  type SkillAddition, type SkillRetirement,
} from './skill-addition.js';
import { validateKnowledgeReads, type KnowledgeReadsReceipt } from './knowledge-reads.js';
import type { EvolutionTarget } from './openviking/types.js';
import { frozenKnowledgeHash } from './openviking/frozen.js';
import { projectSkillRoots } from './workflow-skills.js';

interface Scenario {
  id: string;
  input: unknown;
  baseline: boolean;
  /** pass^k 采样次数：全部样本通过才算通过。 */
  samples: number;
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

interface Sample {
  passed: boolean;
  feedback?: string;
  knowledgeReads?: KnowledgeReadsReceipt;
}

interface Observation extends Sample {
  loaded: Array<{ path: string; sha256: string }>;
  samples?: Sample[];
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type GitOptions = { input?: string; env?: NodeJS.ProcessEnv };
const maxSamples = 10;

function git(root: string, args: string[], options: GitOptions = {}) {
  return execFileSync('git', args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

function gitText(root: string, args: string[], options?: GitOptions) {
  return git(root, args, options).toString('utf8').trimEnd();
}

function gitSucceeds(root: string, args: string[]) {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
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

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new InputError(`Skill draft is missing its ${field}`);
  return value.map(item => requireText(item, field));
}

function loadDraft(root: string, data: unknown) {
  const draft = record(data);
  const baseline = record(draft.baseline);
  const retire = draft.operation === 'retire';
  if (!retire && draft.priority !== 'high' && draft.priority !== 'normal' && draft.priority !== 'low') {
    throw new InputError('Invalid Skill draft priority');
  }
  const sources = stringList(draft.sources, 'evidence sources');
  const entry = realpathSync(resolve(root, requireText(baseline.path, 'Skill entry')));
  const entryPath = repoPath(root, entry);
  if (!entryPath.endsWith('/SKILL.md')) throw new InputError('Expected a project Skill package entry');
  let regenerated: SkillAddition | SkillRetirement;
  let legacyLowChanges = false;
  if (retire) {
    regenerated = draftSkillRetirement({
      entry, retire: stringList(draft.retire, 'retired learning IDs'), sources,
      reason: draft.reason === undefined ? undefined : requireText(draft.reason, 'retirement reason'),
    });
  } else {
    const addition = draftSkillAddition({
      entry, priority: draft.priority as SkillAddition['priority'],
      instruction: requireText(draft.instruction, 'Skill instruction'), sources,
      when: draft.when === undefined ? undefined : requireText(draft.when, 'learning trigger'),
      supersedes: draft.supersedes === undefined ? undefined : stringList(draft.supersedes, 'superseded learning IDs'),
    });
    // 旧草稿可能只包含参考文档，回放时补齐入口与索引。
    legacyLowChanges = addition.priority === 'low' && JSON.stringify(draft.changes) === JSON.stringify(
      addition.changes.filter(change => change.path === resolve(dirname(entry), learningDocument(addition.id))),
    );
    regenerated = addition;
  }
  const sameChanges = JSON.stringify(regenerated.changes) === JSON.stringify(draft.changes);
  if (regenerated.id !== draft.id || regenerated.baseline.sha256 !== baseline.sha256 || (!sameChanges && !legacyLowChanges)) {
    throw new InputError('Skill draft or its baseline changed');
  }
  return { draft: regenerated, entryPath };
}

function packagePathForSkill(root: string, skillId: string, requested?: unknown): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(skillId)) throw new InputError('Invalid Skill ID for package design');
  if (typeof requested === 'string' && projectSkillRoots.some(skillRoot =>
    requested === `${skillRoot}/${skillId}` || requested === `${skillRoot}/ew-orchestrate/steps/${skillId}`)) {
    return requested;
  }
  for (const skillRoot of projectSkillRoots) {
    for (const candidate of [`${skillRoot}/${skillId}`, `${skillRoot}/ew-orchestrate/steps/${skillId}`]) {
      if (existsSync(resolve(root, candidate, 'SKILL.md'))) return candidate;
    }
  }
  const existingRoot = projectSkillRoots.find(skillRoot => existsSync(resolve(root, skillRoot)));
  return `${existingRoot ?? 'skills'}/${skillId}`;
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
  const packagePath = packagePathForSkill(root, skillId, draft.package_path);
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
    // content 为 null 表示从包内删除该文件。
    if (typeof content !== 'string' && content !== null) throw new InputError(`Skill package file content is invalid: ${path}`);
    return { path, content };
  });
  if (new Set(changes.map(change => change.path)).size !== changes.length) {
    throw new InputError('Skill package draft contains duplicate files');
  }
  const entry = changes.find(change => change.path === entryPath);
  if (!entry || entry.content === null) throw new InputError(`Skill package draft must include ${entryPath}`);
  const changed = new Map(changes.map(change => [change.path, change.content]));
  for (const link of markdownLinks(entry.content)) {
    const path = repoPath(root, resolve(root, dirname(entryPath), link));
    if (!path.startsWith(`${packagePath}/`)) throw new InputError(`Skill Markdown link leaves the package: ${link}`);
    if (changed.get(path) === null) throw new InputError(`Skill Markdown link targets a deleted document: ${link}`);
    if (!changed.has(path) && !existsSync(resolve(root, path))) {
      throw new InputError(`Skill Markdown link has no package document: ${link}`);
    }
  }
  return { draft, skillId, packagePath, entryPath, changes };
}

function sampleCount(value: unknown, id: string) {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maxSamples) {
    throw new InputError(`Replay samples must be an integer from 1 to ${maxSamples}: ${id}`);
  }
  return value as number;
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
    return { id, input: scenario.input, baseline: scenario.baseline, samples: sampleCount(scenario.samples, id), knowledgeReads };
  });
  if (!scenarios.some(item => item.baseline) || !scenarios.some(item => !item.baseline)) {
    throw new InputError('Replay requires both a baseline failure and a baseline pass');
  }
  return scenarios;
}

function runnerTimeout() {
  const value = Number(process.env.EVOLVE_REPLAY_TIMEOUT_MS ?? 120_000);
  if (!Number.isInteger(value) || value < 1) throw new InputError('EVOLVE_REPLAY_TIMEOUT_MS must be a positive integer');
  return value;
}

/** 执行一次 runner，并校验其加载的 Skill 字节与候选提交一致。 */
function runOnce(
  worktree: string,
  commit: string,
  runner: string,
  payload: Record<string, unknown>,
  packagePath: string,
  entry: string,
  requireEntry: boolean,
): Observation {
  const output = execFileSync(process.execPath, [runner], {
    cwd: worktree,
    windowsHide: true,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: runnerTimeout(),
  });
  const proof = record(JSON.parse(output));
  if (typeof proof.passed !== 'boolean' || !Array.isArray(proof.loaded)) {
    throw new InputError(`Replay runner omitted its result or loaded files: ${String(payload.id)}`);
  }
  const loaded = proof.loaded.map(value => {
    const item = record(value);
    const path = repoPath(worktree, requireText(item.path, 'loaded file'));
    if (!path.startsWith(`${packagePath}/`)) throw new InputError(`Replay loaded a file outside the selected Skill: ${path}`);
    const blobBytes = git(worktree, ['show', `${commit}:${path}`]);
    const expected = sha256(blobBytes);
    if (expected !== item.sha256) {
      // 兼容 Windows core.autocrlf=true 检出工作树产生的 CRLF 与 Git LF blob 的字节差异。
      const worktreeFile = join(worktree, path);
      const diskBytes = existsSync(worktreeFile) ? readFileSync(worktreeFile) : undefined;
      const normalize = (buf: Buffer) => buf.toString('utf8').replace(/\r\n/g, '\n');
      if (!diskBytes || sha256(diskBytes) !== item.sha256 || normalize(diskBytes) !== normalize(blobBytes)) {
        throw new InputError(`Replay loaded different Skill bytes: ${path}`);
      }
    }
    return { path, sha256: expected };
  });
  if (requireEntry && !loaded.some(item => item.path === entry)) {
    throw new InputError(`Replay did not load the selected Skill: ${entry}`);
  }
  const knowledgeReads = proof.knowledge_reads === undefined ? undefined : validateKnowledgeReads(proof.knowledge_reads);
  const feedback = typeof proof.feedback === 'string' && proof.feedback.trim() ? proof.feedback.trim().slice(0, 1000) : undefined;
  return { passed: proof.passed, loaded, ...(feedback ? { feedback } : {}), ...(knowledgeReads ? { knowledgeReads } : {}) };
}

/** 按 scenario.samples 重复执行；pass^k 要求全部样本通过。 */
function observe(scenario: Scenario, once: () => Observation): Observation {
  const runs = Array.from({ length: scenario.samples }, once);
  if (runs.length === 1) return runs[0];
  const loaded = new Map(runs.flatMap(run => run.loaded).map(item => [item.path, item]));
  const first = runs[0];
  return {
    passed: runs.every(run => run.passed), loaded: [...loaded.values()],
    ...(first.knowledgeReads ? { knowledgeReads: first.knowledgeReads } : {}),
    samples: runs.map(({ passed, feedback, knowledgeReads }) => ({
      passed, ...(feedback ? { feedback } : {}), ...(knowledgeReads ? { knowledgeReads } : {}),
    })),
  };
}

function failureFeedback(observation: Observation) {
  const failed = observation.samples?.find(sample => !sample.passed);
  const rate = observation.samples ? ` (${observation.samples.filter(sample => sample.passed).length}/${observation.samples.length} samples passed)` : '';
  const feedback = failed?.feedback ?? observation.feedback;
  return rate + (feedback ? `: ${feedback}` : '');
}

/** 生成可回灌给提案者的具体失败原因。 */
function replayFailure(label: string, scenario: Scenario, baseline: Observation, candidate: Observation, missing: string[] = []) {
  const reasons: string[] = [];
  if (baseline.passed !== scenario.baseline) {
    reasons.push(`baseline expected ${scenario.baseline ? 'pass' : 'failure'} but observed ${baseline.passed ? 'pass' : 'failure'}${failureFeedback(baseline)}`);
  }
  if (!candidate.passed) reasons.push(`candidate failed${failureFeedback(candidate)}`);
  if (missing.length) reasons.push(`candidate did not load ${missing.join(', ')}`);
  return new InputError(`${label}: ${scenario.id} (${reasons.join('; ')})`);
}

function assertKnowledgeReads(observation: Observation, expected: Scenario['knowledgeReads'], scenario: string): void {
  if (!expected) return;
  for (const sample of observation.samples ?? [observation]) {
    const receipt = sample.knowledgeReads;
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
}

function repoRoot(root: string) {
  return realpathSync(gitText(root, ['rev-parse', '--show-toplevel']));
}

function receiptPath(root: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new InputError('Expected an exact Skill replay receipt ID');
  return join(gitText(root, ['rev-parse', '--absolute-git-dir']), 'evolve-replay', id + '.json');
}

const frontmatterPattern = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/;
const versionPattern = /^(version:[ \t]*["']?)(\d+)\.(\d+)\.(\d+)(["']?[ \t]*)(?=\r?$)/m;

function frontmatterVersion(content: string) {
  const header = frontmatterPattern.exec(content);
  const match = header ? versionPattern.exec(header[2]) : null;
  return match ? `${match[2]}.${match[3]}.${match[4]}` : undefined;
}

/** 递增 SKILL.md frontmatter 中的语义化版本；无版本字段时原样返回。 */
function bumpVersion(content: string, level: 'patch' | 'minor') {
  const header = frontmatterPattern.exec(content);
  if (!header || !versionPattern.test(header[2])) return content;
  const body = header[2].replace(versionPattern, (_match, prefix: string, major: string, minor: string, patch: string, suffix: string) =>
    `${prefix}${level === 'minor' ? `${major}.${Number(minor) + 1}.0` : `${major}.${minor}.${Number(patch) + 1}`}${suffix}`);
  return header[1] + body + header[3] + content.slice(header[0].length);
}

function candidateMessage(entryPath: string, operation: string, draftId: string, sources: string[]) {
  const skill = dirname(entryPath).split('/').at(-1);
  return [
    `chore: 演进 Skill ${skill} (${operation})`, '',
    `Evolve-Draft: ${draftId}`, `Evolve-Operation: ${operation}`,
    ...sources.slice(0, 20).map(source => `Evolve-Evidence: ${source.replace(/[\r\n]+/g, ' ')}`),
  ].join('\n') + '\n';
}

/** 在临时索引中基于 base 写入变更（null 为删除），生成带 Evolve trailer 的候选提交。 */
function writeCandidate(root: string, base: string, changes: Map<string, string | null>, message: string, index: string) {
  const gitIndex = { env: { ...process.env, GIT_INDEX_FILE: index } };
  git(root, ['read-tree', base], gitIndex);
  for (const [path, content] of changes) {
    if (content === null) {
      if (!gitSucceeds(root, ['cat-file', '-e', `${base}:${path}`])) {
        throw new InputError(`Cannot delete a file absent from the Skill baseline: ${path}`);
      }
      git(root, ['update-index', '--force-remove', '--', path], gitIndex);
      continue;
    }
    const blob = gitText(root, ['hash-object', '-w', '--stdin'], { input: content.replace(/\r\n/g, '\n') });
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], gitIndex);
  }
  const tree = gitText(root, ['write-tree'], gitIndex);
  return gitText(root, ['commit-tree', tree, '-p', base, '-F', '-'], { input: message });
}

function baseContent(root: string, base: string, path: string) {
  return gitSucceeds(root, ['cat-file', '-e', `${base}:${path}`]) ? git(root, ['show', `${base}:${path}`]).toString('utf8') : undefined;
}

function sealReceipt(root: string, receipt: ReplayReceipt) {
  const content = JSON.stringify(receipt);
  const id = sha256(content);
  const path = receiptPath(root, id);
  mkdirSync(dirname(path), { recursive: true });
  git(root, ['update-ref', 'refs/evolve/replays/' + id, receipt.candidate]);
  if (!existsSync(path)) writeFileSync(path, content, { flag: 'wx' });
  else if (readFileSync(path, 'utf8') !== content) throw new InputError('Skill replay receipt differs');
  return { id, ...receipt };
}

/** 准备隔离的 baseline/candidate worktree 执行回放，并始终清理临时资源。 */
function withReplayTrees<T>(root: string, base: string, build: (index: string) => string,
  replay: (trees: { oldTree: string; newTree: string; candidate: string }) => T): T {
  const scratch = mkdtempSync(join(tmpdir(), 'evolve-replay-'));
  const index = join(scratch, 'index');
  const oldTree = join(scratch, 'baseline');
  const newTree = join(scratch, 'candidate');
  let oldAdded = false;
  let newAdded = false;
  let failure: unknown;
  try {
    const candidate = build(index);
    if (!gitText(root, ['diff', '--name-only', base, candidate])) throw new InputError('Skill draft has no changes');
    git(root, ['worktree', 'add', '--detach', oldTree, base]);
    oldAdded = true;
    git(root, ['worktree', 'add', '--detach', newTree, candidate]);
    newAdded = true;
    return replay({ oldTree, newTree, candidate });
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
  const changes = new Map(draft.changes.map(change => [repoPath(root, change.path), change.content]));
  // 每次进化自动递增 patch 版本，便于从 frontmatter 识别 Skill 版本。
  const entryContent = changes.get(entryPath) ?? baseline;
  const bumped = bumpVersion(entryContent, 'patch');
  if (bumped !== entryContent) changes.set(entryPath, bumped);
  const files = [...changes.keys()];
  const expectedReads = draft.operation === 'retire' ? []
    : draft.priority === 'high' ? [entryPath] : [`${packagePath}/${learningDocument(draft.id)}`];
  if (draft.operation !== 'retire' && draft.priority === 'low') expectedReads.push(`${packagePath}/${learningIndex}`);
  const message = candidateMessage(entryPath, draft.operation, draft.id, draft.sources);
  return withReplayTrees(root, base, index => writeCandidate(root, base, changes, message, index), ({ oldTree, newTree, candidate }) => {
    const observations = scenarios.map(scenario => {
      const payload = { id: scenario.id, input: scenario.input, entry: entryPath, commit: base };
      const baseline = observe(scenario, () => runOnce(oldTree, base, runner, payload, packagePath, entryPath, true));
      const proposed = observe(scenario, () => runOnce(newTree, candidate, runner, { ...payload, commit: candidate }, packagePath, entryPath, true));
      const missing = scenario.baseline ? [] : expectedReads.filter(path => !proposed.loaded.some(item => item.path === path));
      if (baseline.passed !== scenario.baseline || !proposed.passed || missing.length) {
        throw replayFailure('Skill replay failed', scenario, baseline, proposed, missing);
      }
      assertKnowledgeReads(proposed, scenario.knowledgeReads, scenario.id);
      return { id: scenario.id, inputSha256: sha256(JSON.stringify(scenario.input)), baseline, candidate: proposed };
    });
    if (sha256(readFileSync(runner)) !== runnerSha256) throw new InputError('Replay runner changed during validation');
    return sealReceipt(root, { base, candidate, entry: entryPath, files, sources: draft.sources, runnerSha256, scenarios: observations });
  });
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
  const previous = baseContent(root, base, entryPath);
  const entryExists = previous !== undefined;
  const files = new Map(changes.map(change => [change.path, change.content]));
  // 结构性重构在设计者未手动调整版本时递增 minor 版本。
  const entryContent = files.get(entryPath) as string;
  if (previous !== undefined && frontmatterVersion(previous) !== undefined && frontmatterVersion(previous) === frontmatterVersion(entryContent)) {
    files.set(entryPath, bumpVersion(entryContent, 'minor'));
  }
  const sources = Array.isArray(draft.sources) ? draft.sources.map(source => requireText(source, 'evidence reference')) : [];
  const draftId = sha256(JSON.stringify([...files])).slice(0, 20);
  const message = candidateMessage(entryPath, 'package', draftId, sources);
  return withReplayTrees(root, base, index => writeCandidate(root, base, files, message, index), ({ oldTree, newTree, candidate }) => {
    const observations = scenarios.map(scenario => {
      const payload = { id: scenario.id, input: scenario.input, entry: entryPath, package_path: packagePath, commit: base, mode: 'package' };
      const baseline = observe(scenario, () => runOnce(oldTree, base, runner, payload, packagePath, entryPath, entryExists));
      const proposed = observe(scenario, () => runOnce(newTree, candidate, runner, { ...payload, commit: candidate }, packagePath, entryPath, true));
      if (baseline.passed !== scenario.baseline || !proposed.passed) {
        throw replayFailure('Skill package replay failed', scenario, baseline, proposed);
      }
      assertKnowledgeReads(proposed, scenario.knowledgeReads, scenario.id);
      return { id: scenario.id, inputSha256: sha256(JSON.stringify(scenario.input)), baseline, candidate: proposed };
    });
    if (sha256(readFileSync(runner)) !== runnerSha256) throw new InputError('Replay runner changed during validation');
    return sealReceipt(root, {
      mode: 'package', base, candidate, entry: entryPath, package_path: packagePath,
      files: [...files.keys()], sources, runnerSha256, scenarios: observations,
    });
  });
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
  const diff = (from: string, to: string) => gitText(root, ['diff', '--name-only', from, to, '--', ...receipt.files]);
  if (rollback) {
    const applied = gitSucceeds(root, ['merge-base', '--is-ancestor', receipt.candidate, head]);
    if (!applied) throw new InputError('Skill candidate is not part of the current history');
    // 候选已在历史中且文件已回到 base 内容：视为已回滚。
    if (!diff(receipt.base, head)) return { id, commit: head, replayed: true };
    // 允许候选之后存在无关提交，但候选文件不得再被修改。
    if (diff(receipt.candidate, head)) throw new InputError('Skill files changed after the candidate; revert them manually');
  } else {
    if (head === receipt.candidate) return { id, commit: head, replayed: true };
    if (head !== receipt.base) throw new InputError('Project version changed since Skill replay');
  }
  const packagePath = receipt.package_path ?? dirname(receipt.entry).replaceAll('\\', '/');
  if (gitText(root, ['status', '--porcelain', '--untracked-files=all', '--', packagePath])) {
    throw new InputError('Skill package has local changes');
  }
  if (gitText(root, ['diff', '--cached', '--name-only'])) throw new InputError('The Git index contains staged changes');
  if (rollback) git(root, ['revert', '--no-edit', receipt.candidate]);
  else git(root, ['merge', '--ff-only', receipt.candidate]);
  return { id, commit: gitText(root, ['rev-parse', 'HEAD']), replayed: false };
}

function observeSkillCommit(root: string, commit: string, targets: readonly EvolutionTarget[], knowledgeSnapshot: string, verify: boolean, inputs?: unknown) {
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
      const scenarioBytes = inputs === undefined ? readFileSync(scenarioPath) : undefined;
      const scenarios = loadScenarios(scenarioBytes ? JSON.parse(scenarioBytes.toString('utf8')) : inputs);
      const packagePath = dirname(target.entry).replaceAll('\\', '/');
      const observations = scenarios.map(scenario => {
        const payload = { id: scenario.id, input: scenario.input, entry: target.entry, commit,
          ...(verify ? { package_path: packagePath, mode: 'package' } : {}) };
        const observed = observe(scenario, () => runOnce(worktree, commit, runner, payload, packagePath, target.entry, true));
        if (verify && !observed.passed) throw new InputError('Merged Skill validation failed: ' + scenario.id);
        if (observed.passed) assertKnowledgeReads(observed, scenario.knowledgeReads, scenario.id);
        return { id: scenario.id, input_sha256: sha256(JSON.stringify(scenario.input)), ...observed };
      });
      if (sha256(readFileSync(runner)) !== runner_sha256 || scenarioBytes && !readFileSync(scenarioPath).equals(scenarioBytes)) throw new InputError('Validation inputs changed');
      return { entry: target.entry, runner_sha256, scenarios_sha256: scenarioBytes && sha256(scenarioBytes), observations };
    });
    if (frozenKnowledgeHash(knowledgeSnapshot) !== knowledge_sha256) throw new InputError('OPENVIKING_FROZEN_KNOWLEDGE_CHANGED');
    return { commit, knowledge_sha256, targets: results };
  } finally {
    if (previousSnapshot === undefined) delete process.env.EVOLVE_KNOWLEDGE_SNAPSHOT; else process.env.EVOLVE_KNOWLEDGE_SNAPSHOT = previousSnapshot;
    if (previousDb === undefined) delete process.env.AGENT_MEMORY_DB; else process.env.AGENT_MEMORY_DB = previousDb;
    if (added) git(root, ['worktree', 'remove', '--force', worktree]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function probeSkillBaseline(root: string, commit: string, target: EvolutionTarget, knowledgeSnapshot: string, scenarios: unknown) {
  return observeSkillCommit(root, commit, [target], knowledgeSnapshot, false, scenarios).targets[0].observations;
}

export function verifySkillCommit(root: string, commit: string, targets: readonly EvolutionTarget[], knowledgeSnapshot: string) {
  const proof = observeSkillCommit(root, commit, targets, knowledgeSnapshot, true);
  const content = JSON.stringify(proof);
  const id = sha256(content);
  const path = join(gitText(root, ['rev-parse', '--absolute-git-dir']), 'evolve-validations', id + '.json');
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) { if (readFileSync(path, 'utf8') !== content) throw new InputError('Validation receipt changed'); }
  else writeFileSync(path, content, { flag: 'wx' });
  git(root, ['update-ref', 'refs/evolve/validations/' + id, commit]);
  return { id, ...proof };
}
