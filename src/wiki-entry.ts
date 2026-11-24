import { posix } from 'node:path';
import { InputError } from './common.js';
import type { PageFrontmatter } from './upstream/frontmatter.js';

export const wikiCategories = ['coding', 'arch', 'debug', 'test', 'review', 'learning', 'ui'] as const;
export type WikiCategory = typeof wikiCategories[number];
const repositoryIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const wikiConfidenceLevels = ['high', 'medium', 'low', 'contested'] as const;
export type WikiConfidence = typeof wikiConfidenceLevels[number];

export interface WikiEntryMetadata {
  mode: 'constraint' | 'reference';
  status: 'active' | 'deprecated' | 'needs_review';
  scope: string[];
  aliases: string[];
  categories?: WikiCategory[];
  repositories?: string[];
  keywords?: string[];
  confidence?: WikiConfidence;
  conflictsWith?: string[];
}

export interface WikiContext {
  task?: string;
  paths?: string[];
  categories?: WikiCategory[];
  repository?: string;
  keyword?: string;
  includePathScoped?: boolean;
}

function stringList(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new InputError(`Wiki entry ${path} requires a list of strings in ${field}`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

export function isWikiCategory(value: unknown): value is WikiCategory {
  return wikiCategories.some(category => category === value);
}

export function isRepositoryId(value: unknown): value is string {
  return typeof value === 'string' && repositoryIdPattern.test(value);
}

export function readWikiEntryMetadata(path: string, frontmatter: PageFrontmatter, body: string): WikiEntryMetadata | undefined {
  if (!path.startsWith('wiki/entries/')) return undefined;
  if (!/^wiki\/entries\/[a-z0-9][a-z0-9_-]*\.md$/.test(path)) {
    throw new InputError(`Invalid stable Wiki entry path: ${path}`);
  }
  const { title, mode, status } = frontmatter;
  if (typeof title !== 'string' || !title.trim()) throw new InputError(`Wiki entry ${path} needs a title`);
  if (mode !== 'reference' && mode !== 'constraint') throw new InputError(`Invalid Wiki entry mode: ${path}`);
  if (status !== 'active' && status !== 'deprecated' && status !== 'needs_review') {
    throw new InputError(`Invalid Wiki entry status: ${path}`);
  }
  const scope = stringList(frontmatter.scope, 'scope', path);
  if (!scope.length || scope.some(item => item !== 'project' && !/^(?:skill|task|path):\S/.test(item))) {
    throw new InputError(`Invalid Wiki entry scope: ${path}`);
  }
  const sources = stringList(frontmatter.sources, 'sources', path);
  if (!sources.length) {
    throw new InputError(`Wiki entry ${path} needs at least one source`);
  }
  const aliases = frontmatter.aliases === undefined ? [] : stringList(frontmatter.aliases, 'aliases', path);
  const categories = frontmatter.categories === undefined ? undefined : stringList(frontmatter.categories, 'categories', path);
  if (categories && !categories.every(isWikiCategory)) throw new InputError(`Invalid Wiki entry category: ${path}`);
  const repositories = frontmatter.repositories === undefined ? undefined : stringList(frontmatter.repositories, 'repositories', path);
  if (repositories && !repositories.every(isRepositoryId)) throw new InputError(`Invalid Wiki repository ID: ${path}`);
  const legacy = frontmatter.legacy as { keywords?: unknown; sid?: unknown } | undefined;
  // 旧导入保存了结构化条目的属性和行号，按原格式补读关键词。
  const structuredLegacy = sources.some(source => /^legacy:[^:]+:\.workflow\/specs\/[^#]+#L\d+$/.test(source)) &&
    (typeof legacy?.sid === 'string' || typeof legacy?.keywords === 'string' ||
      !/^\s*###\s+(?:\[[\w-]+\]\s+)?\[\d{4}-\d{2}-\d{2}/.test(body));
  const keywords = frontmatter.keywords === undefined
    ? structuredLegacy ? splitLegacyKeywords(legacy?.keywords) : undefined
    : stringList(frontmatter.keywords, 'keywords', path).map(keyword => keyword.toLowerCase());
  const rawConfidence = frontmatter.confidence;
  let confidence: WikiConfidence | undefined;
  if (rawConfidence !== undefined) {
    if (typeof rawConfidence !== 'string' || !wikiConfidenceLevels.includes(rawConfidence as WikiConfidence)) {
      throw new InputError(`Invalid Wiki entry confidence: ${path}`);
    }
    confidence = rawConfidence as WikiConfidence;
  }
  const conflictsWith = frontmatter.conflicts_with === undefined
    ? undefined
    : stringList(frontmatter.conflicts_with, 'conflicts_with', path);
  return { mode, status, scope, aliases, ...(categories ? { categories } : {}), ...(repositories ? { repositories } : {}),
    ...(keywords ? { keywords: [...new Set(keywords)] } : {}),
    ...(confidence ? { confidence } : {}),
    ...(conflictsWith?.length ? { conflictsWith } : {}),
  };
}

export function splitLegacyKeywords(value: unknown): string[] {
  return typeof value === 'string' ? value.split(',').map(keyword => keyword.trim().toLowerCase()).filter(Boolean) : [];
}

export function appliesToContext(entry: WikiEntryMetadata, context: WikiContext, body: string): boolean {
  if (entry.repositories && (!context.repository || !entry.repositories.includes(context.repository))) return false;
  const categories = context.categories;
  const keyword = context.keyword?.toLowerCase();
  const exact = keyword && entry.keywords?.includes(keyword);
  if (keyword && !(entry.keywords ? exact : body.toLowerCase().includes(keyword))) return false;
  if (entry.categories && categories?.length && !exact && !entry.categories.some(category => categories.includes(category))) return false;
  return entry.scope.some(scope => {
    if (scope === 'project') return true;
    if (scope.startsWith('task:')) return scope.slice(5) === context.task;
    return scope.startsWith('path:') && (context.includePathScoped ||
      (context.paths ?? []).some(path => posix.matchesGlob(path.replaceAll('\\', '/'), scope.slice(5))));
  });
}

export function contextSpecificity(entry: WikiEntryMetadata, context: WikiContext): number {
  let score = 0;
  if (context.task && entry.scope.includes(`task:${context.task}`)) score += 6;
  if (context.paths?.length && entry.scope.some(scope => scope.startsWith('path:') &&
      context.paths!.some(path => posix.matchesGlob(path.replaceAll('\\', '/'), scope.slice(5))))) score += 4;
  if (context.categories?.length && entry.categories?.some(category => context.categories!.includes(category))) score += 2;
  if (context.repository && entry.repositories?.includes(context.repository)) score += 2;
  if (context.keyword && entry.keywords?.includes(context.keyword.toLowerCase())) score += 1;
  return score;
}
