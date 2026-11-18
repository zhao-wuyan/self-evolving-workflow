import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { InputError, requireText } from './common.js';

export type SkillPriority = 'high' | 'normal' | 'low';
export type SkillLearningPlacement = 'inline' | 'linked' | 'indexed';

/** Skill 文件变更；`content: null` 表示删除该文件。 */
export interface SkillFileChange {
  path: string;
  content: string | null;
}

export interface SkillLearning {
  id: string;
  placement: SkillLearningPlacement;
  document?: string;
}

export const learningIndex = 'references/learnings/index.md';
const blockEnd = '<!-- /evolve:learning -->';
const indexMarker = '<!-- evolve:learning:index -->';
const learningMarker = /<!-- evolve:learning:([a-f0-9]{20}) -->/g;

export function learningDocument(id: string) {
  return `references/learnings/${id}.md`;
}

function readOptionalDocument(path: string) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && !info.isFile()) throw new InputError(`Expected a regular Skill Markdown file: ${path}`);
  return info ? readFileSync(path, 'utf8') : undefined;
}

function readEntry(path: string) {
  const entry = resolve(path);
  if (!lstatSync(entry, { throwIfNoEntry: false })?.isFile()) throw new InputError('Expected a regular Skill Markdown file');
  return { entry, baseline: readFileSync(entry, 'utf8') };
}

function evidenceList(values: string[]) {
  const sources = [...new Set(values.map(source => requireText(source, 'evidence reference')))].sort();
  if (!sources.length) throw new InputError('At least one evidence reference is required');
  if (/[\r\n]/.test(sources.join(''))) throw new InputError('Evidence references must use one line');
  return sources;
}

function learningIds(values: string[] | undefined) {
  const ids = [...new Set((values ?? []).map(id => requireText(id, 'learning ID')))].sort();
  const invalid = ids.find(id => !/^[a-f0-9]{20}$/.test(id));
  if (invalid) throw new InputError(`Invalid Skill learning ID: ${invalid}`);
  return ids;
}

function hashId(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

function appendBlock(baseline: string, marker: string, block: string) {
  if (!baseline.includes(marker)) return `${baseline.trimEnd()}\n\n${block}\n`;
  if (!baseline.replace(/\r\n/g, '\n').includes(block)) {
    throw new InputError('Existing Skill learning block differs from this draft');
  }
  return baseline;
}

/** 删除一个 learning 块并收拢两侧空行；块不存在时返回 undefined。 */
function cutBlock(text: string, marker: string) {
  const start = text.indexOf(marker);
  if (start < 0) return undefined;
  const close = text.indexOf(blockEnd, start + marker.length);
  if (close < 0) throw new InputError(`Unterminated Skill learning block: ${marker}`);
  const left = text.slice(0, start).replace(/(?:\r?\n)+$/, '');
  const right = text.slice(close + blockEnd.length).replace(/^(?:\r?\n)+/, '');
  if (!left) return right;
  return right ? `${left}\n\n${right}` : `${left}\n`;
}

/** 列出 Skill 入口与可选索引中现存的 learning。 */
export function listSkillLearnings(entryText: string, indexText?: string): SkillLearning[] {
  const learnings: SkillLearning[] = [];
  for (const match of entryText.matchAll(learningMarker)) {
    const id = match[1];
    const close = entryText.indexOf(blockEnd, match.index);
    const body = close < 0 ? '' : entryText.slice(match.index, close);
    learnings.push(body.includes(`](${learningDocument(id)})`)
      ? { id, placement: 'linked', document: learningDocument(id) }
      : { id, placement: 'inline' });
  }
  for (const match of (indexText ?? '').matchAll(learningMarker)) {
    learnings.push({ id: match[1], placement: 'indexed', document: learningDocument(match[1]) });
  }
  return learnings;
}

/** 在内存中移除指定 learning，返回新的入口、索引（null 表示删除）与需删除的文档。 */
function removeLearnings(packageRoot: string, entryText: string, indexText: string | undefined, ids: string[]) {
  let entry = entryText;
  let index: string | null | undefined = indexText;
  const deleted: string[] = [];
  const known = new Map(listSkillLearnings(entryText, indexText).map(item => [item.id, item]));
  for (const id of ids) {
    const learning = known.get(id);
    if (!learning) throw new InputError(`Unknown Skill learning: ${id}`);
    const marker = `<!-- evolve:learning:${id} -->`;
    if (learning.placement === 'indexed') index = cutBlock(index as string, marker);
    else entry = cutBlock(entry, marker)!;
    if (learning.document && readOptionalDocument(resolve(packageRoot, learning.document)) !== undefined) {
      deleted.push(resolve(packageRoot, learning.document));
    }
  }
  if (typeof index === 'string' && index !== indexText && !listSkillLearnings('', index).length) {
    index = null;
    entry = cutBlock(entry, indexMarker) ?? entry;
  }
  return { entry, index, deleted };
}

export function draftSkillAddition(input: {
  entry: string;
  priority: SkillPriority;
  instruction: string;
  sources: string[];
  when?: string;
  supersedes?: string[];
}) {
  const { entry, baseline } = readEntry(input.entry);
  const instruction = requireText(input.instruction, 'Skill instruction');
  const when = input.when === undefined ? undefined : requireText(input.when, 'learning trigger');
  const sources = evidenceList(input.sources);
  const supersedes = learningIds(input.supersedes);
  if (/<!--\s*\/?evolve:learning\b/.test(instruction)) {
    throw new InputError('Evidence references must use one line and instructions must omit learning markers');
  }
  if (when && (/[\r\n]/.test(when) || /<!--/.test(when))) throw new InputError('A learning trigger must use one line');
  if (input.priority === 'high' && (/[\r\n]/.test(instruction) || [...instruction].length > 280)) {
    throw new InputError('A high-priority inline addition must be one instruction under 281 characters');
  }
  // 无 supersedes 时保持旧 ID 计算方式，兼容既有草稿与回执。
  const id = hashId([input.priority, instruction, sources, when, ...(supersedes.length ? [supersedes] : [])]);
  if (supersedes.includes(id)) throw new InputError('A learning cannot supersede itself');
  const start = `<!-- evolve:learning:${id} -->`;
  const relative = learningDocument(id);
  const details = `# Skill learning\n\n${when ? `When: ${when}\n\n` : ''}${instruction}\n\n## Evidence\n\n${sources.map(source => `- ${source}`).join('\n')}\n`;
  const packageRoot = dirname(entry);
  const indexPath = resolve(packageRoot, learningIndex);
  const indexDisk = readOptionalDocument(indexPath);
  const removal = supersedes.length
    ? removeLearnings(packageRoot, baseline, indexDisk, supersedes)
    : { entry: baseline, index: indexDisk, deleted: [] as string[] };
  const working = removal.entry;
  const changes: SkillFileChange[] = [];
  if (input.priority !== 'high') {
    for (const directory of ['references', 'references/learnings']) {
      const info = lstatSync(resolve(packageRoot, directory), { throwIfNoEntry: false });
      if (info && !info.isDirectory()) throw new InputError(`Expected a regular Skill reference directory: ${directory}`);
    }
    const path = resolve(packageRoot, relative);
    const existing = readOptionalDocument(path);
    if (existing !== undefined && existing.replace(/\r\n/g, '\n') !== details) {
      throw new InputError(`Existing Skill learning document differs from this draft: ${relative}`);
    }
    changes.push({ path, content: details });
  }
  if (input.priority === 'low') {
    const index = removal.index ?? '# Optional Skill references\n';
    const title = [...(when ?? instruction).split(/\r?\n/, 1)[0]].slice(0, 100).join('').replace(/[&<>()[\]\\`*_]/g, '\\$&');
    const indexContent = appendBlock(index, start, `${start}\n- [${title}](./${id}.md)\n${blockEnd}`);
    const entryContent = appendBlock(working, indexMarker,
      `${indexMarker}\n[Optional Skill references](${learningIndex}) for tasks that explicitly need additional examples or troubleshooting.\n${blockEnd}`);
    if (indexContent !== indexDisk) changes.push({ path: indexPath, content: indexContent });
    if (entryContent !== baseline) changes.unshift({ path: entry, content: entryContent });
  } else {
    const body = input.priority === 'high' ? instruction
      : `[Read the workflow learning](${relative}) when ${when ?? 'the documented conditions apply'}.`;
    const addition = `${start}\n${body}\n${blockEnd}`;
    let content = appendBlock(working, start, addition);
    if (input.priority === 'high' && content !== working) {
      const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(working)?.[0] ?? '';
      content = `${frontmatter}\n${addition}\n\n${working.slice(frontmatter.length)}`;
    }
    changes.unshift({ path: entry, content });
    if (removal.index !== indexDisk) {
      changes.push({ path: indexPath, content: removal.index ?? null });
    }
  }
  for (const path of removal.deleted) changes.push({ path, content: null });
  return {
    id, operation: supersedes.length ? 'supersede' as const : 'add' as const,
    priority: input.priority, sources, instruction, ...(when ? { when } : {}),
    ...(supersedes.length ? { supersedes } : {}),
    baseline: { path: entry, sha256: createHash('sha256').update(baseline).digest('hex') },
    changes,
  };
}

/** 退役已有 learning：移除入口块、索引条目与对应文档，不新增内容。 */
export function draftSkillRetirement(input: { entry: string; retire: string[]; sources: string[]; reason?: string }) {
  const { entry, baseline } = readEntry(input.entry);
  const sources = evidenceList(input.sources);
  const retire = learningIds(input.retire);
  if (!retire.length) throw new InputError('Provide at least one learning ID to retire');
  const reason = input.reason === undefined ? undefined : requireText(input.reason, 'retirement reason');
  if (reason && /[\r\n]/.test(reason)) throw new InputError('A retirement reason must use one line');
  const packageRoot = dirname(entry);
  const indexPath = resolve(packageRoot, learningIndex);
  const indexDisk = readOptionalDocument(indexPath);
  const removal = removeLearnings(packageRoot, baseline, indexDisk, retire);
  const changes: SkillFileChange[] = [];
  if (removal.entry !== baseline) changes.push({ path: entry, content: removal.entry });
  if (removal.index !== indexDisk) changes.push({ path: indexPath, content: removal.index ?? null });
  for (const path of removal.deleted) changes.push({ path, content: null });
  return {
    id: hashId(['retire', retire, sources, reason ?? null]), operation: 'retire' as const,
    retire, sources, ...(reason ? { reason } : {}),
    baseline: { path: entry, sha256: createHash('sha256').update(baseline).digest('hex') },
    changes,
  };
}

export type SkillAddition = ReturnType<typeof draftSkillAddition>;
export type SkillRetirement = ReturnType<typeof draftSkillRetirement>;
