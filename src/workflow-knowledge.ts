import { posix } from 'node:path';
import { contentSha256 } from './knowledge-reads.js';
import { InputError, requireText } from './common.js';
import { isRepositoryId, isWikiCategory, type WikiContext } from './wiki-entry.js';
import type { Wiki } from './wiki.js';
import { workflowRecord, workflowStrings } from './workflow-skills.js';

export type WikiLookupScope = Pick<WikiContext, 'repository' | 'task' | 'paths' | 'categories'>;

export interface WikiPrior {
  id: string;
  title: string;
  mode: 'constraint' | 'reference';
  content: string;
  scope: string[];
  categories?: string[];
  repositories?: string[];
  sources: string[];
  lookup_scope: WikiLookupScope;
  source_search_id: string;
  content_sha256: string;
  storage_scope?: 'project' | 'global';
}

export function buildWikiPrior(
  page: NonNullable<ReturnType<Wiki['getEntry']>>,
  mode: WikiPrior['mode'],
  lookupScope: WikiLookupScope,
  searchId: string,
): WikiPrior {
  return {
    id: page.id, title: page.title, mode, content: page.body, sources: page.sources,
    scope: page.entry?.scope ?? [], categories: page.entry?.categories, repositories: page.entry?.repositories,
    lookup_scope: lookupScope, source_search_id: searchId, content_sha256: contentSha256(page.body),
  };
}

export function wikiLookupScope(value: unknown = {}): WikiLookupScope {
  const input = workflowRecord(value, 'Wiki lookup scope');
  const field = Object.keys(input).find(key => !['repository', 'task', 'paths', 'categories'].includes(key));
  if (field) throw new InputError('Unknown Wiki scope field: ' + field);
  const { repository, task, paths, categories } = input;
  if (repository !== undefined && !isRepositoryId(repository)) throw new InputError('Expected a persisted repository UUID');
  const normalizedPaths = paths === undefined ? [] : workflowStrings(paths, 'Wiki paths')
    .map(path => posix.normalize(path.replaceAll('\\', '/')));
  const normalizedCategories = categories === undefined ? [] : workflowStrings(categories, 'Wiki categories');
  if (!normalizedCategories.every(isWikiCategory)) throw new InputError('Unknown Wiki context category');
  return {
    ...(repository === undefined ? {} : { repository }),
    ...(task === undefined ? {} : { task: requireText(task, 'Wiki task') }),
    ...(normalizedPaths.length ? { paths: [...new Set(normalizedPaths)].sort() } : {}),
    ...(normalizedCategories.length ? { categories: [...new Set(normalizedCategories)].sort() } : {}),
  };
}
