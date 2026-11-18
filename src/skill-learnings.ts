import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { InputError } from './common.js';
import { learningIndex, listSkillLearnings, type SkillLearning } from './skill-addition.js';
import { readEvolveSessions, runOutcome } from './workflow-runtime.js';

/** learning 数量超过阈值时，应把它们整合进 Skill 正文而不是继续追加。 */
export const LEARNING_LIMITS = { inline: 3, total: 8 } as const;
/** 判定 retire / unused 所需的最少观测次数。 */
const MIN_EXPOSURES = 3;
const MIN_ELIGIBLE_RUNS = 5;

export interface LearningUsage extends SkillLearning {
  eligible_runs: number;
  exposures: number;
  clean: number;
  non_clean: number;
  last_exposed_at?: string;
  recommendation: 'keep' | 'retire_candidate' | 'unused';
}

/** 判断 learning 数量是否需要走 ew-skill-design 整合。 */
export function learningBloat(learnings: SkillLearning[]) {
  const inline = learnings.filter(item => item.placement === 'inline').length;
  const reasons: string[] = [];
  if (inline > LEARNING_LIMITS.inline) reasons.push(`inline learning ${inline} > ${LEARNING_LIMITS.inline}`);
  if (learnings.length > LEARNING_LIMITS.total) reasons.push(`learning total ${learnings.length} > ${LEARNING_LIMITS.total}`);
  return { inline, total: learnings.length, consolidate_recommended: reasons.length > 0, reasons };
}

function readOptional(path: string) {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() ? readFileSync(path, 'utf8') : undefined;
}

/** 读取当前 Skill 包中的 learning 清单。 */
export function readSkillLearnings(entry: string) {
  const path = resolve(entry);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) throw new InputError(`Skill entry not found: ${entry}`);
  return listSkillLearnings(readFileSync(path, 'utf8'), readOptional(join(dirname(path), learningIndex)));
}

/**
 * 基于已封存 Run 的 Skill 读取记录统计每条 learning 的暴露次数与结局。
 * 统计是相关性而非因果：仅用于提示 retire / consolidate 候选，不自动修改 Skill。
 */
export function skillLearningUsage(root: string, entry: string) {
  const top = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim());
  const entryPath = relative(top, realpathSync(resolve(root, entry))).replaceAll('\\', '/');
  if (!entryPath.endsWith('/SKILL.md') || entryPath.startsWith('..')) throw new InputError('Expected a project Skill package entry');
  const packagePath = dirname(entryPath);
  const learnings = readSkillLearnings(resolve(top, entryPath));
  const snapshots = new Map<string, string | undefined>();
  const show = (commit: string, path: string) => {
    const key = `${commit}:${path}`;
    if (!snapshots.has(key)) {
      try {
        snapshots.set(key, execFileSync('git', ['show', key], { cwd: top, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
      } catch {
        snapshots.set(key, undefined);
      }
    }
    return snapshots.get(key);
  };
  const runs = readEvolveSessions(top).flatMap(session => session.runs
    .filter(run => run.skill.package_path === packagePath)
    .map(run => ({ session, run, outcome: runOutcome(session, run) })))
    .filter(item => item.outcome !== 'pending');
  const usage: LearningUsage[] = learnings.map(learning => {
    const marker = `<!-- evolve:learning:${learning.id} -->`;
    let eligible = 0;
    let exposures = 0;
    let clean = 0;
    let nonClean = 0;
    let lastExposed: string | undefined;
    for (const { run, outcome } of runs) {
      const holder = learning.placement === 'indexed' ? learningIndex : run.skill.entry;
      if (!show(run.skill.commit, `${packagePath}/${holder}`)?.includes(marker)) continue;
      eligible += 1;
      const read = learning.placement === 'inline' ? run.skill.entry : learning.document!;
      if (!Object.hasOwn(run.reads, read)) continue;
      exposures += 1;
      if (outcome === 'clean') clean += 1;
      else nonClean += 1;
      if (run.finished_at && (!lastExposed || run.finished_at > lastExposed)) lastExposed = run.finished_at;
    }
    const recommendation = exposures >= MIN_EXPOSURES && nonClean > clean ? 'retire_candidate'
      : learning.placement !== 'inline' && eligible >= MIN_ELIGIBLE_RUNS && exposures === 0 ? 'unused' : 'keep';
    return {
      ...learning, eligible_runs: eligible, exposures, clean, non_clean: nonClean,
      ...(lastExposed ? { last_exposed_at: lastExposed } : {}), recommendation,
    };
  });
  return {
    schema_version: 'skill-learning-usage/1.0',
    entry: entryPath, package_path: packagePath, observed_runs: runs.length,
    ...learningBloat(learnings), learnings: usage,
  };
}
